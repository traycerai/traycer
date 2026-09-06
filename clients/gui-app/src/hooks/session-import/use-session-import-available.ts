import {
  useStreamMethodSupportFor,
  useWsStreamClient,
  type StreamMethodSupportSource,
} from "@/lib/host/stream-runtime-context";

/**
 * Whether the host behind an EXPLICIT stream client can import sessions.
 *
 * The form a host-scoped surface uses: it takes the client the import would
 * actually run on, so the answer and the run cannot come from two different
 * machines. Settings' Host Overview re-provides its own `StreamRuntimeContext`,
 * and during the commits where the scoped transport has not resolved yet the
 * context still holds the ambient one - so a row that read "is it supported"
 * from context and "where do I send it" from a binding it was handed could
 * offer an import host A negotiated and submit it to host B.
 */
export function useSessionImportAvailableFor(
  client: StreamMethodSupportSource | null,
): boolean {
  return (
    useStreamMethodSupportFor(client, "sessionImport.scan") !== "unsupported"
  );
}

/**
 * Whether the bound host can import sessions at all.
 *
 * Session import is an additive optional capability: a host that predates it
 * never advertises the stream methods, and the registry's answer is to hide
 * the entry rather than degrade it - there is nothing to fall back to. Only a
 * negotiated `"unsupported"` hides it; `"unknown"` (pre-handshake) does not,
 * so a Settings pane opened during a reconnect does not blink the row away.
 */
export function useSessionImportAvailable(): boolean {
  const client = useWsStreamClient();
  return useSessionImportAvailableFor(client);
}
