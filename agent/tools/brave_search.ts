import { defineTool } from "eve/tools";
import { z } from "zod";
import type { ToolContext } from "eve/tools";
import { fetchWithTimeout, truncateText } from "../lib/tool-runtime";
import { appSetting } from "../../lib/app-settings";

export default defineTool({
  description:
    "Search the web with the Brave Search API. Use only when the user requests Brave or when web_search is unavailable or unsuccessful.",
  inputSchema: z.object({
    query: z.string().min(1).describe("The search query."),
    count: z.number().int().min(1).max(20).default(10),
  }),
  async execute({ query, count }, ctx: ToolContext) {
    const apiKey = appSetting("BRAVE_SEARCH_API_KEY");
    if (!apiKey) {
      throw new Error("Brave Search is not configured; use web_search instead");
    }

    try {
      const response = await fetchWithTimeout(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
          },
          signal: ctx.abortSignal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Brave Search API responded with status: ${response.status}`,
        );
      }
      const data = await response.json() as {
        web?: { results?: Array<{ title: string; url: string; description?: string; age?: string }> };
      };
      return {
        query,
        results: (data.web?.results ?? []).slice(0, count).map((item) => ({
          title: item.title,
          url: item.url,
          description: truncateText(String(item.description ?? ""), 1_000).content,
          age: item.age,
        })),
      };
    } catch (error: unknown) {
      throw new Error(`Brave Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
