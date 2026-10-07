import { appSetting } from "@/lib/app-settings";

/** Public HTTPS origin used for links that must be reachable from outside this computer. */
export function publicTunnelOrigin(): string | null {
  const configured = appSetting("PUBLIC_TUNNEL_ORIGIN");
  return configured ? new URL(configured).origin : null;
}
