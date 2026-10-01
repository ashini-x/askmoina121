const ADVERSARIAL_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|earlier|above)\s+(?:instructions|rules|messages)/i,
  /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|earlier|above)\s+(?:instructions|rules|messages)/i,
  /forget\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|earlier|above)\s+(?:instructions|rules|messages)/i,
  /you\s+are\s+now\s+(?:DAN|jailbreak|unrestricted|developer|system)/i,
  /(?:override|replace|bypass|disable)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions|rules)/i,
  /bypass\s+(?:security|safety)\s+filters?/i,
  /reveal\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions)/i,
  /show\s+(?:me\s+)?(?:the\s+)?(?:hidden|secret|internal)\s+(?:prompt|instructions|chain[-\s]?of[-\s]?thought)/i,
  /print\s+(?:your|the)\s+(?:system|developer)\s+(?:prompt|message)/i,
];

export function sanitizeInput(prompt: string): string {
  const normalized = String(prompt ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();

  for (const pattern of ADVERSARIAL_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error("Security Guardrail Triggered: Adversarial prompt input flagged.");
    }
  }

  return normalized;
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
