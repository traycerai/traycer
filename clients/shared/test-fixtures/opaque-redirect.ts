/**
 * A browser's answer to a `redirect: "manual"` request that was redirected:
 * an opaque-redirect response with status 0. `new Response` refuses status 0,
 * so a real response is built and given the browser's `status`, `type` and
 * `ok` (a prototype getter over the real status, which would still read 200).
 */
export function createOpaqueRedirectResponse(): Response {
  const response = new Response(null);
  Object.defineProperties(response, {
    status: { value: 0 },
    type: { value: "opaqueredirect" },
    ok: { value: false },
  });
  return response;
}
