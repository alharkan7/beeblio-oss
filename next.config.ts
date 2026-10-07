import type { NextConfig } from "next";

const tunnelOrigin = process.env.PUBLIC_TUNNEL_ORIGIN;

// The desktop app ships the UI as a self-contained server (see
// desktop/scripts/stage.mjs). Opt-in, because `next start` cannot serve it.
const standalone = process.env.BEEBLIO_STANDALONE === "1";

const nextConfig: NextConfig = {
  ...(standalone
    ? {
        output: "standalone" as const,
        // File tracing follows fs reads relative to the working directory and
        // so would copy the whole checkout, including .beeblio/ (the database,
        // settings, and API keys) and .env files. Those must never ship.
        outputFileTracingExcludes: {
          "*": [".beeblio/**", ".env*", ".git/**", ".eve/**", ".output/**", "desktop/**", "tests/**", "*.tsbuildinfo"],
        },
      }
    : {}),
  // The public tunnel uses a different host for development assets and HMR.
  allowedDevOrigins: tunnelOrigin ? [new URL(tunnelOrigin).hostname] : [],
  async redirects() {
    return [{ source: "/", destination: "/workspace", permanent: false }];
  },
  experimental: {
    // File uploads use the local workspace route.
    serverActions: { bodySizeLimit: "4mb" },
  },
  // Document export rasterizes SVGs with sharp outside the bundle.
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
