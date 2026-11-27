/** A scripted host requester that handles both caller entry points. */
export function withDraftTestRequestMethods<
  Client extends { readonly request: unknown },
>(client: Client): Client & { readonly requestAtVersion: Client["request"] } {
  return { ...client, requestAtVersion: client.request };
}
