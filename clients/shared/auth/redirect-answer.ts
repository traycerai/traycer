// A browser reports a manual redirect as an opaque status 0.
export function isRedirectAnswer(status: number): boolean {
  return status === 0 || (status >= 300 && status < 400);
}
