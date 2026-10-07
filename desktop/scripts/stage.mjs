// Assembles the servers the installed app ships into desktop/build/bundle/,
// which electron-builder copies to the app's resources (see
// electron-builder.config.cjs). The layout is what startLocalServers expects
// for `layout: "bundle"`:
//
//   ui/       Next.js standalone server, its static files, and migrate.mjs
//   agent/    Eve's built server (.output)
//   app/      agent/skills and agent/sandbox, read by both servers (BEEBLIO_APP_ROOT)
//   drizzle/  SQLite migrations
//   node/     the Node.js 24 binary that runs all of the above
//   parent-watchdog.mjs  stops the servers if the app dies (see scripts/)
//
// Run it after a flat install, `BEEBLIO_STANDALONE=1 pnpm build`, and
// `pnpm build:eve` in the repository root, all with pnpm_config_node_linker=hoisted
// in the environment: pnpm checks dependencies before each script, and with
// only an install flag it would put them back in the linked layout. The Node.js binary is the one running this script, so the
// native modules installed for it (better-sqlite3, sharp) match.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const bundle = path.join(desktop, "build", "bundle");
const REQUIRED_NODE_MAJOR = 24;

/**
 * Names that hold someone's data or secrets. Finding one in the bundle means
 * file tracing or a copy step picked up the build machine's files, and the
 * installer would hand them to everyone who downloads it.
 */
const FORBIDDEN_NAMES = new Set([".beeblio", ".git", "settings.json", "credentials.json", "agent-secret", ".workflow-data"]);
const FORBIDDEN_PATTERNS = [/^\.env(\..*)?$/, /\.sqlite(-wal|-shm)?$/];

function fail(message) {
  console.error(`stage: ${message}`);
  process.exit(1);
}

function requireFile(file, hint) {
  if (!existsSync(file)) fail(`${path.relative(repo, file)} is missing. ${hint}`);
}

/**
 * Copies a file or folder with every symbolic link replaced by what it points
 * to. pnpm links packages, Next.js links external modules, and an installer
 * would ship those links pointing at the build machine's folders (Node's
 * cpSync keeps nested links even with `dereference`). `filter` gets the
 * source path; `seen` holds the real folders on the current branch, so a
 * link back to a parent cannot recurse forever.
 */
function copy(from, to, filter = () => true, seen = new Set()) {
  if (!filter(from)) return;
  const real = realpathSync(from);
  const stats = statSync(real);
  if (stats.isDirectory()) {
    if (seen.has(real)) fail(`${from} links back to a folder that contains it.`);
    mkdirSync(to, { recursive: true });
    const branch = new Set(seen).add(real);
    for (const entry of readdirSync(real)) copy(path.join(from, entry), path.join(to, entry), filter, branch);
  } else {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(real, to);
    chmodSync(to, stats.mode);
  }
}

/** Every path in the bundle that must not ship, relative to the bundle: local data, secrets, and leftover links. */
function forbiddenFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(`${path.relative(bundle, file)} (symbolic link)`);
    else if (FORBIDDEN_NAMES.has(entry.name) || FORBIDDEN_PATTERNS.some((pattern) => pattern.test(entry.name))) found.push(path.relative(bundle, file));
    else if (entry.isDirectory()) forbiddenFiles(file, found);
  }
  return found;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
// The Mac app is built for Apple Silicon only (electron-builder.config.cjs); an Intel
// Node.js here would ship x64 native modules inside an arm64 app.
if (process.platform === "darwin" && process.arch !== "arm64") fail(`the Mac app is Apple Silicon only; run this on an Apple Silicon Mac with an arm64 Node.js (this is ${process.arch}).`);
if (nodeMajor !== REQUIRED_NODE_MAJOR) fail(`run this with Node.js ${REQUIRED_NODE_MAJOR}; it ships the Node.js binary running it, and this is ${process.version}.`);
requireFile(path.join(repo, ".next", "standalone", "server.js"), "Build the UI with BEEBLIO_STANDALONE=1 pnpm build in the repository root.");
requireFile(path.join(repo, ".output", "server", "index.mjs"), "Build the agent with pnpm build:eve in the repository root.");
// With pnpm's default layout, packages find their dependencies only through
// links into node_modules/.pnpm. Resolved into copies, as an installer needs,
// they can no longer find them, so the UI must come from a flat install.
if (existsSync(path.join(repo, ".next", "standalone", "node_modules", ".pnpm"))) {
  fail(`the standalone build uses pnpm's linked node_modules, which cannot be packaged. Set the flat layout for the whole shell session (not as an install flag, which the next pnpm script undoes), then reinstall and rebuild:
  export pnpm_config_node_linker=hoisted   (PowerShell: $env:pnpm_config_node_linker="hoisted")
  pnpm install --frozen-lockfile
  BEEBLIO_STANDALONE=1 pnpm build`);
}

rmSync(bundle, { recursive: true, force: true });
mkdirSync(bundle, { recursive: true });

// UI: the standalone server expects its static files and public/ next to it.
const ui = path.join(bundle, "ui");
copy(path.join(repo, ".next", "standalone"), ui);
copy(path.join(repo, ".next", "static"), path.join(ui, ".next", "static"));
copy(path.join(repo, "public"), path.join(ui, "public"));
// The migration runs before the servers, with the UI's better-sqlite3. drizzle-orm
// is bundled into the UI's chunks rather than installed, so it is copied in; it
// has no dependencies of its own.
copy(path.join(repo, "scripts", "migrate.mjs"), path.join(ui, "migrate.mjs"));
copy(realpathSync(path.join(repo, "node_modules", "drizzle-orm")), path.join(ui, "node_modules", "drizzle-orm"));
requireFile(path.join(ui, "node_modules", "better-sqlite3", "package.json"), "The standalone build did not include better-sqlite3.");

// Agent: Eve's build is self-contained apart from the files below.
copy(path.join(repo, ".output"), path.join(bundle, "agent"));
copy(path.join(repo, "agent", "skills"), path.join(bundle, "app", "agent", "skills"));
// Only the Python helpers; the TypeScript there is compiled into the agent.
copy(path.join(repo, "agent", "sandbox"), path.join(bundle, "app", "agent", "sandbox"), (file) => statSync(file).isDirectory() || !/\.tsx?$/.test(file));
copy(path.join(repo, "drizzle"), path.join(bundle, "drizzle"));
copy(path.join(repo, "scripts", "parent-watchdog.mjs"), path.join(bundle, "parent-watchdog.mjs"));

const nodeBinary = path.join(bundle, "node", path.basename(process.execPath));
copy(process.execPath, nodeBinary);

const forbidden = forbiddenFiles(bundle);
if (forbidden.length) {
  rmSync(bundle, { recursive: true, force: true });
  fail(`refusing to package local data, secrets, or links:\n  ${forbidden.join("\n  ")}\nExclude them from the build (see outputFileTracingExcludes in next.config.ts).`);
}

// Read by the app's About details and in bug reports.
const { version } = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify({ version, node: process.version, platform: process.platform, arch: process.arch, stagedAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`stage: bundle ready in ${path.relative(repo, bundle)} (Node.js ${process.version}, ${process.platform}-${process.arch})`);
