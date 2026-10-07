import { contextBridge, ipcRenderer } from "electron";

/** The only desktop features the web app can reach; see types/beeblio-desktop.d.ts. */
contextBridge.exposeInMainWorld("beeblioDesktop", {
  platform: process.platform,
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke("beeblio:select-folder"),
  onOpenSettings: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("beeblio:open-settings", listener);
    return () => { ipcRenderer.removeListener("beeblio:open-settings", listener); };
  },
  onShowTour: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("beeblio:show-tour", listener);
    return () => { ipcRenderer.removeListener("beeblio:show-tour", listener); };
  },
});
