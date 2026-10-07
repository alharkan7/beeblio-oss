# Beeblio

Beeblio is a full-stack AI research workspace. It collaborates with you and works directly in your folders & documents. The Next.js interface and Eve agent run locally on your computer, and each project points to an existing folder.

This is intended for a single trusted user on one computer.

![Annotated Beeblio workspace showing the research artifact browser, document editor, and AI assistant](./public/image.png)

## What you can do

Beeblio brings writing, an AI research assistant, and your project files into one workspace:

- **Write with your sources beside you.** The [document editor](./app/%5BprojectId%5D/_components/editors/tiptap-document-editor.tsx) supports rich Markdown editing, tables, math, images, inline citations, and a generated bibliography. Search for literature or insert a citation from the editor, and use document review and sentence suggestions while you write. Export finished work as DOCX, citation-aware DOCX, LaTeX, or portable Markdown.
- **Work with an agent in the same project.** The [chat](./app/_components/agent-chat.tsx) can use the open file, `@`-mentioned files, uploaded files, and selected passages as context. The [Eve agent](./agent/) can search literature and the web, inspect and edit project files, update bibliographies and literature matrices, and run local Bash or Python workflows. Conversations are saved per project so you can return to earlier work.
- **Keep the research organized.** The [workspace rail](./app/%5BprojectId%5D/_components/project-layout-ui.tsx) combines a searchable [file explorer](./app/%5BprojectId%5D/_components/file-explorer.tsx) with [literature search and library](./app/%5BprojectId%5D/_components/literature-panel.tsx). Browse references, data, analysis, reports, and figures in the [artifact views](./app/%5BprojectId%5D/_components/research-artifact-browser.tsx); upload files, create folders and research artifacts, and open them alongside the chat.

The project [session page](./app/%5BprojectId%5D/%5B%5B...sessionId%5D%5D/page.tsx) connects the workspace to a new or saved conversation. Your project remains an ordinary folder on disk, so files you create or edit in Beeblio are available to your other tools.

## Requirements

- Node.js 24 and pnpm 11
- An OpenRouter API key and model ID for the agent
- Bash and Python 3 for local agent commands and analysis
- Optional: LibreOffice (`soffice`) for agent-assisted Office-to-PDF conversion; other command-line tools and Python packages for the workflows you want to run

In the browser, the folder picker uses macOS's native chooser; on other systems, enter an existing absolute folder path in the project form. The [desktop app](#desktop-app) has a native folder picker on every platform.

## Run locally

