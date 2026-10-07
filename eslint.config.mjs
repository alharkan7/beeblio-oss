import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The React Compiler rules flag existing editor lifecycle and dynamic component
      // patterns. Keep the Rules of Hooks and dependency checks active; adopt the
      // compiler-specific rules after behavior-focused editor refactors.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/static-components": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
      // Workspace previews frequently use local object URLs and inline assets.
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  globalIgnores([
    ".next/**",
    ".eve/**",
    ".output/**",
    ".beeblio/**",
    "desktop/dist/**",
    "next-env.d.ts",
  ]),
]);
