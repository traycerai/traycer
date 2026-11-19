import { useState, type ReactNode } from "react";
import type { OwnershipReceipt } from "@/components/settings/panels/host-overview-settings-card";

/**
 * Holds the line the way `HostEnvironmentSection` does, for suites that render
 * the card directly and assert the line it draws.
 */
export function WithReceipt(props: {
  readonly children: (receipt: OwnershipReceipt) => ReactNode;
}): ReactNode {
  const [line, setLine] = useState<string | null>(null);
  return props.children({
    line,
    show: setLine,
    giveStarted: () => undefined,
  });
}
