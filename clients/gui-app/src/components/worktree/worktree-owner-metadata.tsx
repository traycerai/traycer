import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Slot } from "radix-ui";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HoverPreviewCard } from "@/components/ui/hover-preview-card";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { OwnerWorkspaceMetadataContent } from "@/components/worktree/worktree-pr-metadata";
import type { WorktreePrReference } from "@/components/worktree/worktree-pr-metadata-model";
import { WorktreeOwnerSettingsHeader } from "@/components/worktree/worktree-owner-settings-header";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useOwnerListPrReferences } from "@/hooks/pr/use-owner-pr-references";
import { makePrDetailTile } from "@/lib/pr/pr-detail-tile";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { useWorktreeOwnerMetadata } from "@/hooks/worktree/use-worktree-owner-metadata-query";
import { useBareKeyClaimer } from "@/lib/keybindings/use-bare-key-claimer";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { tileIntent } from "@/lib/canvas/tile-open/intent";

// The git probes this forces are disk-bound and the `gh` PR probe is a network call, so the spinner gets a
// longer leash than the Settings toolbar's 10s.
const OWNER_METADATA_REFRESH_TIMEOUT_MS = 20_000;

/** Hover state gated on a press, the same shape the composer's folder picker uses
 * (`workspace-folder-summary-control.tsx`). */
interface OwnerMetadataHoverState {
  /** Cleared on pointer-enter, never on pointer-leave. */
  readonly pressed: boolean;
  readonly hoverOpen: boolean;
}

const CLOSED_HOVER_STATE: OwnerMetadataHoverState = {
  pressed: false,
  hoverOpen: false,
};

export function WorktreeOwnerMetadataTooltip(props: {
  readonly trigger: ReactElement;
  readonly title: string;
  readonly hostId: string;
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly supplementalContent: ReactNode | null;
  readonly side: "top" | "right" | "bottom" | "left";
}): ReactNode {
  const [hoverState, setHoverState] =
    useState<OwnerMetadataHoverState>(CLOSED_HOVER_STATE);
  const open = !hoverState.pressed && hoverState.hoverOpen;
  const client = useHostClientForHostId(props.hostId);
  const { openTile } = useEpicTileNavigation();
  const openPrInApp = (reference: WorktreePrReference): void => {
    if (
      reference.githubHost === null ||
      reference.owner === null ||
      reference.repo === null
    ) {
      return;
    }
    openTile(
      tileIntent(
        makePrDetailTile({
          hostId: props.hostId,
          githubHost: reference.githubHost,
          owner: reference.owner,
          repo: reference.repo,
          prNumber: reference.prNumber,
          name: `${reference.repo} #${reference.prNumber}`,
        }),
        { epicId: props.epicId },
        "explicit",
        "direct_ui",
      ),
    );
  };
  const metadata = useWorktreeOwnerMetadata({
    client,
    epicId: props.epicId,
    ownerId: props.ownerId,
    ownerKind: props.ownerKind,
    binding: undefined,
    enabled: open,
  });
  const ownerPr = useOwnerListPrReferences({
    hostId: props.hostId,
    epicId: props.epicId,
    ownerId: props.ownerId,
    ownerKind: props.ownerKind,
    enabled: open,
  });
  const refreshMetadata = metadata.refresh;
  const sendOwnerPrRefresh = ownerPr.sendRefresh;
  const refreshOwnerMetadata = useCallback(async (): Promise<void> => {
    sendOwnerPrRefresh();
    await refreshMetadata();
  }, [refreshMetadata, sendOwnerPrRefresh]);
  const refresh = useRefreshSpinner({
    onRefresh: refreshOwnerMetadata,
    externalRefreshing: metadata.isRefreshing,
    timeoutMs: OWNER_METADATA_REFRESH_TIMEOUT_MS,
  });
  const trigger = refresh.trigger;
  const canRefresh = client !== null;
  // Claimed through the shared owner rather than bound at the window directly.
  const claimRefreshKey = useBareKeyClaimer("r", (event) => {
    event.preventDefault();
    trigger();
  });
  useEffect(
    () => (open && canRefresh ? claimRefreshKey() : undefined),
    [canRefresh, claimRefreshKey, open],
  );
  return (
    <HoverPreviewCard
      content={
        // The title and workspace blocks stretch to that resolved width without voting on it.
        <div
          className="block w-fit min-w-[min(92vw,24rem)] max-w-[min(92vw,36rem)]"
          data-testid={`chat-navigator-worktree-hover-${props.ownerId}`}
        >
          <span
            className="block w-0 min-w-full break-words border-b border-border/70 px-3 py-2 text-ui-sm font-medium text-foreground"
            data-testid={`chat-navigator-hover-title-${props.ownerId}`}
          >
            {props.title}
          </span>
          <WorktreeOwnerSettingsHeader
            ownerId={props.ownerId}
            hostId={props.hostId}
            epicId={props.epicId}
            ownerKind={props.ownerKind}
          />
          {/* Its run path is `break-all`, but break points do not shrink an element's max-content contribution. */}
          <span className="block w-0 min-w-full">
            <OwnerWorkspaceMetadataContent
              binding={metadata.binding}
              worktrees={metadata.worktrees}
              workspaces={metadata.workspaces}
              prReferences={ownerPr.references}
              pending={metadata.isPending || ownerPr.isPending}
              hostUnavailable={metadata.hostUnavailable}
              error={metadata.error !== null || ownerPr.error}
              openPrInApp={openPrInApp}
            />
          </span>
          {props.supplementalContent === null ? null : (
            <div className="border-t border-border px-3 py-2">
              {props.supplementalContent}
            </div>
          )}
          <OwnerMetadataRefreshFooter
            checkedAt={metadata.checkedAt}
            refreshing={refresh.refreshing}
            canRefresh={canRefresh}
            onRefresh={trigger}
          />
        </div>
      }
      side={props.side}
      sideOffset={4}
      align="start"
      open={open}
      // A late open is swallowed rather than recorded while pressed.
      onOpenChange={(next) => {
        setHoverState((current) => {
          if (next && current.pressed) return current;
          return { ...current, hoverOpen: next };
        });
      }}
    >
      {/* Radix only reports a transition its controlled `open` does not already match, so once this holds `open` at
         false, the close that would otherwise re-arm it is never announced. */}
      <Slot.Root
        // The re-arm, and the only one - see `pressed`. Deliberately leaves `hoverOpen` alone: if the card is already
        // open and the pointer travels back from the content onto the row, this must not re-trigger anything.
        onPointerEnter={() => {
          setHoverState((current) =>
            current.pressed ? { ...current, pressed: false } : current,
          );
        }}
        // No `onPointerLeave` counterpart: leaving must not clear `hoverOpen` either, or the card would close as the
        // pointer crosses the 4px gap into it - and that card holds a Refresh button.
        onPointerDown={() => setHoverState({ pressed: true, hoverOpen: false })}
        // Keyboard activation (Enter/Space on a focused row) fires no pointerdown at all, and Radix opens on focus -
        // so without this the card could settle over the tab the keypress just opened.
        onClick={() => setHoverState({ pressed: true, hoverOpen: false })}
      >
        {props.trigger}
      </Slot.Root>
    </HoverPreviewCard>
  );
}

