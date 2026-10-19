import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { usePersonalHostName } from "@/components/settings/personal/personal-page-context";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";

/**
 * "On <host> only, link to use everywhere": a profile this host signed in on
 * its own, which no other host is offered until it is linked
 * (`providers.list@10.5` `onHostOnly`). Link opens the Link dialog, and only
 * where the host can serve it (`providers.link`); without that the line still
 * says where the profile lives.
 *
 * Reads the panel's own list query, so there is no second fetch.
 */
export function ProviderOnHostOnlyLine(props: {
  readonly hostId: string | null;
  readonly providerId: string;
  readonly profileId: string;
}): ReactNode {
  const onHostOnly =
    useProvidersList({ enabled: true, subscribed: true }).data?.onHostOnly ??
    null;
  const hostName = usePersonalHostName() ?? "this host";
  const linkSupported = useHostMethodSupport(props.hostId, "providers.link");
  const openLink = useProviderLinkDialogStore((state) => state.open);
  const onlyHere =
    onHostOnly?.some(
      (entry) =>
        entry.providerId === props.providerId &&
        entry.profileId === props.profileId,
    ) === true;
  if (!onlyHere) return null;
  return (
    <div
      data-testid="profile-on-host-only"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-muted-foreground"
    >
      <p className="min-w-0">On {hostName} only, link to use everywhere.</p>
      {linkSupported === true ? (
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          onClick={() =>
            openLink({
              providerId: props.providerId,
              profileId: props.profileId,
            })
          }
        >
          Link
        </Button>
      ) : null}
    </div>
  );
}
