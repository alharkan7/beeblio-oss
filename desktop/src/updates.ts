/**
 * Update checks for the installed app, against the GitHub Releases of the
 * repository the build was released from. Publishing a draft release is what
 * hands a version to users; drafts and prereleases are never offered.
 *
 * How far an update goes depends on the build (see electron-builder.config.cjs):
 * - "install": downloads in the background and offers a restart, or installs
 *   on the next quit. Windows, and macOS once the app is Developer-ID signed.
 * - "notify": says a version is available and links to its release page.
 *   macOS without a certificate, where the system refuses to install updates
 *   into an ad-hoc signed app.
 * - "off": checkouts and Linux, which have no installer to update.
 *
 * Electron and electron-updater are passed in, so this logic runs in tests.
 */

export type UpdateMode = "install" | "notify" | "off";

/** The part of electron-updater's AppUpdater used here. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "update-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface UpdateDependencies {
  mode: UpdateMode;
  updater: Updater;
  currentVersion: string;
  /** "owner/repo" whose releases the app updates from. */
  releaseRepo: string;
  /** Shows a message and resolves with the index of the button chosen. */
  ask(options: { message: string; detail: string; buttons: string[]; type?: "info" | "warning" }): Promise<number>;
  openExternal(url: string): void;
  log(message: string): void;
  /** Stops the local servers. Runs before the installer starts, since on Windows it replaces the bundled node.exe they run on. */
  prepareToInstall(): Promise<void>;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  setInterval?: (callback: () => void, ms: number) => unknown;
}

/** Long enough that the first check never competes with starting the servers and opening the window. */
export const FIRST_CHECK_DELAY_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The build's configured mode, unless this run cannot update at all: an
 * unpackaged checkout has no installer, and Linux builds are only for testing.
 */
export function effectiveUpdateMode(configured: unknown, { packaged, platform }: { packaged: boolean; platform: string }): UpdateMode {
  if (!packaged || (platform !== "darwin" && platform !== "win32")) return "off";
  return configured === "install" || configured === "notify" ? configured : "off";
}

export function releasePageUrl(releaseRepo: string, version: string): string {
  return `https://github.com/${releaseRepo}/releases/tag/v${version}`;
}

/** A short reason for a failed manual check; electron-updater's own messages carry whole HTTP responses. */
export function describeCheckFailure(error: Error): string {
  const message = error.message;
  if (/\b404\b|Unable to find latest version|No published versions/i.test(message)) {
    return "No published release was found. Releases from a private repository cannot be checked without signing in.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_/i.test(message)) return "Beeblio could not reach GitHub. Check the internet connection.";
  return message.split("\n")[0].slice(0, 200);
}

export function startUpdates(deps: UpdateDependencies) {
  const { mode, updater } = deps;
  /** Versions already offered this run: one prompt per version, however often the timer checks. */
  const offered = new Set<string>();
  /** A downloaded version waiting for a restart. */
  let ready: string | undefined;
  /** Set while "Check for Updates…" runs, so its result is reported instead of only logged. */
  let manualCheck: { resolve: (result: string | undefined) => void } | undefined;

  const finishManual = (result: string | undefined) => {
    manualCheck?.resolve(result);
    manualCheck = undefined;
  };

  /** A manual check always asks; a background one only the first time a version turns up. */
  const shouldOffer = (version: string) => {
    const asked = Boolean(manualCheck) || !offered.has(version);
    offered.add(version);
    return asked;
  };

  const offerDownload = (version: string) =>
    deps
      .ask({
        message: `Beeblio ${version} is available`,
        detail: `You have ${deps.currentVersion}. Download the new version from its release page and install it over this one; your projects and settings stay as they are.`,
        buttons: ["Download", "Later"],
      })
      .then((choice) => { if (choice === 0) deps.openExternal(releasePageUrl(deps.releaseRepo, version)); });

  const offerRestart = (version: string) =>
    deps
      .ask({
        message: `Beeblio ${version} is ready to install`,
        detail: "Restart now to update, or keep working and it installs the next time you quit Beeblio.",
        buttons: ["Restart now", "Later"],
      })
      .then(async (choice) => {
        if (choice !== 0) return;
        await deps.prepareToInstall();
        updater.quitAndInstall(false, true);
      });

  if (mode !== "off") {
    updater.autoDownload = mode === "install";
    updater.autoInstallOnAppQuit = mode === "install";
    updater.allowPrerelease = false;

    updater.on("update-available", ({ version }) => {
      deps.log(`Update ${version} is available (running ${deps.currentVersion})`);
      // In "install" mode the offer comes once the download is done.
      if (mode === "install") return finishManual(`Beeblio ${version} is downloading. You will be asked to restart when it is ready.`);
      const ask = shouldOffer(version);
      finishManual(undefined);
      if (ask) void offerDownload(version);
    });

    updater.on("update-downloaded", ({ version }) => {
      deps.log(`Update ${version} downloaded`);
      ready = version;
      if (shouldOffer(version)) void offerRestart(version);
    });

    updater.on("update-not-available", () => finishManual("You have the latest version."));

    updater.on("error", (error) => {
      deps.log(`Update check failed: ${error.stack ?? error.message}`);
      // A background check that fails (offline, private repository) stays silent; it is retried on the next interval.
      if (manualCheck) finishManual(`Could not check for updates. ${describeCheckFailure(error)}`);
    });
  }

  const check = () => {
    void updater.checkForUpdates().catch(() => {
      // Reported through the "error" event.
    });
  };

  return {
    /** Starts the periodic background checks; call once the app is running. */
    schedule() {
      if (mode === "off") return;
      const later = deps.setTimeout ?? setTimeout;
      const every = deps.setInterval ?? setInterval;
      later(check, FIRST_CHECK_DELAY_MS);
      every(check, CHECK_INTERVAL_MS);
    },

    /** "Check for Updates…": always tells the person what happened. */
    async checkNow(): Promise<void> {
      if (mode === "off") {
        await deps.ask({ message: "Updates are not available here", detail: "Only the installed app updates itself.", buttons: ["OK"] });
        return;
      }
      // Already downloaded: checking again would only report "downloading".
      if (ready) return offerRestart(ready);
      if (manualCheck) return;
      const result = await new Promise<string | undefined>((resolve) => {
        manualCheck = { resolve };
        check();
      });
      // undefined: the "update available" prompt has already been shown.
      if (!result) return;
      const failed = result.startsWith("Could not");
      await deps.ask({ message: failed ? "Update check failed" : "Updates", detail: result, buttons: ["OK"], type: failed ? "warning" : "info" });
    },
  };
}
