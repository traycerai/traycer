import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * STUB (P3 replaces its body): the Secrets page's header actions
 * (`Details`), above the list. Renders nothing until filled.
 */
export interface SecretsHeaderDetailsProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
}

export function SecretsHeaderDetails(
  _props: SecretsHeaderDetailsProps,
): ReactNode {
  return null;
}
