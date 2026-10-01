import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HoverCard } from "@/components/ui/hover-card";
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

// The git probes this forces are disk-bound and the `gh` PR probe is a network
// call, so the spinner gets a longer leash than the Settings toolbar's 10s -
// but still a leash, so a wedged host can't strand the button disabled.
const OWNER_METADATA_REFRESH_TIMEOUT_MS = 20_000;

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
  // Controlled only to know when the card is up: the metadata queries and the
  // `R` claim run while it is, and never for a row nobody is looking at.
  const [open, setOpen] = useState(false);
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
  // The card never takes focus (it opens on hover, or on the row's own
  // keyboard focus), so `R` can only work if it is caught at the window - the
  // caret stays wherever it already was, which in a chat tab is the composer.
  //
  // Deliberately NOT skipped when the focus is a text field. That guard is the
  // usual reflex for a bare-letter shortcut bound this high, and it is what
  // made `R` type an "r" into the composer instead of refreshing. The card only
  // exists while the pointer is deliberately resting on the row, and it is a
  // large visible overlay while it is - so the open card, not the caret, is
  // what the keystroke belongs to. The cost is real but narrow: typing into the
  // composer with the pointer parked over a sidebar row loses that one "r".
  //
  // `canRefresh` repeats the button's own disabled condition rather than
  // relying on it: a disabled button ignores clicks, but nothing stops this
  // listener, and firing without a client would reject straight into the
  // failure toast.
  //
  // Claimed through the shared owner rather than bound at the window directly:
  // the folder-mapping picker claims bare `R` too and can be open in the same
  // pane, and two raw window listeners would both fire for one keystroke. Last
  // claim wins, so whichever overlay opened most recently owns the key - which
  // is why the claim depends only on this card being OPEN. `trigger` changes
  // identity whenever `refreshing` toggles, and re-claiming on that would let
  // this card jump back above a picker that opened after it, purely because a
  // refresh finished. See `useBareKeyClaimer`.
  const claimRefreshKey = useBareKeyClaimer("r", (event) => {
    event.preventDefault();
    trigger();
  });
  useEffect(
    () => (open && canRefresh ? claimRefreshKey() : undefined),
    [canRefresh, claimRefreshKey, open],
  );
  return (
    <HoverCard
      trigger={props.trigger}
      content={
        // Sized by the run-settings row, between a floor and a ceiling. The
        // title and workspace blocks stretch to that resolved width without
        // voting on it. The settings line is a single unbreakable unit - model,
        // reasoning, permission mode - and wrapping it onto a second line was
        // worse than a wider card: it pushed the permission mode, the one value
        // here with a safety consequence, below the fold of the eye. So the
        // card grows to fit it instead, from the old fixed 24rem (now the floor,
        // so a short line still gets a card that reads as a card) up to a
        // viewport-capped ceiling, past which the header ellipsizes rather than
        // growing further.
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
          {/* `w-0 min-w-full` so the folder block takes the width the header
              settled on WITHOUT voting on it. Its run path is `break-all`, but
              break points do not shrink an element's max-content contribution -
              a 90-character worktree path would peg every card at the ceiling
              regardless of how short its settings line was. Width 0 removes it
              from that intrinsic calculation; the percentage min-width then
              stretches it back to the resolved width. */}
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
      appearance="preview"
      semantics={{ role: "dialog", label: props.title }}
      side={props.side}
      sideOffset={4}
      align="start"
      enabled
      open={open}
      onOpenChange={setOpen}
      testId={null}
      className={null}
    />
  );
}

/**
 * The last row OF THE FOLDER LIST: how old the folder facts are, and the action
 * that re-derives them. It refreshes the folders and nothing else - not the run
 * settings above - so it carries the folder list's own hairline rather than the
 * `border-border/70` section rule that divides settings from folders. At the
 * section weight it read as a card-wide banner, as if Refresh would re-fetch
 * the model and permission mode too.
 *
 * The rule is INSET by the card's `px-3` (padding on the outer span, border on
 * the inner one) so it matches the folder dividers exactly - those come from a
 * `divide-y` inside the scroll container's own padding, so they stop short of
 * both edges. An edge-to-edge rule at the same weight still read as a section
 * break rather than as one more line in the list.
 *
 * Outside the scroll container on purpose: a long folder list scrolls under a
 * pinned Refresh rather than scrolling it out of reach.
 */
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
              className={undefined}
              testId="owner-workspace-refresh-spinner"
              variant={undefined}
              tone="muted"
            />
          ) : null}
          Refresh
          <ShortcutHint>
            <Kbd className="ml-0.5" variant="mono">
              R
            </Kbd>
          </ShortcutHint>
        </Button>
      </span>
    </span>
  );
}

/**
 * Isolated in its own leaf because `useCompactRelativeTime` re-renders on a
 * shared 60s tick - keeping it here means the tick repaints this one span
 * rather than the whole card.
 */
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
