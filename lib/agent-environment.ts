import { existsSync } from "node:fs";
import path from "node:path";

import { appRoot } from "./app-paths";
import { mergePaths } from "./path-list";

/**
 * The shell and environment the agent's commands run with. The sandbox
 * (agent/sandbox/sandbox.ts) and the System Tools check in Settings both use
 * them, so the check reports exactly what the agent will find.
 */

/** Where LibreOffice keeps soffice on macOS; its installer does not put it on PATH. */
const MAC_LIBREOFFICE = "/Applications/LibreOffice.app/Contents/MacOS";

/** Git Bash on Windows (found by the launcher), bash elsewhere. */
export function agentShell(): string {
  return process.env.BEEBLIO_BASH || "bash";
}

/** A plain map rather than NodeJS.ProcessEnv, whose Next.js typing requires NODE_ENV. */
export type Environment = Record<string, string | undefined>;

type EnvironmentOptions = {
  env?: Environment;
  platform?: NodeJS.Platform;
  root?: string;
  /** Folder of the Node.js running the servers; the desktop app bundles its own. */
  nodeDir?: string;
  exists?: (file: string) => boolean;
};

/**
 * The server's environment plus what agent commands need:
 * - Windows: a python3 shim first, because Python installs there as python
 *   or py while commands and skills call python3.
 * - macOS: LibreOffice's folder, so soffice works.
 * - Last: the servers' Node.js, so node works for the agent even where it is
 *   not installed, without overriding a Node.js the person installed.
 * - The skills folder and the Python helpers the skills refer to.
 */
export function agentEnvironment({ env = process.env, platform = process.platform, root = appRoot(), nodeDir = path.dirname(process.execPath), exists = existsSync }: EnvironmentOptions = {}): Environment {
  const paths = platform === "win32" ? path.win32 : path.posix;
  // Windows names it "Path"; writing "PATH" beside it would leave two entries that the child resolves unpredictably.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const before = platform === "win32" ? [paths.join(root, "agent", "sandbox", "shims", "win32")] : [];
  const after = [platform === "darwin" && exists(MAC_LIBREOFFICE) ? MAC_LIBREOFFICE : undefined, nodeDir];
  return {
    ...env,
    [pathKey]: mergePaths([...before, env[pathKey], ...after], paths.delimiter),
    BEEBLIO_SKILLS_DIR: paths.join(root, "agent", "skills"),
    NODE_PATH: mergePaths([paths.join(root, "node_modules"), env.NODE_PATH], paths.delimiter),
    PYTHONPATH: mergePaths([paths.join(root, "agent", "sandbox"), env.PYTHONPATH], paths.delimiter),
  };
}
