import {
  useStreamMethodSupportFor,
  useWsStreamClient,
  type StreamMethodSupportSource,
} from "@/lib/host/stream-runtime-context";

/**
 * Gate on the same explicit stream client the import will run on. Context during unresolved scoped-transport commits can still hold the ambient host.
 */
export function useSessionImportAvailableFor(
  client: StreamMethodSupportSource | null,
): boolean {
  return (
    useStreamMethodSupportFor(client, "sessionImport.scan") !== "unsupported"
  );
}

/** Session import is an additive optional capability: a host that predates it never advertises the stream methods, and the registry's answer is to hide the entry rather than degrade it - there is nothing to fall back to. */
export function useSessionImportAvailable(): boolean {
  const client = useWsStreamClient();
  return useSessionImportAvailableFor(client);
}
