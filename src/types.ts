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
  OPS_DB?: D1Database;
  ADMIN_EMAILS?: string;
  ADMIN_HOSTNAME?: string;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success?: boolean; meta?: Record<string, unknown> }>;
  run(): Promise<{ success?: boolean; meta?: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<Array<{ success?: boolean; meta?: Record<string, unknown> }>>;
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
