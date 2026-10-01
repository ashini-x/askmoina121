export type ModeKey = "logical" | "auto" | "creative";
export type ChatMessage = { role: "user" | "assistant"; content: string };

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  E2B_API_KEY: string;
}

export interface ToolSearchRequest {
  query: string;
  maxResults?: number;
}

export interface SandboxRequest {
  code: string;
}

export interface SearchResult {
  title: string;
  body: string;
  href: string;
}
