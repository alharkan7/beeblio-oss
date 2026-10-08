import { after, NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentSessions, projects } from "@/db/schema";
import { getUser } from "@/lib/auth/session";
import { mintAgentToken } from "@/lib/agent-token";
import { generateConversationTitle } from "@/lib/conversation-title";
import { getAiTaskConfig } from "@/lib/local-ai-settings";

export const dynamic = "force-dynamic";

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const targetPath = path.join("/");
  if (!isAllowedEveRoute(req.method, targetPath)) return new Response("Not found", { status: 404 });
  const backendUrl = process.env.AGENT_URL?.trim().replace(/\/+$/, "");
  if (!backendUrl) return new Response("Local Eve server is not configured", { status: 503 });
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const requestBody = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  if ((requestBody?.length ?? 0) > 64 * 1024) return new Response("Request too large", { status: 413 });
  const headers = new Headers(req.headers);
  for (const name of ["host", "cookie", "transfer-encoding", "content-length", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade", "accept-encoding", "x-credit-reservation-id", "x-credit-execution-class", "x-beeblio-model-source", "x-beeblio-model-id", "x-beeblio-model-context-window-tokens", "x-beeblio-app-session-id", "x-turn-model-deadline-at"]) headers.delete(name);
  headers.set("authorization", `Bearer ${mintAgentToken(user.id)}`);
  const chatModel = await getAiTaskConfig("chat");
  if (!chatModel.apiKey || !chatModel.modelId) return new Response("Chat model is not configured", { status: 503 });
  headers.set("x-model-source", "local");
  headers.set("x-model-id", chatModel.modelId);
  headers.set("x-model-context-window-tokens", String(chatModel.contextLength));

  if (targetPath === "v1/session" && req.method === "POST") {
    const appSessionId = req.headers.get("x-beeblio-app-session-id")?.trim();
    if (appSessionId) {
      const projectSlug = req.headers.get("x-project-slug")?.trim();
      const project = projectSlug ? await db.query.projects.findFirst({ where: and(eq(projects.slug, projectSlug), eq(projects.userId, user.id)) }) : undefined;
      if (!isUuid(appSessionId) || !project) return Response.json({ error: "Invalid conversation registration" }, { status: 400 });
      const body = parseJsonObject(requestBody);
      const firstMessage = messageText(body?.message);
      const initialTitle = "New Conversation";
      await db.insert(agentSessions).values({ id: appSessionId, projectId: project.id, title: initialTitle }).onConflictDoNothing({ target: agentSessions.id });
      after(async () => {
        try {
          const title = await generateConversationTitle(firstMessage);
          await db.update(agentSessions).set({ title, updatedAt: new Date() }).where(and(eq(agentSessions.id, appSessionId), eq(agentSessions.title, initialTitle)));
        } catch (error) { console.error("Conversation title update failed:", error); }
      });
    }
  }

  try {
    const response = await fetch(`${backendUrl}/eve/${targetPath}${req.nextUrl.search}`, { method: req.method, headers, body: requestBody });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (error) {
    console.error("Local Eve proxy error:", error);
    return new Response("Unable to reach local agent", { status: 502 });
  }
}
export { proxy as GET, proxy as POST };
function isTurnRoute(path: string) { return path === "v1/session" || (/^v1\/session\/[^/]+$/.test(path) && path !== "v1/session/reset"); }
function isAllowedEveRoute(method: string, path: string) {
  if (method === "GET") return path === "v1/health" || /^v1\/session\/[^/]+\/stream$/.test(path);
  return method === "POST" && (isTurnRoute(path) || /^v1\/session\/[^/]+\/cancel$/.test(path));
}
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function parseJsonObject(value: string | undefined): Record<string, unknown> | null { try { const parsed = JSON.parse(value || "null"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; } }
function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join(" ").trim() || undefined;
}
