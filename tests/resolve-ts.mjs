// The app imports TypeScript modules without extensions, as its bundlers
// allow. Node's built-in TypeScript support needs the extension, so tests load
// this hook (see "test" in package.json) to retry such imports with ".ts".
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !relative || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
