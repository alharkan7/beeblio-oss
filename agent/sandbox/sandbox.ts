import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { defineSandbox, type SandboxBackend, type SandboxSession, type SandboxProcess, type SandboxRunOptions } from "eve/sandbox";
import { getWorkspaceIdentity } from "../workspace-paths";
import { projectFolder } from "../../lib/workspace-files";
import { agentEnvironment, agentShell } from "../../lib/agent-environment";

type SessionOptions = { folder: string };
const processes = new Map<string, Set<ReturnType<typeof spawn>>>();
function makeSession(sessionKey: string, state: { folder?: string }): SandboxSession {
  function folder(): string { if (!state.folder) throw new Error("Project folder is not bound to the agent sandbox"); return state.folder; }
  async function safePath(input: string): Promise<string> {
    const relative = input.startsWith("/workspace/") ? input.slice(11) : input === "/workspace" ? "" : input;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === "..")) throw new Error("Sandbox file path must stay in /workspace");
    const root = folder(); const absolute = path.resolve(root, relative);
    const nearest = async (candidate: string): Promise<string> => { try { return await fs.realpath(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return nearest(path.dirname(candidate)); } };
    const real = await nearest(absolute);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error("Sandbox path escapes project folder");
    return absolute;
  }
  const readBinaryFile = async ({ path: input }: { path: string }) => { try { return new Uint8Array(await fs.readFile(await safePath(input))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } };
  const writeBinaryFile = async ({ path: input, content }: { path: string; content: Uint8Array }) => { const absolute = await safePath(input); await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content); };
  const launch = async (options: SandboxRunOptions): Promise<SandboxProcess> => {
    const root = folder();
    const workingDirectory = options.workingDirectory ? await safePath(options.workingDirectory) : root;
    const command = options.command.replace(/\/workspace(?=\/|\b)/g, '"${BEEBLIO_PROJECT_DIR}"');
    const child = spawn(agentShell(), ["-lc", command], {
      cwd: workingDirectory,
      env: {
        ...(agentEnvironment() as NodeJS.ProcessEnv),
        ...options.env,
        BEEBLIO_PROJECT_DIR: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.abortSignal,
    });
    const live = processes.get(sessionKey) || new Set(); live.add(child); processes.set(sessionKey, live);
    child.once("close", () => live.delete(child));
    const finished = new Promise<{ exitCode: number }>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve({ exitCode: code ?? 1 })); });
    return {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => finished,
      kill: async () => { child.kill("SIGTERM"); },
    };
  };
  return {
    id: sessionKey,
    resolvePath: (input) => input.startsWith("/") ? input : path.posix.join("/workspace", input),
    readBinaryFile,
    readFile: async (options) => { const bytes = await readBinaryFile(options); return bytes === null ? null : new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }); },
    readTextFile: async (options) => { const bytes = await readBinaryFile(options); if (bytes === null) return null; const text = new TextDecoder(options.encoding || "utf-8", { fatal: options.encoding === "utf-8" }).decode(bytes); return options.startLine || options.endLine ? text.split("\n").slice((options.startLine || 1) - 1, options.endLine).join("\n") : text; },
    writeBinaryFile,
    writeTextFile: async (options) => writeBinaryFile({ ...options, content: Buffer.from(options.content, options.encoding as BufferEncoding || "utf8") }),
    writeFile: async (options) => { const bytes = new Uint8Array(await new Response(options.content).arrayBuffer()); await writeBinaryFile({ ...options, content: bytes }); },
    spawn: launch,
    run: async (options) => { const child = await launch(options); const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.wait()]); return { ...status, stdout, stderr }; },
    setNetworkPolicy: async () => {},
    removePath: async (options) => { await fs.rm(await safePath(options.path), { recursive: options.recursive, force: options.force }); },
  } as SandboxSession;
}
export function localProjectBackend(): SandboxBackend<Record<string, never>, SessionOptions> {
  return {
    name: "beeblio-local-project-v2",
    prewarm: async () => ({ reused: true }),
    create: async (input) => {
      const state: { folder?: string } = { folder: typeof input.existingMetadata?.folder === "string" ? input.existingMetadata.folder : undefined };
      const session = makeSession(input.sessionKey, state);
      return {
        session,
        useSessionFn: async (options) => { if (options?.folder) state.folder = await fs.realpath(options.folder); return session; },
        captureState: async () => ({ backendName: "beeblio-local-project-v2", sessionKey: input.sessionKey, metadata: { folder: state.folder } }),
        delete: async () => { for (const child of processes.get(input.sessionKey) || []) child.kill("SIGTERM"); },
        stop: async () => { for (const child of processes.get(input.sessionKey) || []) child.kill("SIGTERM"); },
        shutdown: async () => { for (const child of processes.get(input.sessionKey) || []) child.kill("SIGTERM"); },
      };
    },
  };
}

export default defineSandbox({
  backend: localProjectBackend,
  async onSession({ use: activateSandbox, ctx }) {
    const auth = ctx.session.auth.current;
    const identity = getWorkspaceIdentity({ principalId: auth?.principalId, projectSlug: auth?.attributes?.projectSlug, sessionId: ctx.session.id });
    await activateSandbox({ folder: await projectFolder(identity.userId, identity.projectSlug) });
  },
});
