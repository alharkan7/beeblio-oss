import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";

export type WorkspaceFileEntry = { name: string; path: string; isDir: boolean; size: number };
export type WorkspaceRootTree = { entries: WorkspaceFileEntry[]; children: Record<string, WorkspaceFileEntry[]> };
export type StorageUsage = { usedBytes: number; quotaBytes: number | null };
export class WorkspaceFileError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = "WorkspaceFileError"; }
}
export { WorkspaceFileError as AgentWorkspaceError };
export const WORKSPACE_MARKER_FILENAME = ".bee-workspace.json";
const invalid = (message: string): never => { throw new WorkspaceFileError(message, 400, "invalid_workspace_request"); };
const missing = (): never => { throw new WorkspaceFileError("Workspace path was not found", 404, "workspace_path_not_found"); };
const exists = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function projectFolder(userId: string, slug: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(userId) || !/^[A-Za-z0-9_-]+$/.test(slug)) invalid("Invalid workspace identity");
  if (slug === "skills") {
    const skills = path.resolve(process.cwd(), ".beeblio", "skills");
    await fs.mkdir(skills, { recursive: true });
    return fs.realpath(skills);
  }
  const project = await db.query.projects.findFirst({ where: and(eq(projects.userId, userId), eq(projects.slug, slug)) });
  if (!project) return missing();
  const folder = path.resolve(project.folderPath || path.join(process.cwd(), ".beeblio", "workspaces", slug));
  try { return await fs.realpath(folder); } catch (error) { if (exists(error)) missing(); throw error; }
}

