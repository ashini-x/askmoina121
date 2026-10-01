export type ModeKey = "logical" | "auto" | "creative";
export type ChatMessage = { role: "user" | "assistant"; content: string };

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AI?: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  E2B_API_KEY?: string;
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

export interface ChatRequest {
  messages: ChatMessage[];
  mode?: ModeKey;
}

export type ProviderName = "gemini" | "groq" | "cloudflare";
