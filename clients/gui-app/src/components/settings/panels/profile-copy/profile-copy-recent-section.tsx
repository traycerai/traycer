import type { ReactNode } from "react";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { profileCopyWireProvider } from "@/lib/profile-copy/profile-copy-model";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  useProfileCopyOperationsStore,
  type ProfileCopyOperationHandle,
} from "@/stores/settings/profile-copy-operations-store";
import {
  useProfileCopyHosts,
  type ProfileCopyHosts,
} from "./profile-copy-shared";

/**
 * Copies this window started or opened FROM this host, for this provider.
 *
 * Built from the account's persisted handles only: no host has a list verb
 * for another viewer's copies (Q3 ruling), so the card says whose list this
 * is. Listing reads nothing; a row's progress is read when it is opened.
 * With no rows it renders nothing and subscribes to nothing but the handles.
 */
export function ProfileCopyRecentSection(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  readonly profiles: readonly ProviderProfile[];
}): ReactNode {
  const provider = profileCopyWireProvider(props.providerId);
  const handles = useProfileCopyOperationsStore((state) => state.handles);
  if (props.hostId === null || provider === null) return null;
  const sourceHostId = props.hostId;
  const rows = handles.filter(
    (handle) =>
      handle.sourceHostId === sourceHostId && handle.providerId === provider,
  );
  if (rows.length === 0) return null;
  return <ProfileCopyRecentList rows={rows} profiles={props.profiles} />;
}

function ProfileCopyRecentList(props: {
  readonly rows: readonly ProfileCopyOperationHandle[];
  readonly profiles: readonly ProviderProfile[];
}): ReactNode {
  const hosts = useProfileCopyHosts();
  const { rows } = props;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      aria-label="Recent copies"
    >
      <div className="flex flex-col gap-0.5">
        <div className="text-ui-sm font-medium text-foreground">
          Recent copies
        </div>
        <p className="text-ui-xs text-muted-foreground">
          Copies started or opened in this window on this account. Copies
          started elsewhere aren&apos;t listed here.
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((handle) => (
          <ProfileCopyRecentRow
            key={handle.operationId}
            handle={handle}
            profileLabel={
              props.profiles.find(
                (profile) => profile.profileId === handle.sourceProfileId,
              )?.label ?? null
            }
            hosts={hosts}
          />
        ))}
      </ul>
    </section>
  );
}

function destinationSummary(
  handle: ProfileCopyOperationHandle,
  hosts: ProfileCopyHosts,
): string {
  const names = handle.destinationHostIds.map((hostId) =>
    hosts.nameFor(hostId),
  );
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

function ProfileCopyRecentRow(props: {
  readonly handle: ProfileCopyOperationHandle;
  readonly profileLabel: string | null;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const { handle } = props;
  const openFlow = useProfileCopyFlowStore((state) => state.open);
  const removeHandle = useProfileCopyOperationsStore((state) => state.remove);
  const when = useRelativeTimestamp(handle.createdAt);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-2">
      <div className="flex min-w-0 flex-auto flex-col">
        <span className="truncate text-ui-sm text-foreground">
          {props.profileLabel ?? "A removed profile"} to{" "}
          {destinationSummary(handle, props.hosts)}
        </span>
        <span className="text-ui-xs text-muted-foreground">
          {when}
          {handle.cancelConfirmedAt !== null ? " · Cancel requested" : null}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() =>
            openFlow({ kind: "operation", operationId: handle.operationId })
          }
        >
          Open
        </Button>
        {/* Forgets it in this window's list only - it never cancels. */}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => removeHandle(handle.operationId)}
        >
          Remove from list
        </Button>
      </div>
    </li>
  );
}
