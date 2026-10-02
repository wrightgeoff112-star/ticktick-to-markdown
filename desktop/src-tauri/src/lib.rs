use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn api_error_message(status: u16, body: &str) -> String {
    let quota = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("errorCode").and_then(|c| c.as_str()).map(str::to_owned))
        .is_some_and(|code| code == "export_too_many_times");
    if quota {
        "官方备份触发频率限制（export_too_many_times）；将尝试任务与附件备份".into()
    } else {
        format!("官方接口返回 HTTP {status}")
    }
}

fn diagnostic(app: &tauri::AppHandle, event: &str) {
    #[cfg(debug_assertions)]
    {
        let Ok(directory) = app.path().app_data_dir() else {
            return;
        };
        if std::fs::create_dir_all(&directory).is_err() {
            return;
        }
        let path = directory.join("native-debug.log");
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        else {
            return;
        };
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = writeln!(file, "{timestamp} {event}");
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, event);
    }
}
struct ExportState {
    device_id: String,
    host: Mutex<Option<String>>,
    temp: Mutex<Option<tempfile::TempDir>>,
    handles: Mutex<HashMap<String, PathBuf>>,
    cancellation: Mutex<Arc<CancelToken>>,
    destination: Mutex<Option<PathBuf>>,
    saved_path: Mutex<Option<PathBuf>>,
}
impl Default for ExportState {
    fn default() -> Self {
        Self {
            device_id: uuid::Uuid::new_v4().simple().to_string(),
            host: Mutex::new(None),
            temp: Mutex::new(None),
            handles: Mutex::new(HashMap::new()),
            cancellation: Mutex::new(Arc::new(CancelToken::default())),
            destination: Mutex::new(None),
            saved_path: Mutex::new(None),
        }
    }
}
fn trusted(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法验证窗口")?;
    if window.label() != "main"
        || !((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || ((url.scheme() == "http" || url.scheme() == "https")
                && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                && url.port() == Some(1420)))
    {
        return Err("该窗口没有本地文件或认证权限".into());
    }
    Ok(())
}
fn host(state: &ExportState) -> Result<String, String> {
    state
        .host
        .lock()
        .unwrap()
        .clone()
        .ok_or("请先打开官方登录页".into())
}
struct CancelToken {
    cancelled: AtomicBool,
    signal: tokio::sync::watch::Sender<bool>,
}
impl Default for CancelToken {
    fn default() -> Self {
        let (signal, _) = tokio::sync::watch::channel(false);
        Self {
            cancelled: AtomicBool::new(false),
            signal,
        }
    }
}
impl CancelToken {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.signal.send_replace(true);
    }
    async fn wait(&self) {
        let mut receiver = self.signal.subscribe();
        let _ = receiver.wait_for(|value| *value).await;
    }
}
fn token(state: &ExportState) -> Arc<CancelToken> {
    state.cancellation.lock().unwrap().clone()
}
fn active(token: &CancelToken) -> Result<(), String> {
    if token.cancelled.load(Ordering::SeqCst) {
        Err("导出已取消".into())
    } else {
        Ok(())
    }
}
fn cookie_matches(
    domain: Option<&str>,
    path: Option<&str>,
    secure: bool,
    expired: bool,
    url: &reqwest::Url,
) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    // Unknown origin cannot safely be sent.
    let Some(domain) = domain else { return false };
    // cookie 0.18 domain() strips the leading dot; Wry exposes no host-only flag.
    // This bridge only accepts the official root/API pair, never arbitrary parent domains.
    let root = match host {
        "api.dida365.com" => "dida365.com",
        "api.ticktick.com" => "ticktick.com",
        _ => return false,
    };
    let cookie_domain = domain.trim_start_matches('.');
    let domain_matches =
        cookie_domain.eq_ignore_ascii_case(host) || cookie_domain.eq_ignore_ascii_case(root);
    let path = path.filter(|p| p.starts_with('/')).unwrap_or("/");
    let request_path = url.path();
    let path_matches = request_path == path
        || (request_path.starts_with(path)
            && (path.ends_with('/') || request_path.as_bytes().get(path.len()) == Some(&b'/')));
    domain_matches && path_matches && (!secure || url.scheme() == "https") && !expired
}
fn invalid_download(size: u64, expected: Option<u64>, head: &[u8]) -> Option<&'static str> {
    if size == 0 {
        return Some("附件为空");
    }
    if let Some(expected) = expected {
        return (expected != size).then_some("附件大小与官方记录不符，可能下载不完整");
    }
    let preview = String::from_utf8_lossy(head).to_ascii_lowercase();
    if preview.contains("<form")
        && preview.contains("password")
        && (preview.contains("signin") || preview.contains("登录"))
    {
        return Some("附件接口返回官方登录页面，请重新登录");
    }
    None
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn api_path(path: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(&format!("https://api.dida365.com{path}")) else {
        return false;
    };
    if !path.starts_with("/api/")
        || path.contains('\\')
        || path.contains('#')
        || path.contains("..")
    {
        return false;
    }
    let p = url.path().trim_end_matches('/');
    let fixed = [
        "/api/v2/data/export/auto",
        "/api/v2/data/export",
        "/api/v2/batch/check/0",
        "/api/v2/project",
    ];
    let pieces: Vec<_> = p.split('/').collect();
    let allowed = fixed.contains(&p)
        || (pieces.len() == 6
            && pieces[..4] == ["", "api", "v2", "project"]
            && id(pieces[4])
            && (matches!(pieces[5], "completed" | "tasks")
                || (pieces[4] == "all" && pieces[5] == "closed")))
        || (pieces.len() == 5 && pieces[..4] == ["", "api", "v2", "task"] && id(pieces[4]));
    allowed
        && url.query_pairs().all(|(k, v)| match k.as_ref() {
            "projectId" => id(&v),
            "from" | "to" => v.len() <= 32,
            "status" => v == "Abandoned" && p.ends_with("/closed"),
            "limit" => v.parse::<u32>().is_ok_and(|n| n <= 1000),
            _ => false,
        })
}
#[tauri::command]
async fn open_login(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, ExportState>,
    host: String,
) -> Result<(), String> {
    trusted(&window)?;
    let domain = match host.as_str() {
        "dida365" | "dida365.com" => "dida365.com",
        "ticktick" | "ticktick.com" => "ticktick.com",
        _ => return Err("不支持的站点".into()),
    };
    if let Some(old) = app.get_webview_window("login") {
        old.close().map_err(|_| "无法关闭登录窗口")?;
    }
    *state.host.lock().unwrap() = Some(domain.into());
    let domain_owned = domain.to_string();
    WebviewWindowBuilder::new(
        &app,
        "login",
        WebviewUrl::External(format!("https://{domain}/signin").parse().unwrap()),
    )
    .title("在官方页面登录；完成后回到导出助手")
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_download(|_, _| false)
    .inner_size(1000., 760.)
    .on_navigation(move |url| {
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|h| h == domain_owned || h.ends_with(&format!(".{domain_owned}")))
    })
    .build()
    .map_err(|_| "无法打开官方登录窗口")?;
    Ok(())
}
async fn request(
    app: &tauri::AppHandle,
    state: &ExportState,
    path: &str,
    cancellation: &CancelToken,
) -> Result<reqwest::Response, String> {
    active(cancellation)?;
    let domain = host(state)?;
    let login = app
        .get_webview_window("login")
        .ok_or("请重新打开官方登录页")?;
    let request_url =
        reqwest::Url::parse(&format!("https://api.{domain}{path}")).map_err(|_| "站点地址无效")?;
    // Wry/macOS cookies_for_url currently compares domain equality and drops parent-domain cookies.
    // Read this login WebView's own jar, then apply request-domain/path/secure/expiry rules ourselves.
    diagnostic(
        app,
        &format!("request path={} stage=reading_cookies", request_url.path()),
    );
    let cookies_future = tauri::async_runtime::spawn_blocking(move || login.cookies());
    let cookies = tokio::select! {
        biased;
        _ = cancellation.wait() => return Err("导出已取消".into()),
        result = cookies_future => result.map_err(|_| { diagnostic(app, "error=cookie_worker"); "读取登录会话失败" })?.map_err(|_| { diagnostic(app, "error=cookie_runtime"); "读取登录会话失败" })?,
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let total = cookies.len();
    let root_domain_count = cookies
        .iter()
        .filter(|cookie| cookie.domain() == Some(domain.as_str()))
        .count();
    let cookies: Vec<_> = cookies
        .into_iter()
        .filter(|c| {
            cookie_matches(
                c.domain(),
                c.path(),
                c.secure().unwrap_or(false),
                c.expires_datetime()
                    .is_some_and(|e| e.unix_timestamp() <= now),
                &request_url,
            )
        })
        .collect();
    diagnostic(
        app,
        &format!(
            "cookies total={total} matched={} root_domain_count={root_domain_count}",
            cookies.len()
        ),
    );
    if cookies.is_empty() {
        diagnostic(app, "error=cookie_empty");
        return Err("尚未登录；请在官方页面完成登录或验证".into());
    }
    let cookie = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "网络初始化失败")?;
    let mut req=client.get(format!("https://api.{domain}{path}")).header("Cookie",cookie).header("Referer",format!("https://{domain}/")).header("Hl",if domain=="dida365.com" {"zh_CN"} else {"en_US"}).header("X-Tz","Asia/Shanghai").header("Traceid",uuid::Uuid::new_v4().simple().to_string()).header("X-Requested-With","XMLHttpRequest").header("X-Device",serde_json::json!({"platform":"web","os":if cfg!(target_os="windows") {"Win32"} else {"MacIntel"},"device":"ticktick-export","name":"ticktick-export","version":1,"id":state.device_id,"channel":"website","campaign":"","websocket":""}).to_string());
    if let Some(csrf) = cookies.iter().find(|c| c.name() == "_csrf_token") {
        req = req.header("X-Csrftoken", csrf.value());
    }
    let response = tokio::select! {
        biased;
        _ = cancellation.wait() => return Err("导出已取消".into()),
        result = req.send() => result.map_err(|error| if error.is_timeout() { diagnostic(app, "error=network_timeout"); "官方接口超时，请重试" } else if error.is_connect() { diagnostic(app, "error=network_connect"); "无法连接官方接口，请检查网络或代理" } else { diagnostic(app, "error=network_other"); "网络请求失败，请重试" })?,
    };
    diagnostic(
        app,
        &format!(
            "response path={} http_status={}",
            request_url.path(),
            response.status().as_u16()
        ),
    );
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(format!(
            "官方接口 HTTP {}：登录失效或需要验证；请回官方页面完成登录",
            response.status().as_u16()
        ));
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = tokio::select! {
            biased;
            _ = cancellation.wait() => return Err("导出已取消".into()),
            result = response.chunk() => result.ok().flatten(),
        } {
            if body.len() + chunk.len() > 8192 { break; }
            body.extend_from_slice(&chunk);
        }
        return Err(api_error_message(status, &String::from_utf8_lossy(&body)));
    }
    Ok(response)
}
#[tauri::command]
async fn api_json(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, ExportState>,
    path: String,
) -> Result<String, String> {
    trusted(&window)?;
    if !api_path(&path) {
        return Err("不允许的接口路径".into());
    }
    let cancellation = token(&state);
    let mut response = request(&app, &state, &path, &cancellation).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = tokio::select! { biased; _ = cancellation.wait() => return Err("导出已取消".into()), result = response.chunk() => result.map_err(|_| "读取接口失败")? }
    {
        active(&cancellation)?;
        if bytes.len() + chunk.len() > 128 * 1024 * 1024 {
            return Err("备份超过当前大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = String::from_utf8(bytes).map_err(|_| "接口返回不是 UTF-8")?;
    serde_json::from_str::<serde_json::Value>(&value).map_err(|_| {
        diagnostic(&app, "error=response_non_json");
        "官方接口返回非 JSON，可能需要重新登录"
    })?;
    active(&cancellation)?;
    diagnostic(&app, "api_json stage=complete");
    Ok(value)
}
#[tauri::command]
fn begin_export(window: WebviewWindow, state: State<'_, ExportState>) -> Result<(), String> {
    trusted(&window)?;
    let mut cancellation = state.cancellation.lock().unwrap();
    cancellation.cancel();
    *cancellation = Arc::new(CancelToken::default());
    let mut temp = state.temp.lock().unwrap();
    if temp.is_none() {
        *temp = Some(tempfile::tempdir().map_err(|_| "无法创建临时目录")?);
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    disk_handle: String,
    r#type: String,
    size: u64,
}
#[tauri::command]
async fn download_attachment(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, ExportState>,
    project_id: String,
    task_id: String,
    attachment_id: String,
    expected_size: Option<u64>,
) -> Result<Download, String> {
    trusted(&window)?;
    if ![&project_id, &task_id, &attachment_id]
        .iter()
        .all(|s| id(s))
    {
        return Err("附件标识无效".into());
    }
    let handle = uuid::Uuid::new_v4().to_string();
    let path = state
        .temp
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("请先开始导出")?
        .path()
        .join(&handle);
    let cancellation = token(&state);
    let mut response = request(
        &app,
        &state,
        &format!("/api/v1/attachment/{project_id}/{task_id}/{attachment_id}?action=download"),
        &cancellation,
    )
    .await?;
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|_| "无法写入临时附件")?;
    let mut head = Vec::new();
    let mut size = 0u64;
    let result: Result<(), String> = async {
        while let Some(chunk) = tokio::select! { biased; _ = cancellation.wait() => return Err("导出已取消".into()), result = response.chunk() => result.map_err(|_| "附件传输中断")? } {
            active(&cancellation)?;
            size += chunk.len() as u64;
            if size > 2 * 1024 * 1024 * 1024 {
                return Err("单附件超过 2GB 限制".into());
            }
            if head.len() < 8192 {
                head.extend_from_slice(&chunk[..chunk.len().min(8192 - head.len())]);
            }
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(|_| "磁盘写入失败")?;
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    active(&cancellation)?;
    if let Some(error) = invalid_download(size, expected_size, &head) {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error.into());
    }
    let kind = infer::get(&head)
        .map(|v| v.mime_type())
        .unwrap_or("application/octet-stream")
        .to_string();
    state.handles.lock().unwrap().insert(handle.clone(), path);
    Ok(Download {
        disk_handle: handle,
        r#type: kind,
        size,
    })
}
#[derive(Deserialize)]
struct TextFile {
    path: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentFile {
    path: String,
    disk_handle: String,
}
fn zip_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 1024
        && !path.chars().any(|c| c.is_control())
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path
            .split('/')
            .any(|p| p == ".." || p == "." || p.is_empty())
}
fn consume_destination(
    selected: &Mutex<Option<PathBuf>>,
    requested: &str,
) -> Result<PathBuf, String> {
    let mut selected = selected.lock().unwrap();
    if selected
        .as_ref()
        .is_some_and(|p| p == &PathBuf::from(requested))
    {
        Ok(selected.take().unwrap())
    } else {
        Err("请重新选择保存位置".into())
    }
}
fn backup_name(suggested: Option<String>) -> String {
    suggested
        .filter(|s| zip_path(s) && !s.contains('/'))
        .unwrap_or("滴答备份.zip".into())
}
#[tauri::command]
async fn choose_save_location(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, ExportState>,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    trusted(&window)?;
    let previous = state
        .destination
        .lock()
        .unwrap()
        .clone()
        .or_else(|| state.saved_path.lock().unwrap().clone());
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("选择备份保存位置")
        .add_filter("ZIP 备份", &["zip"])
        .set_file_name(backup_name(suggested_name));
    if let Some(directory) = previous
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .or_else(|| app.path().download_dir().ok())
    {
        dialog = dialog.set_directory(directory);
    }
    let Some(file) = dialog.save_file().await else {
        return Ok(None);
    };
    let target = file.path().to_path_buf();
    let displayed = target.to_string_lossy().to_string();
    *state.destination.lock().unwrap() = Some(target);
    Ok(Some(displayed))
}
#[tauri::command]
async fn save_zip(
    window: WebviewWindow,
    state: State<'_, ExportState>,
    files: Vec<TextFile>,
    attachments: Vec<AttachmentFile>,
    suggested_name: Option<String>,
    destination: Option<String>,
) -> Result<Option<String>, String> {
    trusted(&window)?;
    let cancellation = token(&state);
    active(&cancellation)?;
    let mut paths = HashSet::new();
    let handles = state.handles.lock().unwrap().clone();
    for path in files
        .iter()
        .map(|f| &f.path)
        .chain(attachments.iter().map(|f| &f.path))
    {
        if !zip_path(path) || !paths.insert(path.clone()) {
            return Err("ZIP 路径无效或重复".into());
        }
    }
    let disk_files = attachments
        .into_iter()
        .map(|a| {
            handles
                .get(&a.disk_handle)
                .cloned()
                .map(|p| (a.path, p))
                .ok_or("附件句柄已失效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let target = if let Some(requested) = destination {
        consume_destination(&state.destination, &requested)?
    } else {
        let Some(file) = rfd::AsyncFileDialog::new()
            .add_filter("ZIP 备份", &["zip"])
            .set_file_name(backup_name(suggested_name))
            .save_file()
            .await
        else {
            return Ok(None);
        };
        file.path().to_path_buf()
    };
    let displayed = target.to_string_lossy().to_string();
    let saved_target = target.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        write_archive(&target, files, disk_files, &cancellation.cancelled)?;
        Ok(Some(displayed))
    })
    .await
    .map_err(|_| "ZIP 保存任务失败".to_string())??;
    *state.saved_path.lock().unwrap() = Some(saved_target);
    Ok(result)
}
#[tauri::command]
fn saved_file_size(window: WebviewWindow, state: State<'_, ExportState>) -> Result<u64, String> {
    trusted(&window)?;
    let path = state
        .saved_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("尚未保存备份")?;
    Ok(std::fs::metadata(path)
        .map_err(|_| "备份文件不存在或无法读取")?
        .len())
}
#[tauri::command]
fn reveal_export(window: WebviewWindow, state: State<'_, ExportState>) -> Result<(), String> {
    trusted(&window)?;
    let path = state
        .saved_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("尚未保存备份")?;
    if !path.is_file() {
        return Err("备份文件已移动或删除".into());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn();
    #[cfg(target_os = "windows")]
    let result = {
        let mut argument = std::ffi::OsString::from("/select,");
        argument.push(&path);
        std::process::Command::new("explorer.exe")
            .arg(argument)
            .spawn()
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open")
        .arg(path.parent().ok_or("文件夹不存在")?)
        .spawn();
    result.map_err(|_| "无法打开文件夹，请按上方路径查找备份")?;
    Ok(())
}
fn write_archive(
    target: &std::path::Path,
    files: Vec<TextFile>,
    disk_files: Vec<(String, PathBuf)>,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    // Stream into an adjacent temporary file; only replace the selected destination once complete.
    let mut temporary = tempfile::NamedTempFile::new_in(target.parent().ok_or("保存目录无效")?)
        .map_err(|_| "无法创建保存文件")?;
    let mut zip = zip::ZipWriter::new(temporary.as_file_mut());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for f in files {
        if cancelled.load(Ordering::Relaxed) {
            return Err("导出已取消".into());
        }
        zip.start_file(f.path, options)
            .map_err(|_| "ZIP 写入失败")?;
        zip.write_all(f.content.as_bytes())
            .map_err(|_| "磁盘写入失败")?;
    }
    let mut buffer = vec![0u8; 128 * 1024];
    for (name, path) in disk_files {
        zip.start_file(name, options).map_err(|_| "ZIP 写入失败")?;
        let mut input = std::fs::File::open(path).map_err(|_| "临时附件不存在")?;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("导出已取消".into());
            }
            let n = input.read(&mut buffer).map_err(|_| "附件读取失败")?;
            if n == 0 {
                break;
            }
            zip.write_all(&buffer[..n]).map_err(|_| "磁盘写入失败")?;
        }
    }
    zip.finish().map_err(|_| "ZIP 完成失败")?;
    temporary.as_file().sync_all().map_err(|_| "保存同步失败")?;
    if cancelled.load(Ordering::Relaxed) {
        return Err("导出已取消".into());
    }
    temporary.persist(&target).map_err(|_| "无法保存 ZIP")?;
    Ok(())
}
#[tauri::command]
fn hide_login(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    trusted(&window)?;
    if let Some(login) = app.get_webview_window("login") {
        login.hide().map_err(|_| "无法隐藏登录窗口")?;
    }
    window.show().map_err(|_| "无法显示导出窗口")?;
    window.unminimize().map_err(|_| "无法恢复导出窗口")?;
    window.set_focus().map_err(|_| "无法聚焦导出窗口")?;
    diagnostic(&app, "hide_login stage=main_focused");
    Ok(())
}
#[tauri::command]
fn show_login(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    trusted(&window)?;
    let login = app
        .get_webview_window("login")
        .ok_or("登录窗口已关闭，请取消后重新开始")?;
    login.show().map_err(|_| "无法显示登录窗口")?;
    login.unminimize().map_err(|_| "无法恢复登录窗口")?;
    login.set_focus().map_err(|_| "无法聚焦登录窗口")?;
    Ok(())
}
#[tauri::command]
fn cancel_export(window: WebviewWindow, state: State<'_, ExportState>) -> Result<(), String> {
    trusted(&window)?;
    token(&state).cancel();
    Ok(())
}
#[tauri::command]
fn cleanup(window: WebviewWindow, state: State<'_, ExportState>) -> Result<(), String> {
    trusted(&window)?;
    token(&state).cancel();
    state.handles.lock().unwrap().clear();
    state.temp.lock().unwrap().take();
    Ok(())
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            diagnostic(app.handle(), "app stage=started");
            Ok(())
        })
        .manage(ExportState::default())
        .invoke_handler(tauri::generate_handler![
            open_login,
            begin_export,
            api_json,
            download_attachment,
            save_zip,
            choose_save_location,
            saved_file_size,
            reveal_export,
            hide_login,
            show_login,
            cancel_export,
            cleanup
        ])
        .run(tauri::generate_context!())
        .expect("桌面程序启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_quota_error_is_readable_and_machine_recognizable() {
        let message = api_error_message(500, r#"{"errorCode":"export_too_many_times"}"#);
        assert!(message.contains("频率限制"));
        assert!(message.contains("export_too_many_times"));
        assert_eq!(api_error_message(503, "<html>unavailable</html>"), "官方接口返回 HTTP 503");
    }
    #[test]
    fn selected_destination_is_required_and_can_only_be_used_once() {
        let selected = Mutex::new(Some(PathBuf::from("/selected/backup.zip")));
        assert!(consume_destination(&selected, "/other/backup.zip").is_err());
        assert_eq!(
            consume_destination(&selected, "/selected/backup.zip").unwrap(),
            PathBuf::from("/selected/backup.zip")
        );
        assert!(consume_destination(&selected, "/selected/backup.zip").is_err());
    }
    #[test]
    fn only_known_read_api_routes_are_allowed() {
        for p in ["/api/v2/data/export/auto","/api/v2/data/export","/api/v2/batch/check/0","/api/v2/project/all/completed?from=2020-01-01%2000:00:00&to=2021-01-01%2000:00:00&limit=100","/api/v2/task/abc123?projectId=inbox123"] { assert!(api_path(p),"{p}"); }
        for p in [
            "https://evil.test/api/v2/data/export",
            "//evil.test/api/v2/data/export",
            "/api/v2/user",
            "/api/v2/project/../user",
            "/api/v2/task/abc?callback=evil",
            "/api/v2/data/export#x",
        ] {
            assert!(!api_path(p), "{p}");
        }
    }
    #[test]
    fn cookie_domain_path_secure_and_expiry_are_scoped() {
        let url = reqwest::Url::parse("https://api.dida365.com/api/v2/batch/check/0").unwrap();
        assert!(cookie_matches(
            Some(".dida365.com"),
            Some("/"),
            true,
            false,
            &url
        ));
        assert!(cookie_matches(
            Some("api.dida365.com"),
            Some("/api"),
            true,
            false,
            &url
        ));
        assert!(cookie_matches(
            Some("dida365.com"),
            Some("/"),
            true,
            false,
            &url
        ));
        assert!(!cookie_matches(
            Some(".evil.com"),
            Some("/"),
            true,
            false,
            &url
        ));
        assert!(!cookie_matches(None, Some("/"), true, false, &url));
        assert!(!cookie_matches(
            Some(".dida365.com"),
            Some("/api/v2/task"),
            true,
            false,
            &url
        ));
        assert!(!cookie_matches(
            Some(".dida365.com"),
            Some("/ap"),
            true,
            false,
            &url
        ));
        assert!(!cookie_matches(
            Some(".dida365.com"),
            Some("/"),
            true,
            true,
            &url
        ));
        let http = reqwest::Url::parse("http://api.dida365.com/api").unwrap();
        assert!(!cookie_matches(
            Some(".dida365.com"),
            Some("/"),
            true,
            false,
            &http
        ));
    }
    #[test]
    fn wry_cookie_accessor_normalizes_leading_dot_but_official_pair_still_matches() {
        let cookie = cookie::Cookie::build(("synthetic", "synthetic"))
            .domain(".dida365.com")
            .path("/")
            .secure(true)
            .build();
        assert_eq!(cookie.domain(), Some("dida365.com"));
        let api = reqwest::Url::parse("https://api.dida365.com/api/v2/batch/check/0").unwrap();
        assert!(cookie_matches(
            cookie.domain(),
            cookie.path(),
            true,
            false,
            &api
        ));
        assert!(!cookie_matches(
            Some("www.dida365.com"),
            Some("/"),
            true,
            false,
            &api
        ));
        assert!(!cookie_matches(
            Some("static.dida365.com"),
            Some("/"),
            true,
            false,
            &api
        ));
        assert!(!cookie_matches(
            Some("ticktick.com"),
            Some("/"),
            true,
            false,
            &api
        ));
        let arbitrary = reqwest::Url::parse("https://other.dida365.com/api/").unwrap();
        assert!(!cookie_matches(
            cookie.domain(),
            cookie.path(),
            true,
            false,
            &arbitrary
        ));
        let international = reqwest::Url::parse("https://api.ticktick.com/api/").unwrap();
        assert!(cookie_matches(
            Some("ticktick.com"),
            Some("/"),
            true,
            false,
            &international
        ));
        assert!(!cookie_matches(
            Some("dida365.com"),
            Some("/"),
            true,
            false,
            &international
        ));
    }
    #[test]
    fn metadata_matching_html_and_json_are_real_attachments() {
        let html = b"<!DOCTYPE html><html><form>password signin</form></html>";
        assert_eq!(
            invalid_download(html.len() as u64, Some(html.len() as u64), html),
            None
        );
        assert!(invalid_download(html.len() as u64, None, html).is_some());
        assert_eq!(invalid_download(10, None, b"{\"error\":1}"), None);
        assert!(invalid_download(10, Some(20), b"file").is_some());
    }
    #[test]
    fn cancelled_generation_never_reactivates_and_waiters_wake() {
        let state = ExportState::default();
        let previous = token(&state);
        previous.cancel();
        *state.cancellation.lock().unwrap() = Arc::new(CancelToken::default());
        assert!(active(&previous).is_err());
        assert!(active(&token(&state)).is_ok());
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(100), previous.wait())
                .await
                .unwrap();
        });
    }
    #[test]
    fn streamed_archive_preserves_bytes_and_cancel_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let bytes = vec![42u8; 400_000];
        std::fs::write(&source, &bytes).unwrap();
        let target = dir.path().join("backup.zip");
        write_archive(
            &target,
            vec![TextFile {
                path: "backup.csv".into(),
                content: "Title,Content\n测试,正文".into(),
            }],
            vec![("attachments/file.bin".into(), source)],
            &AtomicBool::new(false),
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&target).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        let mut recovered = Vec::new();
        archive
            .by_name("attachments/file.bin")
            .unwrap()
            .read_to_end(&mut recovered)
            .unwrap();
        assert_eq!(recovered, bytes);
        drop(archive);
        let before = std::fs::read(&target).unwrap();
        assert!(write_archive(
            &target,
            vec![TextFile {
                path: "backup.csv".into(),
                content: "replacement".into()
            }],
            vec![],
            &AtomicBool::new(true)
        )
        .is_err());
        assert_eq!(std::fs::read(&target).unwrap(), before);
    }
    #[test]
    fn zip_names_cannot_escape_the_archive() {
        for p in [
            "../file",
            "/file",
            "C:/file",
            "folder\\file",
            "a/../../file",
            "a//file",
        ] {
            assert!(!zip_path(p));
        }
        assert!(zip_path("attachments/正常文件.pdf"));
    }
}
