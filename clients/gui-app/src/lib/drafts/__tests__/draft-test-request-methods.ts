/** A scripted host requester that handles both caller entry points. */
export function withDraftTestRequestMethods<
  Client extends { readonly request: unknown },
>(client: Client): Client & { readonly requestAsVersion: Client["request"] } {
  return { ...client, requestAsVersion: client.request };
}
