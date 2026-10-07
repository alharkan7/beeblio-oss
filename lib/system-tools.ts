import { execFile } from "node:child_process";

import { agentEnvironment, agentShell, type Environment } from "./agent-environment";

/**
 * Programs on the person's computer that the agent runs. The installed app
 * cannot ship them, and a missing one otherwise shows up only as a failed
 * agent command, so Settings lists them with how to install what is missing.
 * Each check runs through the agent's own shell and environment.
 */

/** Shown for a missing tool: a link (its text is the link), or a text followed by a command to copy. */
export type InstallHint = { text: string; command?: string; href?: string };

export type SystemTool = {
  id: string;
  label: string;
  purpose: string;
  /** Program that must be on PATH; looked up first because a pipeline's status is its last command's. */
  binary: string;
  /** Shell snippet that prints a version (or path). */
  check: string;
  hints: Partial<Record<NodeJS.Platform, InstallHint>> & { default: InstallHint };
};

export type SystemToolStatus = { id: string; label: string; purpose: string; found: boolean; detail?: string; hint?: InstallHint };

const CHECK_TIMEOUT_MS = 5000;
const pip = (packages: string): InstallHint => ({ text: "Install it with pip:", command: `python3 -m pip install ${packages}` });

export const SYSTEM_TOOLS: readonly SystemTool[] = [
  {
    id: "shell",
    label: "Shell",
    purpose: "Runs every command the agent uses.",
    binary: "sh",
    check: 'printf "%s" "${BASH_VERSION:-sh}"',
    hints: { win32: { text: "Install Git for Windows (it includes Git Bash), then restart Beeblio", href: "https://git-scm.com/download/win" }, default: { text: "Install bash with your system's package manager." } },
  },
  {
    id: "python3",
    label: "Python 3",
    purpose: "Data analysis, statistics, and file conversions.",
    binary: "python3",
    check: 'python3 -c "import sys; print(sys.version.split()[0])"',
    hints: { darwin: { text: "Install it with Homebrew:", command: "brew install python" }, win32: { text: "Install Python and select \"Add python.exe to PATH\"", href: "https://www.python.org/downloads/" }, default: { text: "Install Python 3 with your system's package manager." } },
  },
  {
    id: "pandas",
    label: "pandas",
    purpose: "Tables and statistics in Python; Beeblio's research helper needs it.",
    binary: "python3",
    check: 'python3 -c "import pandas; print(pandas.__version__)"',
    hints: { default: pip("pandas") },
  },
  {
    id: "python-docx",
    label: "python-docx",
    purpose: "Reading and writing Word documents in Python.",
    binary: "python3",
    check: 'python3 -c "import docx; print(\'installed\')"',
    hints: { default: pip("python-docx") },
  },
  {
    id: "pandoc",
    label: "Pandoc",
    purpose: "LaTeX and Word export.",
    binary: "pandoc",
    check: "pandoc --version | head -n 1",
    hints: { darwin: { text: "Install it with Homebrew:", command: "brew install pandoc" }, default: { text: "Download Pandoc", href: "https://pandoc.org/installing.html" } },
  },
  {
    id: "libreoffice",
    label: "LibreOffice",
    purpose: "Checking and converting Office files.",
    // Only the path: soffice --version starts the whole suite, which can take longer than the check allows.
    binary: "soffice",
    check: "command -v soffice",
    hints: { darwin: { text: "Install it with Homebrew:", command: "brew install --cask libreoffice" }, default: { text: "Download LibreOffice", href: "https://www.libreoffice.org/download/download-libreoffice/" } },
  },
  {
    id: "ffmpeg",
    label: "FFmpeg",
    purpose: "Audio and video processing.",
    binary: "ffmpeg",
    check: "ffmpeg -version | head -n 1",
    hints: { darwin: { text: "Install it with Homebrew:", command: "brew install ffmpeg" }, default: { text: "Download FFmpeg", href: "https://ffmpeg.org/download.html" } },
  },
  {
    id: "pdftotext",
    label: "Poppler (pdftotext)",
    purpose: "Extracting text from PDFs.",
    binary: "pdftotext",
    check: "pdftotext -v 2>&1 | head -n 1",
    hints: { darwin: { text: "Install it with Homebrew:", command: "brew install poppler" }, default: { text: "Download Poppler", href: "https://poppler.freedesktop.org/" } },
  },
  {
    id: "tesseract",
    label: "Tesseract",
    purpose: "Reading text in scanned PDFs and images (OCR).",
    binary: "tesseract",
    check: "tesseract --version 2>&1 | head -n 1",
    hints: { darwin: { text: "Install it with Homebrew:", command: "brew install tesseract" }, default: { text: "Install Tesseract", href: "https://tesseract-ocr.github.io/tessdoc/Installation.html" } },
  },
];

type CheckOptions = { shell?: string; env?: Environment; platform?: NodeJS.Platform; tools?: readonly SystemTool[] };

/** Checks every tool at once; each check has its own time limit, so one slow tool cannot hold up the rest. */
export async function checkSystemTools({ shell = agentShell(), env = agentEnvironment(), platform = process.platform, tools = SYSTEM_TOOLS }: CheckOptions = {}): Promise<SystemToolStatus[]> {
  // The launcher sets BEEBLIO_BASH only after finding Git Bash. Without it,
  // "bash" on Windows would be WSL's, which agent commands do not use.
  if (platform === "win32" && !env.BEEBLIO_BASH) {
    return tools.map((tool) => ({
      id: tool.id,
      label: tool.label,
      purpose: tool.purpose,
      found: false,
      hint: tool.id === "shell" ? (tool.hints.win32 ?? tool.hints.default) : { text: "Install Git for Windows first; the other tools are checked with its Git Bash." },
    }));
  }
  return Promise.all(
    tools.map(async (tool) => {
      // exit 127 is what a shell returns for a missing command.
      const output = await run(shell, `command -v ${tool.binary} >/dev/null 2>&1 || exit 127; ${tool.check}`, env);
      const found = output !== undefined && !isStorePlaceholder(output);
      const status: SystemToolStatus = { id: tool.id, label: tool.label, purpose: tool.purpose, found };
      if (found) status.detail = output || undefined;
      else status.hint = tool.hints[platform] ?? tool.hints.default;
      return status;
    }),
  );
}

/** Trimmed first line of output, or undefined when the command fails, times out, or the shell is missing. */
function run(shell: string, script: string, env: Environment): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(shell, ["-lc", script], { env: env as NodeJS.ProcessEnv, timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "");
    });
  });
}

/** Windows' "python3" placeholder lives in WindowsApps and only opens the Microsoft Store. */
function isStorePlaceholder(output: string): boolean {
  return /\\WindowsApps\\/i.test(output);
}
