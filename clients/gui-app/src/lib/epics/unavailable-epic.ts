/**
 * `NOT_FOUND` is the protocol-level absence signal. Reason text is operator
 * diagnostics and changes independently, so it must never decide whether the
 * UI closes an unavailable Epic.
 */
export function isUnavailableEpicCode(code: string): boolean {
  return code === "NOT_FOUND";
}
