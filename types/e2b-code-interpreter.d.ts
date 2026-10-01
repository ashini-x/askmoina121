declare module "@e2b/code-interpreter" {
  export interface SandboxRunResult {
    text?: string;
    results?: Array<{ text?: string }>;
    logs?: { stdout?: string[]; stderr?: string[] };
    error?: { name?: string; value?: string } | null;
  }

  export class Sandbox {
    static create(options?: { apiKey?: string }): Promise<Sandbox>;
    runCode(code: string): Promise<SandboxRunResult>;
    kill(): Promise<void>;
  }
}
