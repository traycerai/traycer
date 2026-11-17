/**
 * `new Response` refuses status 0, so a real response is given the browser's
 * `status`, `type` and `ok`.
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
