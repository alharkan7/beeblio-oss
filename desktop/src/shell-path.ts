import { execFile } from "node:child_process";
import path from "node:path";

import { mergePaths } from "../../lib/path-list";

/**
 * macOS starts apps opened from Finder or the Dock with a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), not the one a terminal gets from the
 * user's shell profile. The agent runs python3, pandoc, soffice, and other
 * tools that usually live in Homebrew or similar folders, so the app asks
 * the login shell for its PATH once at startup.
 *
 * Kept free of Electron imports so the parsing can be unit-tested with Node.
 */

const START = "__BEEBLIO_PATH_START__";
const END = "__BEEBLIO_PATH_END__";
/** Where Homebrew installs on Apple Silicon and Intel Macs; used when the shell cannot be asked. */
const COMMON_TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Finds the PATH between the markers. Interactive shells may print banners or
 * prompts around it (oh-my-zsh update notices, for example), so only the
 * marked text counts.
 */
export function extractMarkedPath(output: string): string | undefined {
  const start = output.lastIndexOf(START);
  if (start === -1) return undefined;
  const end = output.indexOf(END, start + START.length);
  if (end === -1) return undefined;
  const value = output.slice(start + START.length, end).trim();
  return value || undefined;
}

/**
 * The login shell's PATH merged with the current one, or the current one plus
 * the usual Homebrew folders if the shell fails or takes longer than
 * `timeoutMs` (a profile can wait for input or a slow network mount).
 */
export async function loginShellPath({ shell = process.env.SHELL || "/bin/zsh", currentPath = process.env.PATH, timeoutMs = 5000 } = {}): Promise<string> {
  // printenv rather than echo $PATH: fish prints $PATH as a space-separated list.
  const script = `printf '%s' '${START}'; printenv PATH; printf '%s' '${END}'`;
  const output = await new Promise<string | undefined>((resolve) => {
    execFile(shell, ["-ilc", script], { timeout: timeoutMs, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } }, (error, stdout) => resolve(error ? undefined : stdout));
  });
  const fromShell = output === undefined ? undefined : extractMarkedPath(output);
  return fromShell ? mergePaths([fromShell, currentPath], path.delimiter) : mergePaths([currentPath, ...COMMON_TOOL_DIRS], path.delimiter);
}
