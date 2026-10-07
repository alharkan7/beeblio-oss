import { BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell, systemPreferences, webContents, type DesktopCapturerSource, type WebContents } from "electron";

/**
 * Lets the app's own pages capture the screen with getDisplayMedia (the chat
 * box's screenshot button). Electron refuses that unless the app answers the
 * request itself. Where macOS offers its own picker (macOS 15 and later) it is
 * used; elsewhere a small window lists the screens and windows to choose from.
 * Nothing is captured without a choice, and cancelling denies the request.
 */

/** What the picker window may know about a source; ids are checked against this list. */
export type PickerSource = { id: string; name: string; kind: "screen" | "window"; thumbnail: string };

type Pending = { sources: PickerSource[]; choose: (id: string | null) => void };

/** Open pickers by the id of their window's contents, so each can only answer for itself. */
const pickers = new Map<number, Pending>();

const WINDOW_LIST_TIMEOUT_MS = 2000;
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export function registerScreenCapture({ isAppUrl, pickerPage, pickerPreload }: { isAppUrl: (url: string | undefined) => boolean; pickerPage: string; pickerPreload: string }) {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // An empty answer denies the request; the page sees a NotAllowedError, as when a person cancels in a browser.
      const deny = () => callback({});
      if (!isAppUrl(request.frame?.url)) return deny();
      const requester = request.frame ? webContents.fromFrame(request.frame) : undefined;
      void chooseSource(requester, pickerPage, pickerPreload).then((source) => (source ? callback({ video: source }) : deny()), deny);
    },
    // macOS 15+ has its own picker. Elsewhere Electron may wait for a system
    // picker that does not exist (seen on Linux without a desktop portal).
    { useSystemPicker: process.platform === "darwin" },
  );

  ipcMain.handle("beeblio:screen-picker:sources", (event) => pickers.get(event.sender.id)?.sources ?? []);
  ipcMain.on("beeblio:screen-picker:choose", (event, id: unknown) => {
    pickers.get(event.sender.id)?.choose(typeof id === "string" ? id : null);
  });
}

async function chooseSource(requester: WebContents | undefined, pickerPage: string, pickerPreload: string): Promise<DesktopCapturerSource | undefined> {
  if (!(await hasScreenRecordingPermission())) return undefined;
  const sources = await listSources();
  // Beeblio's own windows are left out: capturing the window you are typing in is never what is meant.
  const ownTitles = new Set(BrowserWindow.getAllWindows().map((window) => window.getTitle()));
  const offered = sources.filter((source) => source.id.startsWith("screen:") || (source.name && !ownTitles.has(source.name)));
  if (!offered.length) {
    // Without this, the request would just fail, with nothing on screen to say why.
    await dialog.showMessageBox({ type: "info", message: "There is nothing to share", detail: "No screens or windows are available for a screenshot." });
    return undefined;
  }
  const chosen = await showPicker(offered, requester, pickerPage, pickerPreload);
  return offered.find((source) => source.id === chosen);
}

/**
 * Screens and windows are listed separately: asking for both at once returns
 * nothing at all when window listing fails, as it does without a window
 * manager on Linux. Window listing also gets a time limit so a slow answer
 * cannot hold up the picker.
 */
async function listSources(): Promise<DesktopCapturerSource[]> {
  const thumbnailSize = { width: 320, height: 200 };
  const timeout = new Promise<DesktopCapturerSource[]>((resolve) => setTimeout(() => resolve([]), WINDOW_LIST_TIMEOUT_MS));
  const [screens, windows] = await Promise.allSettled([
    desktopCapturer.getSources({ types: ["screen"], thumbnailSize }),
    Promise.race([desktopCapturer.getSources({ types: ["window"], thumbnailSize }), timeout]),
  ]);
  return [screens, windows].flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

/**
 * macOS asks for Screen Recording permission the first time. Once someone has
 * said no, macOS never asks again, so the app explains where to turn it on.
 */
async function hasScreenRecordingPermission(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status !== "denied" && status !== "restricted") return true;
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: "Beeblio needs permission to record the screen",
    detail: "Turn on Beeblio in System Settings → Privacy & Security → Screen & System Audio Recording, then try again. macOS may ask you to reopen Beeblio.",
    buttons: ["Open System Settings", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void shell.openExternal(SCREEN_RECORDING_SETTINGS);
  return false;
}

function showPicker(sources: DesktopCapturerSource[], requester: WebContents | undefined, pickerPage: string, pickerPreload: string): Promise<string | null> {
  const parent = requester ? BrowserWindow.fromWebContents(requester) ?? undefined : undefined;
  const picker = new BrowserWindow({
    parent,
    modal: Boolean(parent),
    width: 760,
    height: 540,
    minWidth: 480,
    minHeight: 360,
    minimizable: false,
    maximizable: false,
    title: "Choose what to share",
    show: false,
    webPreferences: { preload: pickerPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  picker.setMenuBarVisibility(false);
  const id = picker.webContents.id;
  return new Promise((resolve) => {
    const finish = (choice: string | null) => {
      if (!pickers.delete(id)) return;
      resolve(choice);
      if (!picker.isDestroyed()) picker.close();
    };
    pickers.set(id, {
      sources: sources.map((source) => ({ id: source.id, name: source.name, kind: source.id.startsWith("screen:") ? "screen" : "window", thumbnail: source.thumbnail.toDataURL() })),
      choose: finish,
    });
    picker.on("closed", () => finish(null));
    picker.once("ready-to-show", () => picker.show());
    void picker.loadFile(pickerPage);
  });
}
