<img src="desktop/assets/logo.svg" width="72" align="right" alt="Backup assistant logo" />

# 滴答清单备份助手 · TickTick Backup Assistant

**Take your tasks, images and files with you.**

Back up TickTick / 滴答清单 as Markdown for Obsidian or local reading. Free and open source, for macOS and Windows.

[中文](README.md)

## Why use it?

The official CSV backup does not include images or file attachments. This assistant saves task content and attachments together, giving you a more complete, readable backup.

- **Turn tasks into notes**: Markdown organized by list, with content, status, dates, tags and parent relationships.
- **Keep images and files**: Download images, CSV files and other attachments, with local links in the notes.
- **Choose where to save**: Pick a folder and filename for a single ZIP. Extract it to get your Markdown vault.
- **See the result**: View task and attachment counts, with reasons and retry controls for anything that could not be saved.

Sign in on the official website. The assistant does not modify your source tasks or upload your backup to its own server.

## Download and install

**Desktop installers for 1.0.0 are being prepared. Once published, download the appropriate installer from this repository's [Releases](https://github.com/wrightgeoff112-star/ticktick-to-markdown/releases).**

| Your computer | Installer | Installation |
| --- | --- | --- |
| Mac · Apple Silicon | macOS Apple Silicon `.dmg` | Open and drag the app to Applications |
| Mac · Intel | macOS Intel `.dmg` | Open and drag the app to Applications |
| Windows · 64-bit Intel / AMD | Windows x64 `.exe` | Open and follow the installer |

On Mac, check the chip under Apple menu → About This Mac. No development tools are needed to run the installed app.

## Back up your account

1. **Select your account site**: 滴答清单 (China) or TickTick (international).
2. **Choose a save location**: Click **更改** (Change) and pick the ZIP location and filename.
3. **Click 开始备份 (Start backup)**: On first use, sign in on the official page to continue exporting.
4. **Open your backup**: Click **在文件夹中查看** (Show in folder), then extract the ZIP to read the Markdown.

For Obsidian, choose “Open folder as vault” and select the extracted folder. Keep the whole folder together when moving the backup so images and attachment links keep working.

## What's included?

| Content | How it is saved |
| --- | --- |
| Tasks and notes | One Markdown file per item, organized by list |
| Images and file attachments | Original files in `attachments/`, linked locally from notes |
| Source data | Official `backup.csv`, or `api-snapshot.json` on the fallback path |
| Backup manifest | `manifest.json`, recording file mappings and incomplete items |

If the official CSV is temporarily unavailable, the assistant attempts to save tasks and attachments through a fallback path and explains the source change in the result.

## Common questions

**Do I need to export a CSV manually?** No. The app fetches the backup data for you.

**Does it change or delete my tasks?** No. It reads your account content and writes the backup to local files.

**What does “partially completed” mean?** Check the incomplete records. Saved content is still usable; retry incomplete tasks or attachments with **重试未完成项**. If only the official CSV is unavailable, Markdown and attachments may already be saved—check the export notes.

**Do I need to start again after a save error?** No. During the current app session, click **保存已有备份** (Save prepared backup) to choose another location without downloading everything again.

Report problems in [Issues](https://github.com/wrightgeoff112-star/ticktick-to-markdown/issues), including the app version and error message. Do not share passwords, login credentials or private task content.

## About

An independently developed, community-shared tool with no affiliation with TickTick / 滴答清单. It is not an official product. Use it to back up your own account only. Some features rely on undocumented endpoints; service changes can affect exports, and the app reports failures or incomplete items.

Licensed under [MIT](LICENSE). See [DEVELOPMENT.md](DEVELOPMENT.md) for source builds and [RELEASING.md](RELEASING.md) for maintainer release steps.