/** It refreshes the folders and nothing else - not the run settings above - so it carries the folder list's own
 * hairline rather than the `border-border/70` section rule that divides settings from folders. */
function OwnerMetadataRefreshFooter(props: {
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
  readonly canRefresh: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  return (
    <span className="block px-3">
      <span className="flex items-center justify-between gap-2 border-t border-border/25 py-1.5">
        <OwnerMetadataCheckedAt
          checkedAt={props.checkedAt}
          refreshing={props.refreshing}
        />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label="Refresh workspace details"
          aria-keyshortcuts="R"
          disabled={!props.canRefresh || props.refreshing}
          // The pointer is what holds a HoverCard open; letting the button take
          // focus on press would pull it away from the trigger.
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onRefresh}
          data-testid="owner-workspace-refresh"
        >
          {props.refreshing ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId="owner-workspace-refresh-spinner"
              variant={undefined}
            />
          ) : null}
          Refresh
          <ShortcutHint>
            <Kbd className="ml-0.5 font-mono">R</Kbd>
          </ShortcutHint>
        </Button>
      </span>
    </span>
  );
}

/** Isolated in its own leaf because `useCompactRelativeTime` re-renders on a shared 60s tick - keeping it here
 * means the tick repaints this one span rather than the whole card. */
function OwnerMetadataCheckedAt(props: {
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
}): ReactNode {
  if (props.refreshing) {
    return <span className="text-ui-xs text-muted-foreground">Checking…</span>;
  }
  if (props.checkedAt === null) return <span />;
  return <OwnerMetadataCheckedAtText checkedAt={props.checkedAt} />;
}

function OwnerMetadataCheckedAtText(props: {
  readonly checkedAt: number;
}): ReactNode {
  const relative = useCompactRelativeTime(props.checkedAt);
  return (
    <span
      className="text-ui-xs whitespace-nowrap text-muted-foreground"
      data-testid="owner-workspace-checked-at"
    >
      Workspace snapshot · {relative}
    </span>
  );
}