```bash
pnpm install
pnpm dev
# Open http://127.0.0.1:3000 and add your OpenRouter key and model in Settings
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The root URL redirects to `/workspace`. `pnpm dev` creates `.beeblio/` if needed, applies SQLite migrations, and starts both the Next.js UI and the Eve agent. They listen on `127.0.0.1:3000` and `127.0.0.1:2000` respectively.

Choose **Link Project Folder** to select a folder. You can also paste its absolute path. Beeblio stores the resolved path in SQLite and works with the files in place. On linking, it adds any missing canonical files & folders: `1-References/`, `2-Data/`, `3-Analysis/`, and `4-Reports/` folders, plus `1-References/references.bib` and `3-Analysis/literature-matrix.matrix`. Existing files are preserved. Agent file tools display the folder as `/workspace`; agent shell commands run on your computer with that folder as the working directory. `$BEEBLIO_PROJECT_DIR` contains its absolute path.

## Desktop app

Beeblio also runs as a desktop app for Apple Silicon Macs (macOS 12 or later) and Windows, in its own window. It includes everything it needs to run, so you don't need Node.js or a checkout.

### Install

Download the installer for your computer from the Releases page of the repository that publishes the desktop app: `…-mac-arm64.dmg` for Macs with Apple Silicon, or `…-win-x64.exe` for Windows. Intel Macs are not supported. On first launch, a short welcome connects a model (your OpenRouter API key and a main model) and creates your first project, which then opens with a tour of the workspace. **Show tour** in the account menu, or **Help → Show Tour**, runs it again.

Beeblio checks for new versions by itself, and on **Check for Updates…** (the **Beeblio** menu on macOS, **Help** on Windows). On Windows it downloads and installs them; on macOS it says when one is available and links to it, until the app is signed.

The installers are not signed with a developer certificate yet, so your system warns you the first time you open the app:

- **macOS:** Open the app once and dismiss the warning, then open **System Settings → Privacy & Security** and choose **Open Anyway** next to Beeblio. If macOS says the app "is damaged", run `xattr -dr com.apple.quarantine /Applications/Beeblio.app` in Terminal, then open it again.
- **Windows:** On the "Windows protected your PC" screen, choose **More info → Run anyway**. Beeblio installs for your user account only and needs no administrator rights.

The agent runs commands with programs on your computer. **Settings → System Tools** checks which ones are installed and how to install the rest:
- Python 3 with pandas and python-docx, for analysis and Word files.
- [Pandoc](https://pandoc.org), for LaTeX and Word export.
- [LibreOffice](https://www.libreoffice.org), for Office files.
- FFmpeg, Poppler and Tesseract, for media, PDFs and OCR.

On each platform:
- **macOS:** Beeblio reads your shell's `PATH`, so tools you installed with Homebrew are found, and LibreOffice is found in `/Applications`.
- **Windows:** Install [Git for Windows](https://git-scm.com/download/win); the agent runs shell commands with its Git Bash. Install Python from [python.org](https://www.python.org/downloads/) and select "Add python.exe to PATH". The agent's `python3` then uses it.

To attach a screenshot to a chat message, use the screen button next to the attach button. On macOS, the first time, allow Beeblio under **System Settings → Privacy & Security → Screen & System Audio Recording**.

If Beeblio closes unexpectedly (a crash or Force Quit), its local servers stop on their own, so it starts normally the next time.

Beeblio keeps its data in your user folder, outside the app: `~/Library/Application Support/Beeblio/Data` on macOS and `%APPDATA%\Beeblio\Data` on Windows. **File → Open Data Folder** opens it, and uninstalling leaves it in place. The interface listens on `127.0.0.1:3210`. Server output is written to `servers.log` (**File → Open Logs**).

### Run from a checkout

To work on the desktop app, run it from this checkout. It needs the same requirements as above.

```bash
pnpm install
pnpm --dir desktop install
pnpm build && pnpm build:eve
pnpm desktop
```

`pnpm desktop` serves the production builds, so build again after you pull changes. `pnpm desktop:dev` runs the development servers with hot reload instead and needs no build. The first launch downloads Electron. Run this way, the app uses the same `.env.local` and `.beeblio/` data as `pnpm dev`, so it shows the same projects and conversations. Don't run both at once. Set `BEEBLIO_DESKTOP_PORT` to use a port other than 3210.

### Build the installers

Installers are built on the platform they are for: an Apple Silicon Mac builds the `.dmg`, Windows the `.exe`. The UI must come from a flat install, because pnpm's linked `node_modules` cannot be packaged. Set the layout for the whole shell session rather than as an install flag: pnpm checks dependencies before running a script and would reinstall them in the linked layout.

```bash
export pnpm_config_node_linker=hoisted BEEBLIO_STANDALONE=1
# PowerShell: $env:pnpm_config_node_linker="hoisted"; $env:BEEBLIO_STANDALONE=1
pnpm install --frozen-lockfile
pnpm build
pnpm build:eve
pnpm --dir desktop install
pnpm --dir desktop dist
```

The installer is written to `desktop/release/`. Run `pnpm install` again in a new shell afterwards to return to the usual layout. On Linux, `pnpm --dir desktop dist` builds an unpacked app in `desktop/release/linux-unpacked` for testing; it is not released.

**Releases:** set the new version in `desktop/package.json` and push a tag such as `v0.2.0`. The [Desktop release](.github/workflows/desktop-release.yml) workflow builds both installers and attaches them to a draft GitHub Release, which you review and publish. Publishing is what offers the version to installed apps; tags such as `v0.2.0-beta.1` become prereleases, which apps never offer. It also builds them, without a release, for pushes and pull requests that change more than documentation, and when run by hand. [docs/desktop-updates.md](docs/desktop-updates.md) explains the update pipeline.

**Signing:** the workflow signs builds once these repository secrets exist, and works without them:

- macOS: `MAC_CERTIFICATE` (base64 `.p12` Developer ID Application certificate) and `MAC_CERTIFICATE_PASSWORD`. Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` to notarize.
- Windows: `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`.

