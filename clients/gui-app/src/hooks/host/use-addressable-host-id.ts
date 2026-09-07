import { useMemo } from "react";
import { useHostBinding } from "@/lib/host";
import { resolveSubtreeHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";

/** Addressable yet: directory row exists. */
export function useAddressableHostId(): string | null {
  const binding = useHostBinding();
  const effectiveHostId = useEffectiveHostId();
  // The provider renders a fallback until its binding exists, so no production consumer can observe the difference; a test rendering one of the 44 consumers without a runtime can, and the slot-era hook answered `null` there rather than throwing.
  const client = useMemo(
    () => resolveSubtreeHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );
  return useReactiveHostReadiness(client).hostId;
}
