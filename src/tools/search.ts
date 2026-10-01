import { SEARCH_QUERY_MAX_CHARS, SEARCH_RESULT_LIMIT } from "../core/config";
import type { SearchResult } from "../types";

function decodeHtml(input: string): string {
  return input
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(input: string): string {
  return decodeHtml(input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function resolveHref(raw: string): string {
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    const resolved = uddg ? decodeURIComponent(uddg) : url.toString();
    const parsed = new URL(resolved);
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function parseResults(html: string, maxResults: number): SearchResult[] {
  const anchors = [...html.matchAll(/<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const results: SearchResult[] = [];

  for (const match of anchors.slice(0, maxResults)) {
    const start = match.index ?? 0;
    const nearby = html.slice(start, start + 7000);
    const snippetMatch = nearby.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|a)>/i);
    const href = resolveHref(match[1] || "");
    if (!href) continue;
    results.push({
      title: clamp(stripTags(match[2] || ""), 240),
      body: clamp(stripTags(snippetMatch?.[1] || ""), 900),
      href,
    });
  }
  return results.filter((item) => item.title || item.body || item.href);
}

export async function webSearch(query: string, maxResults = SEARCH_RESULT_LIMIT): Promise<SearchResult[]> {
  const cleanQuery = String(query ?? "").trim().slice(0, SEARCH_QUERY_MAX_CHARS);
  if (!cleanQuery) return [];

  try {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", cleanQuery);
    url.searchParams.set("kl", "wt-wt");
    const response = await fetch(url, {
      headers: {
        "User-Agent": "AskMoina/1.2 (+https://askmoina.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) return [];
    return parseResults(await response.text(), Math.max(1, Math.min(maxResults, SEARCH_RESULT_LIMIT)));
  } catch {
    return [];
  }
}

export function formatSearchContext(results: SearchResult[]): string {
  if (!results.length) return "No relevant web search results were available.";
  return results.map((result, index) =>
    `[SOURCE ${index + 1}]\nTitle: ${result.title}\nSnippet: ${result.body}\nURL: ${result.href}`,
  ).join("\n\n");
}
