import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProfileCategoryOwnership } from "@traycer/protocol/host/provider-profile-config-schemas";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersSetProfileOwnership } from "@/hooks/providers/use-providers-set-profile-ownership-mutation";

const CATEGORY_LABEL: Readonly<Record<"skills" | "plugins", string>> = {
  skills: "skills",
  plugins: "plugins",
};

/**
 * D02/D26: the Linked/Own toggle for one category (Skills or Plugins) on a
 * managed profile. Global scope only - D02's Linked/Own axis is about the
 * profile HOME, and project scope has no such notion. Renders nothing for
 * the Default account (`profileId === null`, always Own), for a host that
 * predates `providers.setProfileOwnership`, or when the caller has no
 * ownership summary to show (`ownership === null` - an old host's row, or a
 * provider/category this account never wrote an explicit ownership for).
 *
 * Never hardcodes which providers support Linked - `ownership` comes from
 * the `providers.list@9.0` row's `config.skills` / `config.plugins` (D04's
 * table stays host-side).
 */
export function CategoryOwnershipToggle(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly category: "skills" | "plugins";
  readonly ownership: ProfileCategoryOwnership | null;
  /** Entries in this profile's own copy, named in the Own→Linked confirm. */
  readonly entryCount: number;
}): ReactNode {
  // Split BEFORE any host-mutation hook mounts (not after an early return in
  // this same component - that would make the hook order conditional). The
  // Default account is the overwhelming common case across every settings
  // surface, and `useProvidersSetProfileOwnership` needs a live
  // `HostRuntimeProvider` the moment it mounts (`useHostClient` throws
  // without one) - a cost this toggle must not impose on a render that is
  // never going to show anything.
  if (props.profileId === null) return null;
  return <CategoryOwnershipToggleBody {...props} profileId={props.profileId} />;
}

function CategoryOwnershipToggleBody(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  readonly profileId: string;
  readonly category: "skills" | "plugins";
  readonly ownership: ProfileCategoryOwnership | null;
  readonly entryCount: number;
}): ReactNode {
  const { hostId, providerId, profileId, category, ownership, entryCount } =
    props;
  const supportsOwnership = useHostSupportsMethod(
    hostId,
    "providers.setProfileOwnership",
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mutate = useProvidersSetProfileOwnership();

  if (!supportsOwnership || ownership === null) {
    return null;
  }

  const label = CATEGORY_LABEL[category];

  if (ownership === "linked") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
        <div className="min-w-0">
          <p className="text-ui-sm font-medium text-foreground">
            Linked to the Default account&apos;s {label}.
          </p>
          <p className="text-ui-xs text-muted-foreground">
            Edits here change the Default account too.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={mutate.isPending}
          onClick={() =>
            mutate.mutate({ providerId, profileId, category, ownership: "own" })
          }
        >
          Make its own copy
        </Button>
      </div>
    );
  }

  const discardActionLabel = `Discard ${entryCount} ${label} and link`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
      <div className="min-w-0">
        <p className="text-ui-sm font-medium text-foreground">
          This profile has its own {label}.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={mutate.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        Link to Default account
      </Button>
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Link to Default account?"
        description={`This profile's ${entryCount} own ${label} are deleted. It will use the Default account's ${label} from now on.`}
        cascadeSummary={null}
        actionLabel={discardActionLabel}
        isPending={mutate.isPending}
        onConfirm={() =>
          mutate.mutate(
            { providerId, profileId, category, ownership: "linked" },
            { onSuccess: () => setConfirmOpen(false) },
          )
        }
      />
    </div>
  );
}
