/**
 * Input normalization is intentionally non-blocking.
 *
 * Prompt-injection phrases are not rejected at the transport layer because a
 * legitimate user may ask about jailbreaks, system prompts, adversarial ML,
 * security research, or quote an injection as data. Authority separation is
 * handled in the system prompt and by keeping tool/source/history content inert.
 */
export function sanitizeInput(prompt: string): string {
  return String(prompt ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

const PYTHON_DENY_PATTERNS = [
  /\b(?:subprocess|socket|requests|httpx|urllib|ftplib|paramiko)\b/i,
  /\b(?:os\.system|os\.popen|subprocess\.)/i,
  /\b(?:eval|exec|compile)__?\s*\(/i,
  /\b__import__\s*\(/i,
  /(?:^|\n)\s*!\s*(?:pip|python|bash|sh)\b/i,
  /\b(?:apt-get|curl|wget)\b/i,
];

export function validatePythonCode(code: string, maxChars: number): string {
  const normalized = String(code ?? "").trim();
  if (!normalized) throw new Error("Sandbox code is empty.");
  if (normalized.length > maxChars) throw new Error(`Sandbox code exceeds the ${maxChars}-character limit.`);
  for (const pattern of PYTHON_DENY_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error("Sandbox policy blocked potentially unsafe Python/network operations.");
    }
  }
  return normalized;
}
