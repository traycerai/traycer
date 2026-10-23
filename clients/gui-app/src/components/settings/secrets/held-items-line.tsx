import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * STUB (P5 replaces its body): the Secrets page's held-items line
 * (`3 items from MacBook Pro are not in use · Review them`), above the list.
 * Renders nothing until filled.
 */
export interface HeldItemsLineProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
}

export function HeldItemsLine(_props: HeldItemsLineProps): ReactNode {
  return null;
}
