/**
 * The Identities list: every identity the host holds, with create, open and
 * delete. Rehostable by construction - it takes its host and client as props
 * and reports an open through `onOpen`, so the same body serves the dialog
 * today and a Settings section or sidebar entry later without changes.
 *
 * Rename is NOT here: `agentIdentity.update` takes the whole record including
 * the evolution tuple, and the list's summaries do not carry it, so a rename
 * from a row would have to guess the settings it is not allowed to change.
 * The name is edited in the identity's own Settings panel.
 */
import { useState, type ReactNode } from "react";
import { IdCard, Plus, Trash2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AgentIdentitySummary } from "@traycer/protocol/host/agent-identity/schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useIdentityCreateForClient,
  useIdentityDeleteForClient,
} from "@/hooks/identities/use-identity-mutations";
import { useIdentityListForClient } from "@/hooks/identities/use-identity-queries";
import type { HostRpcRegistry } from "@/lib/host";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import { useIdentityTabsStore } from "@/stores/identities/identity-tabs-store";

export interface IdentitiesListPanelProps {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** Whether the host serves the family; `false` renders the unsupported note. */
  readonly supported: boolean;
  readonly onOpen: (identity: AgentIdentitySummary) => void;
}

export function IdentitiesListPanel(
  props: IdentitiesListPanelProps,
): ReactNode {
  const { hostId, client, supported, onOpen } = props;
  const listQuery = useIdentityListForClient(
    client,
    supported && hostId !== null,
  );
  const create = useIdentityCreateForClient(client);
  const remove = useIdentityDeleteForClient(client);
  const [newTitle, setNewTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AgentIdentitySummary | null>(
    null,
  );
  const now = useSampledNow();

  if (hostId === null) {
    return (
      <PanelNotice testId="identities-no-host">
        No host is active. Identities live on a host.
      </PanelNotice>
    );
  }
  if (!supported) {
    return (
      <PanelNotice testId="identities-unsupported">
        This host doesn&apos;t support identities yet. Update the host on this
        device to create one.
      </PanelNotice>
    );
  }

  const submitCreate = () => {
    const title = newTitle.trim();
    if (title.length === 0 || create.isPending) return;
    create.mutate(
      { clientRequestId: uuidv4(), title, description: null },
      {
        onSuccess: (response) => {
          setNewTitle("");
          onOpen(response.identity);
        },
      },
    );
  };

  const confirmDelete = () => {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    remove.mutate(
      { identityId: target.identityId },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          // The tab, if any, is bound to this identity; a deleted identity has
          // nothing left to show, so the tab goes with it.
          useIdentityTabsStore.getState().closeTab(target.identityId);
        },
        onError: () => {
          setDeleteTarget(null);
        },
      },
    );
  };

  const identities = listQuery.data?.identities;

  return (
    <div
      className="flex min-h-0 flex-col gap-3"
      data-testid="identities-list-panel"
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitCreate();
        }}
      >
        <Input
          value={newTitle}
          placeholder="New identity name"
          aria-label="New identity name"
          disabled={create.isPending}
          onChange={(event) => setNewTitle(event.target.value)}
          data-testid="identities-create-input"
        />
        <Button
          type="submit"
          size="sm"
          disabled={newTitle.trim().length === 0 || create.isPending}
          data-testid="identities-create-button"
        >
          <Plus className="size-3.5" />
          Create
        </Button>
        {create.isPending ? <MutedAgentSpinner /> : null}
      </form>
      <IdentitiesListBody
        identities={identities}
        failed={listQuery.isError}
        deleting={remove.isPending}
        now={now}
        onOpen={onOpen}
        onDelete={setDeleteTarget}
      />
      <ConfirmDestructiveDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete ${deleteTarget?.title ?? "this identity"}?`}
        description="Agents that used it keep their history, but the identity and its files leave this host."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={remove.isPending}
        blockedReason={null}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function IdentitiesListBody(props: {
  readonly identities: ReadonlyArray<AgentIdentitySummary> | undefined;
  readonly failed: boolean;
  readonly deleting: boolean;
  readonly now: number;
  readonly onOpen: (identity: AgentIdentitySummary) => void;
  readonly onDelete: (identity: AgentIdentitySummary) => void;
}): ReactNode {
  const { identities, failed, deleting, now, onOpen, onDelete } = props;
  if (identities === undefined) {
    if (failed) {
      return (
        <PanelNotice testId="identities-list-failed">
          Couldn&apos;t load identities from this host.
        </PanelNotice>
      );
    }
    return (
      <div
        className="flex flex-col gap-2"
        aria-busy="true"
        aria-label="Loading identities"
        data-testid="identities-list-loading"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }
  if (identities.length === 0) {
    return (
      <PanelNotice testId="identities-list-empty">
        <IdCard className="size-4" />
        No identities yet. Create one above.
      </PanelNotice>
    );
  }
  return (
    <ul
      className="flex min-h-0 flex-col gap-1 overflow-y-auto"
      data-testid="identities-list"
    >
      {identities.map((identity) => (
        <li
          key={identity.identityId}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/5"
          data-testid="identities-list-row"
          data-identity-id={identity.identityId}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen(identity)}
            data-testid="identities-list-open"
          >
            <span className="truncate text-ui-sm font-medium text-foreground">
              {identity.title.length > 0 ? identity.title : "Untitled identity"}
            </span>
            <span className="truncate text-ui-xs text-muted-foreground">
              {identity.description ?? "No description"} ·{" "}
              {formatRelativeTimestamp(identity.updatedAt, now)}
            </span>
          </button>
          <TooltipWrapper
            label="Delete"
            side="top"
            sideOffset={4}
            align={undefined}
          >
            <Button
              type="button"
              variant="destructive-ghost"
              size="icon-sm"
              aria-label={`Delete ${identity.title}`}
              disabled={deleting}
              onClick={() => onDelete(identity)}
              data-testid="identities-list-delete"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </TooltipWrapper>
        </li>
      ))}
    </ul>
  );
}

function PanelNotice(props: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="flex flex-col items-center justify-center gap-2 py-10 text-center text-ui-sm text-muted-foreground"
    >
      {props.children}
    </div>
  );
}
