// Bundles the main process and the preload script into dist/.
//
// Bundling, rather than compiling file by file, is what lets the installed
// app run: main.ts imports the shared launcher (../scripts/local-servers.mjs)
// and its dependencies from the repository, none of which exist inside the
// packaged app. Type checking is separate (pnpm typecheck), as esbuild only
// strips types.
import { rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const desktop = path.resolve(import.meta.dirname, "..");
const dist = path.join(desktop, "dist");
const shared = { bundle: true, platform: "node", target: "node24", external: ["electron"], sourcemap: true, logLevel: "warning" };

rmSync(dist, { recursive: true, force: true });
await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(desktop, "src", "main.ts")],
    outfile: path.join(dist, "main.js"),
    format: "esm",
    // Bundled CommonJS dependencies such as dotenv call require(), which an ES
    // module does not have; give them one.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  }),
  // Preload scripts in a sandboxed renderer must be single CommonJS files.
  ...["preload", "picker-preload"].map((name) => build({ ...shared, entryPoints: [path.join(desktop, "src", `${name}.cts`)], outfile: path.join(dist, `${name}.cjs`), format: "cjs" })),
]);
