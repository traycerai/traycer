import { ImportedUnseenDot } from "@/components/session-import/imported-unseen-dot";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  hasSharedLabelOwner,
  labelOwnerName,
} from "./organization-label-owner";
import type { CSSProperties } from "react";
import { Group, Tag } from "lucide-react";
import type {
  LabelDefinition,
  TaskOrganization,
} from "@traycer/protocol/host/organization/schemas";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import {
  useOrganization,
  taskOrganization,
} from "@/hooks/organization/organization-context";
const iconSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function OrganizationDot({ color }: { readonly color: string | null }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full bg-[var(--organization-color)]"
      style={
        {
          "--organization-color": color ?? "var(--muted-foreground)",
        } as CSSProperties
      }
    />
  );
}
export function OrganizationDetails(props: {
  readonly taskId: string;
  readonly fallback: TaskOrganization | undefined;
}) {
  const organization = useOrganization();
  const data = taskOrganization(
    organization?.view,
    props.taskId,
    props.fallback,
  );
  const showOwners = hasSharedLabelOwner(
    data?.labels ?? [],
    organization?.userId ?? null,
  );
  const collaborators = useEpicCollaboratorsQuery(props.taskId, {
    client: organization?.client ?? null,
    enabled: organization?.supported === true && showOwners,
    poll: false,
    staleTime: 30000,
  });
  if (!data) return null;
  return (
    <div className="space-y-1 text-ui-xs">
      {data.group ? (
        <div className="flex items-center gap-1.5">
          <Group className="size-3" />
          <span>Group: {data.group.name}</span>
        </div>
      ) : null}
      {data.labels.map((label) => (
        <div
          key={`${label.ownerId}:${label.labelId}`}
          className="flex min-w-0 items-center gap-1.5"
        >
          <Tag className="size-3 shrink-0" />
          <span className="min-w-0 break-words">
            {label.name}
            {label.kind === "system" || showOwners
              ? ` · ${
                  label.ownerId === organization?.userId
                    ? "You"
                    : (collaborators.data?.flatRows.find(
                        (row) => row.userId === label.ownerId,
                      )?.displayName ??
                      labelOwnerName(label, organization?.userId ?? null))
                }`
              : null}
          </span>
        </div>
      ))}
      <OrganizationSyncNote taskId={props.taskId} labels={data.labels} />
    </div>
  );
}
export function OrganizationMetadata(props: {
  readonly taskId: string;
  readonly canEdit: boolean;
  readonly fallback: TaskOrganization | undefined;
}) {
  const organization = useOrganization();
  const data = taskOrganization(
    organization?.view,
    props.taskId,
    props.fallback,
  );
  if (!data || (!data.group && data.labels.length === 0)) return null;
  const visible = data.labels.slice(0, data.group ? 1 : 2);
  const overflow = data.labels.length - visible.length;
  const showOwners = hasSharedLabelOwner(
    data.labels,
    organization?.userId ?? null,
  );
  const description = [
    data.group ? `Group: ${data.group.name}` : "",
    ...data.labels.map(
      (l) =>
        `Label: ${l.name}${l.kind === "system" || showOwners ? ` (${labelOwnerName(l, organization?.userId ?? null)})` : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("; ");
  return (
    <TooltipWrapper
      label={
        <OrganizationDetails taskId={props.taskId} fallback={props.fallback} />
      }
      side="top"
      sideOffset={6}
      align="end"
    >
      <button
        type="button"
        className="pointer-events-auto flex max-w-[35%] min-w-0 shrink items-center gap-1 overflow-hidden rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Task organization: ${description}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          organization?.openDialog({
            kind: "labels",
            taskId: props.taskId,
            canEdit: props.canEdit,
          });
        }}
      >
        {data.group ? (
          <span
            className="flex min-w-0 shrink items-center gap-1 rounded px-1.5 py-0.5 text-ui-xs font-medium text-foreground bg-[color-mix(in_srgb,var(--organization-color)_28%,transparent)]"
            style={
              { "--organization-color": data.group.color } as CSSProperties
            }
          >
            <Group className="size-3 shrink-0" />
            <span className="truncate">{data.group.name}</span>
          </span>
        ) : null}
        {visible.map((label) => (
          <span
            key={`${label.ownerId}:${label.labelId}`}
            className="flex min-w-0 shrink items-center gap-1 rounded border border-border px-1.5 py-0.5 text-ui-xs text-muted-foreground"
          >
            <OrganizationDot color={label.color} />
            <span className="truncate">{label.name}</span>
          </span>
        ))}
        {overflow > 0 ? (
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            +{overflow}
          </span>
        ) : null}
      </button>
    </TooltipWrapper>
  );
}
export function TaskPersonalDecoration(props: {
  readonly taskId: string;
  readonly fallback: TaskOrganization | undefined;
}) {
  const organization = useOrganization();
  const data = taskOrganization(
    organization?.view,
    props.taskId,
    props.fallback,
  );
  if (!data) return null;
  return (
    <>
      {data.appearance.icon ? (
        <span
          className="shrink-0 text-ui-xs"
          aria-label={`Custom icon: ${data.appearance.icon}`}
        >
          {Array.from(
            iconSegmenter.segment(data.appearance.icon),
            (part) => part.segment,
          )
            .slice(0, 2)
            .join("")}
        </span>
      ) : null}
      {!data.group && data.appearance.color ? (
        <span className="flex shrink-0 items-center">
          <OrganizationDot color={data.appearance.color} />
        </span>
      ) : null}
    </>
  );
}

export function OrganizationSyncNote(props: {
  readonly taskId: string | null;
  readonly labels: readonly LabelDefinition[];
  readonly includeGroups?: boolean;
}) {
  const organization = useOrganization();
  const view = organization?.view;
  const scopes = new Set(
    props.labels
      .filter((label) => label.ownerId === organization?.userId)
      .map((label) => `label:${label.labelId}`),
  );
  if (props.includeGroups) scopes.add("groups");
  if (props.taskId !== null) {
    scopes.add(`labels:${props.taskId}`);
    scopes.add(`appearance:${props.taskId}`);
    scopes.add(`automation:${props.taskId}`);
  }
  // Group delivery has only a collection-wide scope; it cannot identify work
  // affecting this task, so do not present it as this task's pending change.
  if (!view?.pending.some((pending) => scopes.has(pending.scope))) return null;
  return (
    <p role="status" className="text-ui-xs text-muted-foreground">
      {view.authenticationRequired
        ? "Sign in to sync your changes"
        : "Waiting to sync"}
    </p>
  );
}

/** Cloud tasks use the permanent Imported label; keep older/local history behavior. */
export function HistoryImportedStatus({
  item,
}: {
  readonly item: HistoryItem;
}) {
  const organization = useOrganization();
  if (
    organization?.supported &&
    item.taskType === "epic" &&
    !item.isLocalHome &&
    !item.isPreservedOrphan
  )
    return null;
  return <ImportedUnseenDot epicId={item.epicId} />;
}
