import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useProfileCopyIncomingQuery } from "@/hooks/providers/profile-copy/use-profile-copy-queries";
import {
  profileCopyWireProvider,
  type ProfileCopyIncomingDraft,
} from "@/lib/profile-copy/profile-copy-model";
import { presentProfileCopyOutcome } from "@/lib/profile-copy/profile-copy-presentation";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  openProfileCopySourceOperation,
  retryFromSourceOffered,
} from "./profile-copy-source-operation";
import { ProfileCopyBadge } from "./profile-copy-badge";
import {
  profileCopyProviderLabel,
  useProfileCopyHosts,
  type ProfileCopyHosts,
} from "./profile-copy-shared";

/**
 * Copies waiting on THIS host for this provider: open drafts, ones being
 * cancelled, and interrupted ones nothing replaced. Read from the destination
 * itself, so any viewer on the account sees them - but only the ones that
 * reached it (Q3 ruling), which the card says. Drafts never appear in a
 * profile picker; they are listed here and nowhere else.
 */
export function ProfileCopyIncomingSection(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
}): ReactNode {
  const provider = profileCopyWireProvider(props.providerId);
  const supported = useHostMethodSupport(
    props.hostId,
    "providers.profileCopy.incoming",
  );
  if (props.hostId === null || provider === null || supported !== true) {
    return null;
  }
  return (
    <ProfileCopyIncomingList
      destinationHostId={props.hostId}
      providerId={props.providerId}
    />
  );
}

function ProfileCopyIncomingList(props: {
  readonly destinationHostId: string;
  readonly providerId: ProviderId;
}): ReactNode {
  const { destinationHostId } = props;
  const provider = profileCopyWireProvider(props.providerId);
  const incoming = useProfileCopyIncomingQuery(destinationHostId, true);
  const hosts = useProfileCopyHosts();
  const page = incoming.data?.drafts ?? [];
  const nextCursor = incoming.data?.nextCursor ?? null;
  const drafts = page.filter(
    (draft) => draft.outcome.attempt.providerId === provider,
  );
  if (drafts.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      aria-label="Incoming copies"
    >
      <div className="flex flex-col gap-0.5">
        <div className="text-ui-sm font-medium text-foreground">
          Incoming copies
        </div>
        <p className="text-ui-xs text-muted-foreground">
          Copies waiting on this device. Copies that never reached it are listed
          only on the device that started them. Agents can&apos;t use these
          until they finish.
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {drafts.map((draft) => (
          <ProfileCopyIncomingRow
            key={draft.outcome.attempt.attemptId}
            draft={draft}
            hosts={hosts}
          />
        ))}
      </ul>
      {nextCursor !== null ? (
        <p className="text-ui-xs text-muted-foreground">
          Showing the first {page.length} copies on this device. Finish or
          cancel some to see the rest.
        </p>
      ) : null}
    </section>
  );
}

function ProfileCopyIncomingRow(props: {
  readonly draft: ProfileCopyIncomingDraft;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const { draft, hosts } = props;
  const attempt = draft.outcome.attempt;
  const openFlow = useProfileCopyFlowStore((state) => state.open);
  const sourceName = hosts.nameFor(attempt.sourceHostId);
  const presentation = presentProfileCopyOutcome(draft.outcome, {
    names: {
      source: sourceName,
      destination: hosts.nameFor(attempt.destinationHostId),
      provider: profileCopyProviderLabel(attempt.providerId),
      profile: draft.metadata.name,
    },
    route: null,
    cancelRequested: false,
  });
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-2">
      <div className="flex min-w-0 flex-auto flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-ui-sm text-foreground">
            {draft.metadata.name}
          </span>
          <ProfileCopyBadge
            tone={presentation.tone}
            label={presentation.badge}
          />
        </div>
        <span className="text-ui-xs text-muted-foreground">
          From {sourceName}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {retryFromSourceOffered(draft.outcome) ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => openProfileCopySourceOperation(attempt)}
          >
            Retry from {sourceName}
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() =>
            openFlow({
              kind: "draft",
              destinationHostId: attempt.destinationHostId,
              attempt,
              profileName: draft.metadata.name,
            })
          }
        >
          Continue
        </Button>
      </div>
    </li>
  );
}
