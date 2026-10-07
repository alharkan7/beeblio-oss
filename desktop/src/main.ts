import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions, type Rectangle, type WebPreferences } from "electron";
import { missingProductionBuilds, startLocalServers, type LocalServerName, type LocalServers } from "../../scripts/local-servers.mjs";
import electronUpdater from "electron-updater";
import { registerScreenCapture } from "./screen-capture";
import { loginShellPath } from "./shell-path";
import { effectiveUpdateMode, startUpdates } from "./updates";

const here = path.dirname(fileURLToPath(import.meta.url));
const loadingPage = path.join(here, "../static/loading.html");
const mode = process.argv.includes("--dev") ? "dev" : "start";

/**
 * Where the servers and data come from. The installed app runs the servers
 * staged into its resources (desktop/scripts/stage.mjs) on the Node.js binary
 * shipped beside them, and keeps data in the OS user-data folder, because its
 * own folder is read-only. Run from a checkout (pnpm desktop), it uses the
 * repository's builds with the Node.js that pnpm ran, and shares .beeblio/
 * with pnpm dev. Electron's own binary never runs the servers: their native
 * modules are built for Node.js.
 */
const runtime = app.isPackaged
  ? (() => {
      const root = path.join(process.resourcesPath, "bundle");
      return { layout: "bundle" as const, root, nodePath: path.join(root, "node", process.platform === "win32" ? "node.exe" : "node"), dataDir: path.join(app.getPath("userData"), "Data") };
    })()
  : (() => {
      const root = path.resolve(here, "../..");
      return { layout: "checkout" as const, root, nodePath: process.env.npm_node_execpath || "node", dataDir: path.join(root, ".beeblio") };
    })();
const { nodePath } = runtime;
const uiPort = Number(process.env.BEEBLIO_DESKTOP_PORT || 3210);
const uiOrigin = `http://127.0.0.1:${uiPort}`;
const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");
const serverLabels: Record<LocalServerName, string> = { migrate: "database migration", next: "interface server", eve: "agent server" };
/**
 * Written into the packaged package.json by electron-builder.config.cjs: how
 * far updates go for this build, and the repository it was released from.
 */
const buildInfo = (() => {
  try {
    const meta = JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) as { beeblio?: { updates?: string; releaseRepo?: string } };
    return meta.beeblio ?? {};
  } catch {
    return {};
  }
})();
const releaseRepo = buildInfo.releaseRepo || "alharkan7/beeblio-oss";
/** Page loads retried while a restarted server comes back, before asking the person. */
const MAX_LOAD_RETRIES = 5;

let servers: LocalServers | undefined;
let mainWindow: BrowserWindow | undefined;
let logStream: WriteStream | undefined;
let recentLog: string[] = [];
let starting = false;
let stopReason: string | undefined;
let quitting = false;
let updates: ReturnType<typeof startUpdates> | undefined;

const secureWebPreferences = (): WebPreferences => ({
  preload: path.join(here, "preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: true,
});

function isAppUrl(url: string | undefined): boolean {
  try { return !!url && new URL(url).origin === uiOrigin; } catch { return false; }
}

function openExternally(url: string) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

/** Mirrors server output to the terminal, servers.log, and the tail shown in error dialogs. */
function log(name: string, chunk: Buffer | string) {
  const text = chunk.toString();
  if (process.stdout.writable) process.stdout.write(text);
  logStream?.write(text);
  recentLog.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
  if (recentLog.length > 200) recentLog = recentLog.slice(-200);
}

function canListen(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(undefined));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : undefined));
    });
  });
}

async function nodeMajorVersion(): Promise<number | undefined> {
  try {
    const { stdout } = await promisify(execFile)(nodePath, ["-p", "process.versions.node"]);
    return Number(stdout.trim().split(".")[0]);
  } catch { return undefined; }
}

/** Explains why Beeblio cannot start; resolves true when the person asks to try again. */
async function showStartupProblem(message: string, detail: string): Promise<boolean> {
  for (;;) {
    const { response } = await dialog.showMessageBox({ type: "error", message, detail, buttons: ["Try Again", "Open Logs", "Quit"], defaultId: 0, cancelId: 2 });
    if (response === 1) { void shell.openPath(path.join(app.getPath("logs"), "servers.log")); continue; }
    return response === 0;
  }
}

