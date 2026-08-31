import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";

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
  return useStreamMethodSupport("sessionImport.scan") !== "unsupported";
}