function normalize(input: string, rootAllowed = false): string {
  if (input.includes("\0")) invalid("Invalid workspace path");
  let relative = input.trim();
  if (relative.startsWith("./")) relative = relative.slice(2);
  else relative = relative.replace(/^\/+/, "").replace(/^workspace\//, "");
  relative = relative.replace(/\/+$/, "");
  if (!relative && rootAllowed) return "";
  if (!relative || relative.length > 1024 || relative.split("/").some((s) => !s || s === "." || s === ".." || s === WORKSPACE_MARKER_FILENAME)) invalid("Invalid workspace path");
  return relative;
}
async function resolve(userId: string, slug: string, rel: string, rootAllowed = false): Promise<{ root: string; absolute: string; relative: string }> {
  const root = await projectFolder(userId, slug);
  const relative = normalize(rel, rootAllowed);
  const absolute = path.join(root, relative);
  let parent = absolute;
  while (true) {
    try {
      const real = await fs.realpath(parent);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) invalid("Workspace path escapes the project folder");
      break;
    } catch (error) {
      if (!exists(error)) throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  return { root, absolute, relative };
}
function entry(relative: string, stat: { isDirectory(): boolean; size: number }): WorkspaceFileEntry {
  return { name: path.basename(relative), path: relative.replaceAll(path.sep, "/"), isDir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size };
}
const sort = (a: WorkspaceFileEntry, b: WorkspaceFileEntry) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1;
export async function listWorkspaceFiles(userId: string, slug: string, workspacePath = ""): Promise<WorkspaceFileEntry[]> {
  const { absolute, relative } = await resolve(userId, slug, workspacePath, true);
  let children: string[];
  try { children = await fs.readdir(absolute); } catch (error) { if (exists(error)) missing(); throw error; }
  const result = await Promise.all(children.filter((name) => name !== WORKSPACE_MARKER_FILENAME).map(async (name) => {
    const child = path.posix.join(relative, name);
    const { absolute: safe } = await resolve(userId, slug, child);
    return entry(child, await fs.stat(safe));
  }));
  return result.sort(sort);
}
export async function listWorkspaceFilesRecursive(userId: string, slug: string, maxEntries: number): Promise<{ entries: WorkspaceFileEntry[]; truncated: boolean }> {
  const entries: WorkspaceFileEntry[] = [];
  const visit = async (rel: string): Promise<void> => {
    for (const item of await listWorkspaceFiles(userId, slug, rel)) {
      entries.push(item);
      if (entries.length > maxEntries) return;
      if (item.isDir) await visit(item.path);
      if (entries.length > maxEntries) return;
    }
  };
  await visit("");
  return { entries: entries.slice(0, maxEntries), truncated: entries.length > maxEntries };
}
export async function listWorkspaceRootTree(userId: string, slug: string): Promise<WorkspaceRootTree> {
  const entries = await listWorkspaceFiles(userId, slug);
  const children: Record<string, WorkspaceFileEntry[]> = {};
  await Promise.all(entries.filter((e) => e.isDir).map(async (e) => { children[e.path] = await listWorkspaceFiles(userId, slug, e.path); }));
  return { entries, children };
}
export async function globWorkspaceFiles(userId: string, slug: string, workspacePath: string, pattern: string, limit: number) {
  const all = await listWorkspaceFilesRecursive(userId, slug, 100000);
  const prefix = normalize(workspacePath, true);
  const matches = all.entries.filter((e) => !e.isDir && (!prefix || e.path.startsWith(`${prefix}/`)) && (path.posix.matchesGlob(e.path, pattern) || (!pattern.includes("/") && path.posix.matchesGlob(e.name, pattern))));
  return { entries: matches.slice(0, limit), truncated: all.truncated || matches.length > limit };
}
export function workspaceFileEtag(generation: string | number, size: string | number): string { return `\"${generation}-${size}\"`; }
export async function statWorkspaceFile(userId: string, slug: string, workspacePath: string) {
  const { absolute, relative } = await resolve(userId, slug, workspacePath);
  try {
    const stat = await fs.stat(absolute);
    const generation = String(Math.floor(stat.mtimeMs * 1000));
    return { ...entry(relative, stat), etag: workspaceFileEtag(generation, stat.size), generation, updatedAt: stat.mtime.toISOString() };
  } catch (error) { if (exists(error)) missing(); throw error; }
}
export async function readWorkspaceFile(userId: string, slug: string, workspacePath: string) {
  const { absolute } = await resolve(userId, slug, workspacePath);
  const stat = await statWorkspaceFile(userId, slug, workspacePath);
  if (stat.isDir) invalid("Cannot read a directory");
  return { content: await fs.readFile(absolute), etag: stat.etag, generation: stat.generation, updatedAt: stat.updatedAt };
}
export async function writeWorkspaceFile(userId: string, slug: string, workspacePath: string, content: Uint8Array, options?: { contentType?: string; ifGenerationMatch?: string | number }) {
  const { absolute } = await resolve(userId, slug, workspacePath);
  let prior: Awaited<ReturnType<typeof statWorkspaceFile>> | null = null;
  try { prior = await statWorkspaceFile(userId, slug, workspacePath); } catch (error) { if (!(error instanceof WorkspaceFileError) || error.status !== 404) throw error; }
  if (prior?.isDir) invalid("Cannot overwrite a directory");
  if (options?.ifGenerationMatch !== undefined && String(options.ifGenerationMatch) !== (prior?.generation ?? "0")) throw new WorkspaceFileError("The workspace file changed after it was read", 409, "workspace_generation_mismatch");
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return { existed: !!prior };
}
export async function createWorkspaceDirectory(userId: string, slug: string, workspacePath: string) { const { absolute } = await resolve(userId, slug, workspacePath); await fs.mkdir(absolute, { recursive: true }); }
export async function deleteWorkspacePath(userId: string, slug: string, workspacePath: string) { const { absolute } = await resolve(userId, slug, workspacePath); await fs.rm(absolute, { recursive: true, force: false }); }
async function transfer(userId: string, slug: string, source: string, destination: string, move: boolean) {
  const src = await resolve(userId, slug, source); const dst = await resolve(userId, slug, destination);
  if (dst.absolute === src.absolute || dst.absolute.startsWith(`${src.absolute}${path.sep}`)) invalid("A directory cannot be copied or moved into itself");
  await fs.access(src.absolute).catch((e) => { if (exists(e)) missing(); throw e; });
  if (await fs.stat(dst.absolute).then(() => true, () => false)) throw new WorkspaceFileError("Destination already exists", 409, "workspace_path_exists");
  await fs.mkdir(path.dirname(dst.absolute), { recursive: true });
  if (move) await fs.rename(src.absolute, dst.absolute); else await fs.cp(src.absolute, dst.absolute, { recursive: true, errorOnExist: true, force: false });
}
export async function moveWorkspacePath(userId: string, slug: string, source: string, destination: string) { await transfer(userId, slug, source, destination, true); }
export async function copyWorkspacePath(userId: string, slug: string, source: string, destination: string) { await transfer(userId, slug, source, destination, false); }
export async function readWorkspaceFileAsResponse(userId: string, slug: string, workspacePath: string, options?: { ifNoneMatch?: string; range?: string }): Promise<Response> {
  const stat = await statWorkspaceFile(userId, slug, workspacePath);
  if (stat.isDir) invalid("Cannot read a directory");
  const headers = new Headers({ ETag: stat.etag, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
  if (options?.ifNoneMatch === stat.etag) return new Response(null, { status: 304, headers });
  const file = await readWorkspaceFile(userId, slug, workspacePath);
  headers.set("ETag", file.etag);
  const match = options?.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (match) {
    const start = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), file.content.length - 1) : file.content.length - 1;
    if (start >= file.content.length || end < start) return new Response(null, { status: 416, headers: { ...Object.fromEntries(headers), "Content-Range": `bytes */${file.content.length}` } });
    headers.set("Content-Range", `bytes ${start}-${end}/${file.content.length}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(new Uint8Array(file.content.subarray(start, end + 1)), { status: 206, headers });
  }
  headers.set("Content-Length", String(file.content.length));
  return new Response(new Uint8Array(file.content), { status: 200, headers });
}
export async function getWorkspaceFileFingerprint(userId: string, slug: string, workspacePath: string) {
  const stat = await statWorkspaceFile(userId, slug, workspacePath);
  return { etag: stat.etag, size: String(stat.size), updated: stat.updatedAt, generation: stat.generation };
}
export function invalidateUserStorageCache(_userId: string): void {}
export async function getWorkspaceStorageUsage(userId: string): Promise<number> {
  const owned = await db.query.projects.findMany({ where: eq(projects.userId, userId) });
  let total = 0;
  for (const project of owned) { const files = await listWorkspaceFilesRecursive(userId, project.slug, 100000); total += files.entries.reduce((sum, file) => sum + file.size, 0); }
  return total;
}
export async function getUserStorageUsage(userId: string): Promise<StorageUsage> { return { usedBytes: await getWorkspaceStorageUsage(userId), quotaBytes: null }; }
export async function assertStorageQuota(_userId: string, _additionalBytes: number, _replacedBytes = 0): Promise<void> {}
export const listAgentWorkspaceFiles = listWorkspaceFiles;
export const getAgentWorkspaceRootTree = listWorkspaceRootTree;
export async function listAgentWorkspaceFilesRecursive(userId: string, slug: string, maxEntries: number) { return (await listWorkspaceFilesRecursive(userId, slug, maxEntries)).entries; }
export const readAgentWorkspaceFile = readWorkspaceFileAsResponse;
export async function readAgentWorkspaceTextOrNull(userId: string, slug: string, workspacePath: string): Promise<string | null> {
  try { return (await readWorkspaceFile(userId, slug, workspacePath)).content.toString("utf8"); }
  catch (error) { if (error instanceof WorkspaceFileError && error.status === 404) return null; throw error; }
}
export async function writeAgentWorkspaceFile(userId: string, slug: string, workspacePath: string, content: BodyInit): Promise<unknown> {
  return writeWorkspaceFile(userId, slug, workspacePath, Buffer.from(await new Response(content).arrayBuffer()));
}
export const deleteAgentWorkspacePath = deleteWorkspacePath;
export const createAgentWorkspaceDirectory = createWorkspaceDirectory;
export const moveAgentWorkspacePath = moveWorkspacePath;
export const copyAgentWorkspacePath = copyWorkspacePath;
export async function getAgentStorageUsage(userId: string): Promise<StorageUsage> { return getUserStorageUsage(userId); }

import { createHmac, timingSafeEqual } from "node:crypto";
import { localAgentSecret } from "./local-secret";
function signedPath(userId: string, slug: string, workspacePath: string, ttlMs: number, options: Record<string, string>) {
  const payload = Buffer.from(JSON.stringify({ userId, slug, workspacePath, expiresAt: Date.now() + ttlMs, ...options })).toString("base64url");
  const signature = createHmac("sha256", localAgentSecret()).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt: Date.now() + ttlMs };
}
export function verifyWorkspaceTicket(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) invalid("Invalid file ticket");
  const expected = createHmac("sha256", localAgentSecret()).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) invalid("Invalid file ticket");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { userId: string; slug: string; workspacePath: string; expiresAt: number; disposition?: string; filename?: string; method?: string };
  if (Date.now() > claims.expiresAt) throw new WorkspaceFileError("File ticket expired", 403, "ticket_expired");
  return claims;
}
export async function createWorkspaceReadTicket(userId: string, slug: string, workspacePath: string, options?: { ttlMs?: number; disposition?: "inline" | "attachment"; filename?: string }) {
  await statWorkspaceFile(userId, slug, workspacePath);
  const { token, expiresAt } = signedPath(userId, slug, workspacePath, options?.ttlMs ?? 15 * 60_000, { disposition: options?.disposition || "inline", filename: options?.filename || path.basename(workspacePath) });
  return { url: `/api/workspace/local-file?token=${encodeURIComponent(token)}`, expiresAt };
}
export async function createWorkspaceUploadTicket(userId: string, slug: string, workspacePath: string, options?: { contentType?: string; sizeBytes?: number; ttlMs?: number }) {
  const { token, expiresAt } = signedPath(userId, slug, workspacePath, options?.ttlMs ?? 15 * 60_000, { method: "POST" });
  return { uploadUrl: `/api/workspace/local-file?token=${encodeURIComponent(token)}`, fields: {}, expiresAt };
}