async function checkPrerequisites(): Promise<{ message: string; detail: string } | undefined> {
  if (runtime.layout === "bundle") {
    // Only a damaged installation or an antivirus quarantine removes these.
    const missing = [nodePath, path.join(runtime.root, "ui", "server.js"), path.join(runtime.root, "agent", "server", "index.mjs")].filter((file) => !existsSync(file));
    if (missing.length) return { message: "Beeblio's installation is incomplete", detail: `Reinstall Beeblio. Missing:\n${missing.join("\n")}` };
  } else {
    const major = await nodeMajorVersion();
    if (!major || major < 24) {
      return { message: "Beeblio needs Node.js 24", detail: `Could not run Node.js 24 from "${nodePath}". Install Node.js 24 and start the app with pnpm desktop.` };
    }
    const missing = mode === "start" ? missingProductionBuilds(runtime.root) : [];
    if (missing.length) {
      return { message: "Build Beeblio before starting the desktop app", detail: `Run ${missing.join(" && ")} in ${runtime.root}, or use pnpm desktop:dev to run the development servers.` };
    }
  }
  if (!(await canListen(uiPort))) {
    return { message: `Port ${uiPort} is already in use`, detail: "Close the program using it, or set BEEBLIO_DESKTOP_PORT to another port." };
  }
  return undefined;
}

let shellPath: Promise<string> | undefined;

/**
 * Variables the servers need beyond the inherited ones. On macOS an app opened
 * from Finder lacks the user's PATH, so the agent would not find python3,
 * pandoc, or soffice; it is asked from the login shell once and reused on
 * restarts. A terminal (pnpm desktop) already provides the right PATH.
 */
async function serverEnvironment(): Promise<Record<string, string>> {
  if (runtime.layout !== "bundle" || process.platform !== "darwin") return {};
  const pending = (shellPath ??= loginShellPath());
  return { PATH: await pending };
}

async function startServers(): Promise<void> {
  for (;;) {
    const problem = await checkPrerequisites();
    if (problem) {
      if (await showStartupProblem(problem.message, problem.detail)) continue;
      return app.quit();
    }
    recentLog = [];
    stopReason = undefined;
    logStream?.end();
    mkdirSync(app.getPath("logs"), { recursive: true });
    logStream = createWriteStream(path.join(app.getPath("logs"), "servers.log"));
    // An unhandled stream error (say, a full disk) would crash the main process; losing the file log is the smaller harm.
    logStream.on("error", (error) => {
      console.error("servers.log is no longer written:", error);
      logStream = undefined;
    });
    starting = true;
    try {
      const agentPort = await canListen(0);
      if (!agentPort) throw new Error("No free local port for the agent server");
      servers = await startLocalServers({ ...runtime, mode, uiPort, agentPort, extraEnv: await serverEnvironment(), onOutput: log, onExit: (name, code, error) => void serverStopped(name, code, error) });
      await servers.waitUntilReady();
    } catch (error) {
      await servers?.stop();
      servers = undefined;
      if (quitting) return;
      const reason = stopReason ?? (error instanceof Error ? error.message : String(error));
      if (await showStartupProblem("Beeblio could not start", `${reason}\n\n${recentLog.slice(-25).join("\n")}`)) continue;
      return app.quit();
    } finally {
      starting = false;
    }
    for (const warning of servers.warnings) {
      log("desktop", `${warning}\n`);
      void dialog.showMessageBox({ type: "warning", message: "Some agent tools are unavailable", detail: warning });
    }
    for (const window of BrowserWindow.getAllWindows()) if (!isAppUrl(window.webContents.getURL())) void window.loadURL(`${uiOrigin}/workspace`);
    if (!mainWindow) createMainWindow();
    return;
  }
}

