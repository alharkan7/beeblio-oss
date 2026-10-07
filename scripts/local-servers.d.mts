export type LocalServerName = "migrate" | "next" | "eve";

export interface LocalServerOptions {
  /** A source checkout, or the folder the desktop app's servers were staged into. */
  root: string;
  /**
   * `checkout` (default) runs the next and eve CLIs and reads .env.local from
   * `root`; `bundle` runs the prebuilt servers laid out by desktop/scripts/stage.mjs.
   */
  layout?: "checkout" | "bundle";
  /** Checkout only: `dev` runs the hot-reloading servers; `start` serves the production builds. */
  mode?: "dev" | "start";
  uiPort?: number;
  agentPort?: number;
  /** Node.js 24 executable that runs the servers. Defaults to the current process. */
  nodePath?: string;
  /** Writable folder for the database, settings, and workspaces. Defaults to `<root>/.beeblio`. */
  dataDir?: string;
  /** Variables added to the servers' environment, after the inherited ones. */
  extraEnv?: Record<string, string>;
  /** Receives server output; without it, output goes to this process's stdio. */
  onOutput?: (name: LocalServerName, chunk: Buffer) => void;
  /** Called when a server exits or fails to spawn before `stop()` was called. */
  onExit?: (name: LocalServerName, code: number | NodeJS.Signals | null, error?: Error) => void;
}

export interface LocalServers {
  uiUrl: string;
  agentUrl: string;
  dataDir: string;
  /** Setup problems that do not stop the servers, such as a missing Git Bash on Windows. */
  warnings: string[];
  waitUntilReady(options?: { timeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
}

export function startLocalServers(options: LocalServerOptions): Promise<LocalServers>;

/** Commands to run before `mode: "start"` can serve production builds. */
export function missingProductionBuilds(root: string): string[];

/**
 * Stops a child process and everything it spawned, escalating to a forced
 * kill; always settles. On macOS and Linux it reaches grandchildren only if
 * the child was spawned with `detached: true`.
 */
export function terminate(child: import("node:child_process").ChildProcess): Promise<void>;
