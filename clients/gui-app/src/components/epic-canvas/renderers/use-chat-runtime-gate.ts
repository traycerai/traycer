import { useCallback } from "react";
import type { RuntimeCapabilitiesResponse } from "@traycer/protocol/host";
import { useHostRuntimeCapabilitiesQuery } from "@/hooks/host/use-host-runtime-capabilities-query";
import type {
  ChatRuntimeAvailability,
  ChatRuntimeGate,
} from "./chat-tile-types";

export function chatRuntimeAvailabilityFromQuery(
  data: RuntimeCapabilitiesResponse | null,
  isPending: boolean,
  error: Error | null,
): ChatRuntimeAvailability {
  if (data?.chatMessageList.status === "available") {
    return {
      kind: "available",
      licenseKey: data.chatMessageList.licenseKey,
    };
  }
  if (data?.chatMessageList.status === "unavailable") {
    return { kind: "unavailable" };
  }
  if (error !== null) {
    return { kind: "error", message: error.message };
  }
  if (isPending) {
    return { kind: "loading" };
  }
  return { kind: "unavailable" };
}

export function useChatRuntimeGate(): ChatRuntimeGate {
  const runtimeCapabilitiesQuery = useHostRuntimeCapabilitiesQuery();
  const { data, error, fetchStatus, isFetching, isPending, refetch } =
    runtimeCapabilitiesQuery;
  const availability = chatRuntimeAvailabilityFromQuery(
    data ?? null,
    Boolean(isPending && fetchStatus === "fetching"),
    error,
  );
  const retrying = availability.kind !== "loading" && Boolean(isFetching);
  const retry = useCallback(() => {
    return refetch();
  }, [refetch]);

  return {
    availability,
    retrying,
    retry,
  };
}
