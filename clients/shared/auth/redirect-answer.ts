/**
 * Whether a request sent with `redirect: "manual"` was answered with a
 * redirect: a 3xx, or the opaque redirect a browser reports as status 0. A
 * request that carries a credential treats it as a non-success and never
 * reads its body.
 */
export function isRedirectAnswer(status: number): boolean {
  return status === 0 || (status >= 300 && status < 400);
}
