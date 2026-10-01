export const MAX_PROMPT_CHARS = 2000;
export const MAX_HISTORY_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 12000;
export const MAX_SANDBOX_CODE_CHARS = 6000;
export const SANDBOX_TIMEOUT_MS = 15000;

export const SEARCH_RESULT_LIMIT = 3;
export const SEARCH_QUERY_MAX_CHARS = 2000;

export function currentDateTime(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date());
}