## Configuration

Everything is configured in the app under **Settings** (account menu, or **Settings…** in the desktop app's menu); until the required settings exist, the menu shows **Finish setup**. The main agent needs an OpenRouter API key, a main model, and that model's context window. Beeblio checks the key with OpenRouter, looks the model up there, and fills in its context window. Changes apply right away, without a restart.

In a checkout you can also set any of these as environment variables in `.env.local`; copy [`.env.example`](./.env.example). A value saved in Settings takes precedence, and removing it there falls back to `.env.local`. The settings are:

| Setting | Used for |
| --- | --- |
| `OPENROUTER_MODEL_ID_LITE` | Lightweight tasks such as conversation titles and sentence suggestions |
| `OPENROUTER_REQUEST_TIMEOUT_MS` | Optional limit for one agent model request, in milliseconds; unset means no time limit. Agent turns have no fixed time limit. |
| `OPENROUTER_MODEL_ID_REVIEW` | Document review; falls back to the main model |
| `OPENROUTER_VISION_MODEL_ID` | Image analysis; falls back to the main model if it supports vision |
| `GOOGLE_API_KEY`, `GOOGLE_TRANSCRIPTION_MODEL_ID` | Google key and selected transcription model for audio transcription |
| `GOOGLE_KNOWLEDGE_EMBEDDING_MODEL_ID`, `GOOGLE_KNOWLEDGE_QUERY_MODEL_ID` | Selected Google models for creating and querying Knowledge stores |
| `MONID_API_KEY`, `BRAVE_SEARCH_API_KEY` | Optional research and web tools |
| `CROSSREF_MAILTO` | Contact address for scholarly metadata requests |
| `PUBLIC_TUNNEL_ORIGIN` | Public HTTPS origin of a tunnel to the local UI, used for Office Online previews and share links |

The application has one local user and no browser login or accounts checks. Keep the servers bound to loopback: the agent's Bash tool uses your computer's own environment and can access files outside a project folder through shell commands.

## Where data lives

- **Project files:** Your linked folders. Browser uploads, downloads, and agent file operations use local filesystem routes.
- **Application data:** `.beeblio/beeblio.sqlite` stores projects, conversation state, knowledge metadata, and share records. Schema migrations are in [`drizzle/`](./drizzle/).
- **Internal secret:** `.beeblio/agent-secret` is generated automatically for the local UI-to-agent connection.
- **Settings:** `.beeblio/settings.json`, including API keys, readable only by your user account.
- **Agent compute:** Eve runs Bash and Python on the host. No Docker image or separate database server is required. The bundled `beeblio_research` Python helper is available to agent commands; other Python packages come from your local environment.

Beeblio still calls external model and research APIs when those features are used. Back up both your project folders and `.beeblio/` if you need to preserve files and conversation history.

## Documents

The Markdown editor can export DOCX, DOCX with Mendeley or Zotero citations, LaTeX, and portable Markdown. Office files in the workspace open in Microsoft's read-only Office Online viewer. Because Microsoft fetches the file itself, local previews require a public HTTPS tunnel to `127.0.0.1:3000` and its base URL in `PUBLIC_TUNNEL_ORIGIN`; restart `pnpm dev` after changing it. The Share button also uses this origin for links that others can open. Keep the tunnel running while using either feature. The tunnel exposes the app, and Office previews send the viewed file to Microsoft's service.

To make a PDF, export DOCX and convert it with your local document software or ask the agent to do it. LibreOffice is optional for that local conversion; it is not used by the current Office file viewer.

The Share button creates a public link for a file. When `PUBLIC_TUNNEL_ORIGIN` is set, the link uses that tunnel even if you opened Beeblio through localhost. Keep the app and tunnel running for others to view shared files or submit shared forms; form responses are saved in the project folder.

## Development commands

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm build:eve
pnpm db:migrate
pnpm --dir desktop typecheck
```
