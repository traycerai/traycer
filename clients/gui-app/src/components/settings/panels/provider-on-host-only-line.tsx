import type { ReactNode } from "react";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { AVAILABLE_ON_THIS_COMPUTER_TEXT } from "@/components/providers/profile-sync-copy";

export function ProviderOnHostOnlyLine(props: {
  readonly providerId: string;
  readonly profileId: string;
}): ReactNode {
  const list = useProvidersList({ enabled: true, subscribed: true }).data;
  const onlyHere = list?.onHostOnly?.some(
    (entry) =>
      entry.providerId === props.providerId &&
      entry.profileId === props.profileId,
  );
  if (!onlyHere) return null;
  return (
    <p
      data-testid="profile-on-host-only"
      className="min-w-0 text-ui-xs text-muted-foreground"
    >
      {AVAILABLE_ON_THIS_COMPUTER_TEXT}
    </p>
  );
}
