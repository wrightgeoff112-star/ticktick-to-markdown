use reqwest::Url;

pub(crate) fn allowed(domain: &str, url: &Url) -> bool {
    if !matches!(domain, "dida365.com" | "ticktick.com")
        || url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if host == domain || host.ends_with(&format!(".{domain}")) {
        return true;
    }

    // Official signin pages redirect in this WebView (including Apple form_post).
    // Keep the session here so the existing cookie bridge can detect the callback.
    // Match authentication hosts exactly, never entire google.com / qq.com domains.
    if matches!(
        host,
        "appleid.apple.com" | "idmsa.apple.com" | "account.apple.com"
    ) {
        return true;
    }
    match domain {
        "dida365.com" => matches!(
            host,
            "open.weixin.qq.com"
                | "graph.qq.com"
                | "xui.ptlogin2.qq.com"
                | "api.weibo.com"
                | "login.sina.com.cn"
        ),
        "ticktick.com" => matches!(
            host,
            "accounts.google.com" | "www.facebook.com" | "facebook.com" | "m.facebook.com"
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepts(domain: &str, url: &str) -> bool {
        allowed(domain, &Url::parse(url).unwrap())
    }

    #[test]
    fn dida_social_login_and_callback_routes_are_allowed() {
        for url in [
            "https://open.weixin.qq.com/connect/qrconnect?redirect_uri=https://dida365.com/sign/wechat",
            "https://open.weixin.qq.com/connect/oauth2/authorize",
            "https://graph.qq.com/oauth2.0/authorize",
            "https://graph.qq.com/oauth2.0/show",
            "https://xui.ptlogin2.qq.com/cgi-bin/xlogin",
            "https://api.weibo.com/oauth2/authorize",
            "https://login.sina.com.cn/sso/login.php",
            "https://dida365.com/sign/wechat?code=synthetic&state=synthetic",
            "https://dida365.com/sign/qq#access_token=synthetic",
            "https://www.dida365.com/sign/weibo",
            "https://dida365.com/webapp/",
        ] {
            assert!(accepts("dida365.com", url), "{url}");
        }
    }

    #[test]
    fn ticktick_social_login_and_callback_routes_are_allowed() {
        for url in [
            "https://accounts.google.com/o/oauth2/auth",
            "https://accounts.google.com/v3/signin/identifier",
            "https://www.facebook.com/dialog/oauth",
            "https://www.facebook.com/login.php",
            "https://m.facebook.com/login.php",
            "https://ticktick.com/sign/google#access_token=synthetic",
            "https://ticktick.com/sign/facebook",
            "https://ticktick.com/webapp/",
        ] {
            assert!(accepts("ticktick.com", url), "{url}");
        }
    }

    #[test]
    fn apple_login_is_available_on_both_sites() {
        for domain in ["dida365.com", "ticktick.com"] {
            for url in [
                "https://appleid.apple.com/auth/authorize",
                "https://idmsa.apple.com/appleauth/auth/authorize/signin",
                "https://account.apple.com/",
            ] {
                assert!(accepts(domain, url), "{domain}: {url}");
            }
            assert!(accepts(domain, &format!("https://{domain}/sign/apple")));
        }
    }

    #[test]
    fn navigation_cannot_escape_to_unrelated_or_lookalike_origins() {
        for domain in ["dida365.com", "ticktick.com"] {
            for url in [
                "http://open.weixin.qq.com/connect/qrconnect",
                "http://accounts.google.com/",
                "https://open.weixin.qq.com.evil.test/",
                "https://evil.accounts.google.com/",
                "https://notappleid.apple.com/",
                "https://www.facebook.com.evil.test/",
                "https://dida365.com.evil.test/",
                "https://notticktick.com/",
                "https://example.com/?next=https://dida365.com",
                "https://open.weixin.qq.com@evil.test/",
                "https://accounts.google.com:8443/",
                "https://user:pass@appleid.apple.com/",
                "https://localhost/",
                "https://127.0.0.1/",
                "tauri://localhost/",
                "file:///tmp/index.html",
                "javascript:alert(1)",
                "about:blank",
            ] {
                assert!(!accepts(domain, url), "{domain}: {url}");
            }
            assert!(!accepts(domain, &format!("http://{domain}/signin")));
            assert!(!accepts(domain, &format!("https://{domain}:8443/signin")));
            assert!(!accepts(
                domain,
                &format!("https://user:pass@{domain}/signin")
            ));
            assert!(accepts(domain, &format!("https://{domain}:443/signin")));
        }
    }

    #[test]
    fn login_providers_are_scoped_to_the_selected_site() {
        assert!(!accepts("dida365.com", "https://accounts.google.com/"));
        assert!(!accepts("dida365.com", "https://www.facebook.com/"));
        assert!(!accepts("ticktick.com", "https://open.weixin.qq.com/"));
        assert!(!accepts("ticktick.com", "https://graph.qq.com/"));
        assert!(!accepts("ticktick.com", "https://api.weibo.com/"));
        assert!(!accepts("dida365.com", "https://ticktick.com/signin"));
        assert!(!accepts("ticktick.com", "https://dida365.com/signin"));
        assert!(!accepts("evil.test", "https://evil.test/signin"));
        assert!(!accepts("evil.test", "https://appleid.apple.com/"));
    }
}
