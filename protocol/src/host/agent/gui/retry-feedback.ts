import type { RuntimeEvent } from "./agent-runtime";

/** Retry lifecycle travels in the existing open error code, not recoverable:
 * authentication errors can be recoverable while still ending the attempt. */
export const RETRY_IN_PROGRESS_ERROR_CODE = "RETRY_IN_PROGRESS";
export const RETRY_RECOVERED_ERROR_CODE = "RETRY_RECOVERED";
export const RETRY_ENDED_ERROR_CODE = "RETRY_ENDED";

export function isRetryInProgressErrorEvent(event: RuntimeEvent): boolean {
  return event.type === "error" && event.code === RETRY_IN_PROGRESS_ERROR_CODE;
}

export function isRetryFeedbackCode(code: string | null | undefined): boolean {
  return (
    code === RETRY_IN_PROGRESS_ERROR_CODE ||
    code === RETRY_RECOVERED_ERROR_CODE ||
    code === RETRY_ENDED_ERROR_CODE
  );
}

export function isNonTerminalRetryErrorEvent(event: RuntimeEvent): boolean {
  return event.type === "error" && isRetryFeedbackCode(event.code);
}

export function codexRetryVisibility(
  harnessId: string | null,
  code: string | null | undefined,
  turnEnded: boolean,
): "active" | "hidden" | null {
  if (harnessId !== "codex" || !isRetryFeedbackCode(code)) return null;
  return !turnEnded && code === RETRY_IN_PROGRESS_ERROR_CODE
    ? "active"
    : "hidden";
}

export function codexRetryTitle(message: string): string {
  if (!/^Reconnecting(?:\.{3}|…|\s|$)/i.test(message)) return "Retrying";
  const attempt = /^Reconnecting(?:\.{3}|…)?\s*(\d+\s*\/\s*\d+)/i.exec(
    message,
  )?.[1];
  return attempt === undefined
    ? "Reconnecting"
    : `Reconnecting ${attempt.replace(/\s/g, "")}`;
}
