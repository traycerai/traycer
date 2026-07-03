// TODO: extract a shared `<StatusBarTile>` between this file and
// `./ticket-tile.tsx` - the two implementations only differ in
// `artifactType` ("story" vs. "ticket"), the test-id, and the props
// interface name. Holding off because the canvas tiles thread per-artifact
// hooks (`useEpicArtifact`, `useEpicConnectionStatus`,
// `useEpicUpdateArtifactStatus`) that the shared component would need to
// re-derive cleanly without growing the tile-level prop surface.
import { CollabTileBody } from "./collab-tile-body";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEpicUpdateArtifactStatus } from "@/hooks/epic/use-epic-node-mutations";
import {
  useEpicArtifact,
  useEpicConnectionStatus,
  useEpicPermissionRole,
  useEpicSnapshotMeta,
} from "@/lib/epic-selectors";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { isEditableRole } from "@/lib/epic-permissions";
import { cn } from "@/lib/utils";

interface StoryTileProps {
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

const STATUS_OPTIONS = [
  { value: 0, label: "Todo", dotClass: "bg-slate-400" },
  { value: 1, label: "In Progress", dotClass: "bg-amber-500" },
  { value: 2, label: "Done", dotClass: "bg-emerald-500" },
] as const;

function StatusPill(props: {
  artifactId: string;
  artifactType: "ticket" | "story";
}) {
  const { artifactId, artifactType } = props;
  const meta = useEpicSnapshotMeta();
  const epicId = meta?.epicLight?.id ?? "";
  const liveArtifact = useEpicArtifact(artifactId);
  const role = useEpicPermissionRole();
  const canEdit = isEditableRole(role);
  const connectionStatus = useEpicConnectionStatus();
  const isDisconnected = connectionStatus === "closed";
  const updateStatus = useEpicUpdateArtifactStatus();

  const currentStatus =
    (liveArtifact !== null && "kind" in liveArtifact
      ? liveArtifact.status
      : null) ?? 0;
  const current =
    STATUS_OPTIONS.find((o) => o.value === currentStatus) ?? STATUS_OPTIONS[0];

  if (!canEdit) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1 text-ui-xs text-muted-foreground">
        <span className={cn("size-2 rounded-full", current.dotClass)} />
        {current.label}
      </span>
    );
  }

  if (isDisconnected) {
    return (
      <TooltipWrapper
        label="Reconnect to make changes."
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1 text-ui-xs text-muted-foreground opacity-50">
          <span className={cn("size-2 rounded-full", current.dotClass)} />
          {current.label}
        </span>
      </TooltipWrapper>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={updateStatus.isPending || !epicId}
          data-testid="status-pill"
          className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1 text-ui-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          {updateStatus.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <span className={cn("size-2 rounded-full", current.dotClass)} />
          )}
          {current.label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="status-pill-menu">
        {STATUS_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            data-testid={`status-option-${option.value}`}
            onSelect={() => {
              if (option.value === currentStatus) return;
              updateStatus.mutate({
                epicId,
                artifactId,
                artifactType,
                status: option.value,
              });
            }}
          >
            <span className={cn("size-2 rounded-full", option.dotClass)} />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StoryTile(props: StoryTileProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-canvas-border/40 px-6 py-2">
        <StatusPill artifactId={props.node.id} artifactType="story" />
      </div>
      <CollabTileBody
        node={props.node}
        viewTabId={props.viewTabId}
        tileId={props.tileId}
        isActive={props.isActive}
        testId="story-tile"
      />
    </div>
  );
}
