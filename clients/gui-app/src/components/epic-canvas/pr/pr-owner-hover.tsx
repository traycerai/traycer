import { useState, type ReactNode } from "react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import { HoverPreviewCard } from "@/components/ui/hover-preview-card";
import { PrOwnerTreeList } from "@/components/epic-canvas/pr/pr-owner-label";
import { prOwnerCollectionNouns } from "@/components/epic-canvas/pr/pr-owner-tree";
import { PrRowHoverCardContext } from "@/components/epic-canvas/pr/pr-owner-hover-context";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { usePresentPrOwners } from "@/hooks/pr/use-present-pr-owners";

/**
 * Hovering anywhere on a PR row reveals every chat/terminal agent the PR came
 * from, each a link that opens its tile.
 *
 * The row already ends in a band of owner badges, but that band is capped at
 * four and truncates each title to a pill, so on the rows where the question
 * "which conversation produced this?" is hardest to answer - a PR a dozen
 * sub-agents contributed to - it answers least. The badges stay: per
 * `hover-card.tsx`, hover-card content is deliberately outside the tab order,
 * so the badges and the `+N` popover behind them are the keyboard-reachable
 * home these links require, not a redundancy to retire.
 *
 * Wraps the row rather than rendering beside it, so the trigger is the whole
 * row. `children` is returned UNWRAPPED whenever there is nothing to show,
 * which means a row without owners is never a dead trigger that waits half a
 * second to open an empty card.
 */
export function PrRowOwnerHover(props: {
  readonly owners: readonly PrOwnerRef[];
  readonly epicId: string;
  /**
   * Host to open a legacy owner on when its own `hostId` predates the field -
   * see `PrOwnerBadges`, whose `fallbackHostId` this must agree with. The two
   * surfaces list the same owners; opening one from the badge and from the
   * hover card has to land on the same host.
   */
  readonly fallbackHostId: string | null;
  /**
   * The PR's title, which the card heads itself with - `null` for a never-swept
   * row that has none. The row's own title band truncates to one line, so this
   * is where the whole string is legible; see `PrRowHoverCardContext`.
   */
  readonly title: string | null;
  readonly children: ReactNode;
}): ReactNode {
  if (props.owners.length === 0) return props.children;
  // Everything below reads the epic projection and throws without an
  // `OpenEpicStore` handle, which the PR list does NOT wait for: the rows
  // arrive on their own host stream, and `EpicSessionProvider` renders children
  // before it holds a handle. Ungated, that window took the route's error
  // boundary down (see `PrOwnerBadges`). The fallback is the row itself: no
  // hover until the session lands, never a missing row.
  //
  // The handle is necessary but NOT sufficient. On a current host the titles
  // these owners resolve to come from the store-backed record plane
  // (`epic.listChatRecords` / `host.chatRecords.subscribe`), which the union in
  // `OpenEpicState.chats` fills after the handle exists - the Y.Doc `docChats`
  // half is doc-only mode, for hosts predating those methods. So `owners`
  // below can still be empty against a live session, and the card appears on
  // the render the records land.
  return (
    <EpicSessionGate fallback={props.children}>
      <ResolvedPrRowOwnerHover {...props} />
    </EpicSessionGate>
  );
}

function ResolvedPrRowOwnerHover(props: {
  readonly owners: readonly PrOwnerRef[];
  readonly epicId: string;
  readonly fallbackHostId: string | null;
  readonly title: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const owners = usePresentPrOwners(props.owners);
  // Controlled purely so opening an owner dismisses the card. Left uncontrolled
  // it would sit over the tile it just opened until the pointer happened to
  // leave the row.
  const [open, setOpen] = useState(false);
  // Not `useCallback`: this file is compiler-managed, so hand-memoizing it is
  // the redundancy `react-compiler-no-manual-memoization` names. The sibling
  // `PrOwnerOverflow` still wraps its own `close` - pre-existing, not a
  // precedent.
  const close = (): void => setOpen(false);
  // Every owner's node is gone. `usePresentPrOwners` explains why that outlives
  // the PR; here it means the same as no owners at all.
  if (owners.length === 0) return props.children;
  const nouns = prOwnerCollectionNouns(owners);
  const label = `${nouns.capitalized} this PR came from`;
  return (
    // OUTSIDE the card, not around `children`: `HoverCardTrigger asChild`
    // clones its immediate child to attach the trigger's handlers and ref, and
    // a context provider is not a slottable element - put one there and the
    // trigger silently stops opening. Context reads by tree position, so the
    // row still sees this from where it renders below.
    //
    // Only the branch that ACTUALLY renders a card announces one: every early
    // return above hands `children` back untouched and leaves the context at
    // its `false` default, which is what keeps the title tooltip wired on a row
    // that has no card.
    <PrRowHoverCardContext value={props.title !== null}>
      <HoverPreviewCard
        open={open}
        onOpenChange={setOpen}
        // The panel this row lives in is docked left, so the card flies out over
        // the canvas instead of over the sibling rows the reader is scanning.
        // Radix flips it on collision.
        side="right"
        align="start"
        sideOffset={8}
        content={
          <div
            // Sized by content, capped in both axes - the same contract as the
            // `+N` popover, and for the same reasons: a short list of short
            // titles should not paint a fixed empty column, and a deep lineage
            // whose indent eats the title column should get the room a wide
            // display already has. The var carries a fallback because an
            // unmeasured one invalidates the whole `min()`.
            className="flex w-max max-w-[min(80vw,var(--radix-hover-card-content-available-width,100vw),28rem)] flex-col"
            data-testid="pr-row-owner-hover"
          >
            {props.title === null ? null : (
              // Wraps rather than truncates - the row already truncated it, and
              // being the one place the whole title is legible is why the row's
              // own tooltip stands down (`PrRowHoverCardContext`).
              <p
                className="shrink-0 border-b px-3 py-2 text-ui-sm font-medium text-foreground"
                data-testid="pr-row-owner-hover-title"
              >
                {props.title}
              </p>
            )}
            <p className="shrink-0 px-3 pt-2 pb-1 text-ui-xs text-muted-foreground">
              {label}
            </p>
            <PrOwnerTreeList
              owners={owners}
              label={label}
              epicId={props.epicId}
              fallbackHostId={props.fallbackHostId}
              onOpened={close}
              testId="pr-row-owner-hover-list"
              // Floored against the space Radix measured rather than a rem, so a
              // tall display shows more of a long list instead of the same few
              // rows.
              className="max-h-[min(var(--radix-hover-card-content-available-height,100vh),60vh)]"
            />
          </div>
        }
      >
        {props.children}
      </HoverPreviewCard>
    </PrRowHoverCardContext>
  );
}