async function serverStopped(name: LocalServerName, code: number | string | null, error?: Error) {
  if (quitting || !servers) return;
  const running = servers;
  servers = undefined;
  stopReason = `The ${serverLabels[name]} stopped: ${error?.message ?? `exit code ${code}`}`;
  await running.stop();
  // During startup, waitUntilReady fails next and startServers reports it.
  if (starting) return;
  const detail = `${stopReason}\n\n${recentLog.slice(-25).join("\n")}`;
  if (await showStartupProblem(`Beeblio's ${serverLabels[name]} stopped unexpectedly`, detail)) {
    for (const window of BrowserWindow.getAllWindows()) void window.loadFile(loadingPage);
    return startServers();
  }
  app.quit();
}

/** Stops the servers for good: when quitting, and before an update's installer replaces their files. */
async function stopServersForQuit(): Promise<void> {
  quitting = true;
  const running = servers;
  servers = undefined;
  await running?.stop();
}

function createUpdates() {
  const { autoUpdater } = electronUpdater;
  const write = (level: string) => (message: unknown) => log("updates", `${level}: ${String(message)}\n`);
  autoUpdater.logger = { info: write("info"), warn: write("warn"), error: write("error"), debug: () => {} };
  return startUpdates({
    mode: effectiveUpdateMode(buildInfo.updates, { packaged: app.isPackaged, platform: process.platform }),
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    releaseRepo,
    ask: async (options) => {
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      return result.response;
    },
    openExternal: (url) => void shell.openExternal(url),
    log: (message) => log("updates", `${message}\n`),
    prepareToInstall: stopServersForQuit,
  });
}

type WindowState = Rectangle & { maximized?: boolean };

function savedWindowState(): WindowState | undefined {
  try {
    const state = JSON.parse(readFileSync(windowStateFile(), "utf8")) as WindowState;
    const visible = screen.getAllDisplays().some(({ workArea }) => state.x < workArea.x + workArea.width && state.x + state.width > workArea.x && state.y < workArea.y + workArea.height && state.y + state.height > workArea.y);
    return visible ? state : undefined;
  } catch { return undefined; }
}

/**
 * Keeps an app window usable when its page fails: retries loads that fail
 * while a server restarts, and offers a reload when the renderer crashes or
 * hangs instead of leaving a blank or frozen window.
 */
function watchForPageFailures(window: BrowserWindow) {
  const contents = window.webContents;
  let failedLoads = 0;
  contents.on("did-finish-load", () => { failedLoads = 0; });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) => {
    // -3 (ERR_ABORTED) is a navigation replaced by another one, not a failure.
    if (!isMainFrame || errorCode === -3 || !isAppUrl(url) || !servers) return;
    if (++failedLoads <= MAX_LOAD_RETRIES) {
      // loadURL, not reload: after a failed load the committed page may be Chromium's error page.
      setTimeout(() => { if (!window.isDestroyed()) void contents.loadURL(url); }, 500 * 2 ** failedLoads);
      return;
    }
    log("desktop", `Could not load ${url}: ${errorDescription} (${errorCode})\n`);
    void offerReload(window, "Beeblio could not load this page", `${errorDescription} (${errorCode})`);
  });
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    log("desktop", `Window renderer stopped: ${details.reason} (exit code ${details.exitCode})\n`);
    void offerReload(window, "This Beeblio window stopped working", `Reason: ${details.reason}. Your saved work is not affected.`);
  });
  window.on("unresponsive", () => void offerReload(window, "This Beeblio window is not responding", "You can wait for it, or reload it.", "Wait"));
}

