# 发布滴答清单备份助手

版本：1.0.0。使用一个 GitHub Release，按操作系统和芯片分别提供安装包。

| 下载项 | 对应电脑 | 安装包 |
| --- | --- | --- |
| macos-apple-silicon | Mac M1 / M2 / M3 / M4 等 Apple 芯片 | `.dmg` |
| macos-intel | Intel 芯片 Mac | `.dmg` |
| windows-x64 | 64 位 Intel / AMD Windows 电脑 | `.exe` |

Mac 可在「苹果菜单 → 关于本机」查看芯片；Windows ARM 版暂不在这次构建范围内。

## 第一次发布

1. 在目标平台完成真实导出，检查解压后的 Markdown、图片及普通文件附件。
2. 整理并提交本次源码、锁文件与 `.github/workflows/desktop-build.yml`，推送到仓库。不要提交 `tmp/`、导出的账号数据、缓存或登录凭据。
3. 在仓库 [Actions](https://github.com/wrightgeoff112-star/ticktick-to-markdown/actions) 中运行 **Desktop installers**，选择包含本次改动的分支。首次使用需先把工作流合入默认分支。
4. 等三类构建成功，下载各自 artifact 并解压，取出两个 DMG 和一个 EXE。Actions 下载的外层 ZIP 是构建产物容器，不是安装包。
5. 在 [Releases](https://github.com/wrightgeoff112-star/ticktick-to-markdown/releases) 创建 `v1.0.0` **草稿**，将 tag 指向本次已验证的提交，上传三份安装包。附件名需明确区分 Mac Apple Silicon、Mac Intel 和 Windows x64。
6. 用对应电脑验证安装、官方登录、选择保存位置与导出，再将草稿发布。README 之后链接这个实际 Release。

当前工作流只生成构建产物，不创建或自动发布 Release。将代码合入默认分支后，按上面的步骤手动构建与发布桌面版。

## 命令行发布

仓库远程地址为 `git@github-wrightgeoff:wrightgeoff112-star/ticktick-to-markdown.git`。Git SSH 与 `gh` API 登录互相独立；发布前用 `gh api user` 确认当前账号，再检查仓库写权限。使用多个 GitHub 账号时，应明确选择对此仓库具有发布权限的账号。

## 安装与签名

本地 debug `.app` 用于开发验证，正式下载应提供平台安装包。发布前需要决定是否配置 Mac Developer ID 签名及公证、Windows 代码签名；尚未完成这些步骤时，不承诺用户下载后可无提示安装。

参考：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[Tauri GitHub 构建](https://v2.tauri.app/distribute/pipelines/github/)。
