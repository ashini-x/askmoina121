import { Sandbox } from "@e2b/code-interpreter";
import { SANDBOX_TIMEOUT_MS } from "../core/config";
import { validatePythonCode } from "../security/guardrails";

export interface SandboxResult {
  status: "success" | "error";
  stdout: string;
  stderr: string;
}

export async function runPythonSandbox(code: string, apiKey: string, maxChars: number): Promise<SandboxResult> {
  let validated: string;
  try {
    validated = validatePythonCode(code, maxChars);
  } catch (error) {
    return { status: "error", stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }

  if (!apiKey) {
    return { status: "error", stdout: "", stderr: "E2B_API_KEY missing from Worker secrets." };
  }

  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.create({ apiKey });
    const executionPromise = sandbox.runCode(validated);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Sandbox execution exceeded ${SANDBOX_TIMEOUT_MS / 1000}s.`)), SANDBOX_TIMEOUT_MS);
    });
    const execution = await Promise.race([executionPromise, timeoutPromise]);

    let stdout = "";
    if (execution.logs?.stdout?.length) stdout += execution.logs.stdout.join("\n");
    if (execution.text) stdout += `${stdout ? "\n" : ""}${execution.text}`;
    for (const result of execution.results || []) {
      if (result?.text) stdout += `${stdout ? "\n" : ""}${result.text}`;
    }

    if (execution.error) {
      return {
        status: "error",
        stdout: stdout.trim().slice(0, 12000),
        stderr: `${execution.error.name || "ExecutionError"}: ${execution.error.value || "Unknown error"}`.slice(0, 4000),
      };
    }

    return { status: "success", stdout: stdout.trim().slice(0, 12000), stderr: "" };
  } catch (error) {
    return {
      status: "error",
      stdout: "",
      stderr: `E2B Client Error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000),
    };
  } finally {
    try { await sandbox?.kill(); } catch { /* best effort */ }
  }
}
