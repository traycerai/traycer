/**
 * Memo of handshake verdicts per host. Consult only before a client completes its own handshake; after reconnect the client's map is the authority.
 * Local transport only. RemoteStreamClient stays `unknown` by construction.
 */

export type NegotiatedStreamMethodSupport = "supported" | "unsupported";

const supportByHostId = new Map<
  string,
  Map<string, NegotiatedStreamMethodSupport>
>();

/** Record every method in the negotiated manifest, not only the subscribed one. */
export function recordNegotiatedStreamMethodSupport(
  hostId: string,
  method: string,
  support: NegotiatedStreamMethodSupport,
): void {
  const forHost = supportByHostId.get(hostId);
  if (forHost === undefined) {
    supportByHostId.set(hostId, new Map([[method, support]]));
    return;
  }
  forHost.set(method, support);
}

/**
 * Last handshake verdict for `hostId`/`method`, or `null` when none has settled.
 * `null` is absence, not the caller's `unknown`.
 */
export function getMemoizedStreamMethodSupport(
  hostId: string,
  method: string,
): NegotiatedStreamMethodSupport | null {
  return supportByHostId.get(hostId)?.get(method) ?? null;
}

export function resetStreamMethodSupportMemo(): void {
  supportByHostId.clear();
}