async function offerReload(window: BrowserWindow, message: string, detail: string, dismissLabel = "Close Window") {
  if (window.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(window, { type: "warning", message, detail, buttons: ["Reload", dismissLabel], defaultId: 0, cancelId: 1 });
  if (window.isDestroyed()) return;
  if (response === 0) {
    if (servers) window.webContents.reload();
    else void window.loadFile(loadingPage);
  } else if (dismissLabel === "Close Window") {
    window.destroy();
  }
}

function createMainWindow() {
  const state = savedWindowState();
  const window = new BrowserWindow({
    ...(state ? { x: state.x, y: state.y, width: state.width, height: state.height } : { width: 1440, height: 900 }),
    minWidth: 900,
    minHeight: 600,
    title: "Beeblio",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b1015" : "#f9f7f1",
    webPreferences: secureWebPreferences(),
  });
  mainWindow = window;
  if (state?.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());
  window.on("close", () => {
    try { writeFileSync(windowStateFile(), JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() })); } catch { /* best effort */ }
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = undefined; });
  if (servers) void window.loadURL(`${uiOrigin}/workspace`);
  else void window.loadFile(loadingPage);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const currentAppUrl = () => {
    const url = BrowserWindow.getFocusedWindow()?.webContents.getURL();
    return isAppUrl(url) ? url! : `${uiOrigin}/workspace`;
  };
  /** Asks the app's page to do something; a window showing the loading or error page has no app to ask. */
  const sendToApp = (channel: string) => {
    const window = [BrowserWindow.getFocusedWindow(), mainWindow].find((candidate) => candidate && isAppUrl(candidate.webContents.getURL()));
    window?.webContents.send(channel);
  };
  const openSettings = () => sendToApp("beeblio:open-settings");
  const settingsItem: MenuItemConstructorOptions = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => void updates?.checkNow() },
        { type: "separator" },
        settingsItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    } satisfies MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        ...(isMac ? [] : [settingsItem, { type: "separator" } as const]),
        { label: "Open in Browser", click: () => void shell.openExternal(currentAppUrl()) },
        { label: "Open Data Folder", click: () => void shell.openPath(runtime.dataDir) },
        { label: "Open Logs", click: () => void shell.openPath(path.join(app.getPath("logs"), "servers.log")) },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Show Tour", click: () => sendToApp("beeblio:show-tour") },
        ...(isMac ? [] : [{ label: "Check for Updates…", click: () => void updates?.checkNow() }, { type: "separator" } as const]),
        { label: "Beeblio on GitHub", click: () => void shell.openExternal(`https://github.com/${releaseRepo}`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function restrictWebContents() {
  // Covers the main window and the workspace file windows the page opens.
  app.on("browser-window-created", (_event, window) => watchForPageFailures(window));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      openExternally(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      // Workspace files open in their own window; everything else goes to the default browser.
      if (isAppUrl(url)) return { action: "allow", overrideBrowserWindowOptions: { width: 1100, height: 800, webPreferences: secureWebPreferences() } };
      openExternally(url);
      return { action: "deny" };
    });
  });
  session.defaultSession.setPermissionRequestHandler((contents, _permission, callback, details) => callback(isAppUrl(details.requestingUrl || contents.getURL())));
  registerScreenCapture({ isAppUrl, pickerPage: path.join(here, "../static/screen-picker.html"), pickerPreload: path.join(here, "picker-preload.cjs") });
  ipcMain.handle("beeblio:select-folder", async (event) => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error("Folder selection is only available to Beeblio");
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Choose a Beeblio project folder", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (!mainWindow) createMainWindow(); });
  app.on("before-quit", (event) => {
    if (!servers) return;
    event.preventDefault();
    void stopServersForQuit().finally(() => { logStream?.end(); app.quit(); });
  });
  // SIGHUP too: the servers run in their own process groups, so a closed terminal no longer reaches them directly.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => app.quit());
  // A closed terminal turns writes to stdout into EPIPE errors; the log file still has everything.
  process.stdout.on("error", () => {});
  process.on("unhandledRejection", (reason) => log("desktop", `Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`));
  // After an uncaught exception the main process state is unknown, so report it and quit;
  // before-quit still stops the servers so nothing is left running.
  process.on("uncaughtException", (error) => {
    log("desktop", `Uncaught exception: ${error.stack ?? error.message}\n`);
    dialog.showErrorBox("Beeblio hit an unexpected error and will close", `${error.message}\n\nDetails are in servers.log.`);
    app.quit();
  });

  // Not a top-level await: Electron does not emit "ready" until an ESM entry finishes evaluating.
  void app.whenReady().then(async () => {
    restrictWebContents();
    updates = createUpdates();
    buildMenu();
    createMainWindow();
    await startServers();
    if (servers) updates.schedule();
  });
}
