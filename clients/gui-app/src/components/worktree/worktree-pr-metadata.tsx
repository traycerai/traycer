import { use, type MouseEvent, type ReactNode } from "react";
import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import {
  ExternalLink,
  FolderGit2,
  GitBranch,
  PanelsTopLeft,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { HOVER_PREVIEW_SCROLL_CLASS } from "@/components/ui/hover-preview-surface";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";
import {
  ownerWorkspaceMetadataItems,
  worktreePrReferences,
  type WorktreeDisplayedPrState,
  type WorktreePrReference,
} from "@/components/worktree/worktree-pr-metadata-model";
import {
  PR_STATE_ICON,
  PR_STATE_PILL_CLASS,
  PR_STATE_TINT_CLASS,
} from "@/components/worktree/worktree-pr-state-palette";

/**
 * PR pills for the Epic history list (page background) and the chat/owner
 * hover preview (the `bg-popover` hover-preview card). Both are normal,
 * non-inverted surfaces, so one palette covers them - and it now lives in
 * `worktree-pr-state-palette.ts` (`PR_STATE_PILL_CLASS` + `PR_STATE_TINT_CLASS`)
 * alongside the glyph ramp, shared with the sidebar's icon variant and the
 * Epic PR panel row.
 *
 * **The LABEL's contrast comes from `text-foreground`, not a tuned ramp.** It
 * used to be `-800` light / `-300` dark, picked against the pill's own 10%
 * tint. Coloured label text is gone, so that tuning no longer applies here:
 * `text-foreground` is the theme's own body-text token, already contrast-checked
 * against every preset surface. The tuning did NOT become moot, though - the
 * state GLYPH inherited the job of carrying the state, so it inherited the ramp.
 */
export function WorktreePrPills(props: {
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly detailOnHover: boolean;
  readonly maximumVisible: number | null;
  readonly className: string | undefined;
  readonly testId: string;
  readonly openPrInApp: ((reference: WorktreePrReference) => void) | null;
}): ReactNode {
  const references = worktreePrReferences(props.worktrees);
  if (references.length === 0) return null;
  const visibleReferences =
    props.maximumVisible === null
      ? references
      : references.slice(0, props.maximumVisible);
  const overflowReferences =
    props.maximumVisible === null ? [] : references.slice(props.maximumVisible);
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1", props.className)}
      data-testid={props.testId}
    >
      {visibleReferences.map((reference) => (
        <WorktreePrPill
          key={reference.key}
          reference={reference}
          detailOnHover={props.detailOnHover}
          flexible={props.maximumVisible !== null}
          openPrInApp={props.openPrInApp}
        />
      ))}
      {overflowReferences.length === 0 ? null : (
        <WorktreePrOverflow
          references={overflowReferences}
          openPrInApp={props.openPrInApp}
        />
      )}
    </span>
  );
}

function WorktreePrPill(props: {
  readonly reference: WorktreePrReference;
  readonly detailOnHover: boolean;
  readonly flexible: boolean;
  readonly openPrInApp: ((reference: WorktreePrReference) => void) | null;
}): ReactNode {
  // The pill is a real PR link everywhere it renders - the Epic history list
  // and the chat/owner hover preview (now an interactive HoverCard, so a
  // focusable `<a>` no longer duplicates into a Tooltip a11y clone).
  const pill = (
    <Badge
      asChild
      variant="outline"
      className={cn(
        "group/pr-pill gap-1.5 rounded-full px-2 font-medium",
        props.flexible && "min-w-0 shrink",
        PR_STATE_PILL_CLASS[props.reference.state],
      )}
    >
      <WorktreePrAnchor
        reference={props.reference}
        openPrInApp={props.openPrInApp}
        className={cn("max-w-[min(60vw,16rem)]", props.flexible && "min-w-0")}
      />
    </Badge>
  );
  if (!props.detailOnHover) return pill;
  return (
    <TooltipWrapper
      label={<WorktreePrHoverDetail reference={props.reference} />}
      side="top"
      sideOffset={6}
      align="start"
    >
      {pill}
    </TooltipWrapper>
  );
}

function WorktreePrOverflow(props: {
  readonly references: readonly WorktreePrReference[];
  readonly openPrInApp: ((reference: WorktreePrReference) => void) | null;
}): ReactNode {
  const count = props.references.length;
  return (
    <Popover>
      <Badge
        asChild
        variant="outline"
        className="cursor-pointer border-border bg-background font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PopoverTrigger
          aria-label={`Show ${count} more pull request${count === 1 ? "" : "s"}`}
          data-testid="worktree-pr-overflow-trigger"
        >
          +{count}
        </PopoverTrigger>
      </Badge>
      <PopoverContent
        aria-label="More pull requests"
        align="end"
        sideOffset={6}
        className="w-[min(90vw,24rem)]"
        data-testid="worktree-pr-overflow-content"
      >
        <span className="text-ui-xs font-medium text-muted-foreground">
          More pull requests
        </span>
        <span className="flex flex-wrap gap-1.5">
          {props.references.map((reference) => (
            <WorktreePrPill
              key={reference.key}
              reference={reference}
              detailOnHover={false}
              flexible={false}
              openPrInApp={props.openPrInApp}
            />
          ))}
        </span>
      </PopoverContent>
    </Popover>
  );
}

function WorktreePrPillContent(props: {
  readonly label: string;
  readonly state: WorktreeDisplayedPrState;
  readonly opensInApp: boolean;
}): ReactNode {
  const StateIcon = PR_STATE_ICON[props.state];
  return (
    <>
      <StateIcon
        aria-hidden
        data-testid="worktree-pr-pill-state-glyph"
        className={cn("size-3 shrink-0", PR_STATE_TINT_CLASS[props.state])}
      />
      <span className="truncate tabular-nums">{props.label}</span>
      {/* Revealed on hover/focus rather than always-on. Every pill is a link,
          so a permanent icon on each one is redundant chrome repeated N times;
          on hover it confirms the affordance exactly when it is being
          considered. `opacity` (not conditional mount) so the pill's width is
          identical in both states and a row of them cannot reflow on hover. */}
      {props.opensInApp ? (
        <PanelsTopLeft
          className="size-3 shrink-0 opacity-0 transition-opacity group-hover/pr-pill:opacity-60 group-focus-visible/pr-pill:opacity-60"
          aria-hidden
        />
      ) : (
        <ExternalLink
          className="size-3 shrink-0 opacity-0 transition-opacity group-hover/pr-pill:opacity-60 group-focus-visible/pr-pill:opacity-60"
          aria-hidden
        />
      )}
    </>
  );
}

function WorktreePrAnchor(props: {
  readonly reference: WorktreePrReference;
  readonly className: string | undefined;
  readonly openPrInApp: ((reference: WorktreePrReference) => void) | null;
}): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const openPr = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.stopPropagation();
    if (props.openPrInApp !== null && hasNativePrCoordinates(props.reference)) {
      event.preventDefault();
      props.openPrInApp(props.reference);
      return;
    }
    if (runnerHost === null) return;
    event.preventDefault();
    openExternalLink.mutate(props.reference.url);
  };
  return (
    <a
      href={props.reference.url}
      target="_blank"
      rel="noreferrer"
      aria-label={props.reference.ariaLabel}
      className={props.className}
      data-testid="worktree-context-pr-pill"
      data-pr-state={props.reference.state}
      onClick={openPr}
    >
      <WorktreePrPillContent
        label={props.reference.label}
        state={props.reference.state}
        opensInApp={
          props.openPrInApp !== null && hasNativePrCoordinates(props.reference)
        }
      />
    </a>
  );
}

function hasNativePrCoordinates(
  reference: WorktreePrReference,
): reference is WorktreePrReference & {
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
} {
  return (
    reference.githubHost !== null &&
    reference.owner !== null &&
    reference.repo !== null
  );
}

function WorktreePrHoverDetail(props: {
  readonly reference: WorktreePrReference;
}): ReactNode {
  return (
    <span className="flex max-w-[min(80vw,24rem)] flex-col gap-1 py-0.5">
      <span className="flex items-start gap-1.5">
        <GitBranch className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="break-words">
          {props.reference.branch ?? "Detached HEAD"}
        </span>
      </span>
      <span className="flex items-start gap-1.5 text-background/70">
        <FolderGit2 className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="break-all">{props.reference.worktreePath}</span>
      </span>
    </span>
  );
}

/**
 * Chat/owner workspace hover preview. Renders on the shared hover-preview card
 * surface (`HoverPreviewCard`), so its tones are the card's own
 * foreground/muted pair — matching the composer's @mention preview panel and
 * the workspace picker's folder list.
 */
export function OwnerWorkspaceMetadataContent(props: {
  readonly binding: WorktreeBinding | null;
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly workspaces: readonly WorktreeWorkspaceSummaryV14[];
  readonly pending: boolean;
  readonly error: boolean;
  readonly openPrInApp: ((reference: WorktreePrReference) => void) | null;
}): ReactNode {
  if (props.pending && props.binding === null) {
    return (
      <span className="flex items-center gap-2 px-3 py-2 text-ui-xs">
        <AgentSpinningDots
          testId={undefined}
          variant="dots"
          className="size-4"
        />
        Loading workspace…
      </span>
    );
  }
  if (props.error) {
    return (
      <span className="block px-3 py-2 text-ui-xs text-muted-foreground">
        Unable to load workspace details
      </span>
    );
  }
  const items = ownerWorkspaceMetadataItems(
    props.binding,
    props.worktrees,
    props.workspaces,
  );
  if (items.length === 0) {
    return (
      <span className="block px-3 py-2 text-ui-xs text-muted-foreground">
        No workspace linked
      </span>
    );
  }
  return (
    <span
      className={cn(
        // Hairline between folder blocks. Deliberately LIGHTER than the
        // settings header's `border-border/70`: that rule separates two
        // different kinds of information (run settings vs workspaces) and
        // should read as a section break, while these separate repeats of the
        // SAME kind and only need to group. `divide-y` rather than a border on
        // each child, so no rule lands above the first block or below the last.
        // Padding moves onto the children (`py-2` below) so the rule spans the
        // full width and the blocks are not crowded against it.
        "flex max-h-[min(60vh,20rem)] w-full flex-col divide-y divide-border/25",
        HOVER_PREVIEW_SCROLL_CLASS,
      )}
      data-testid="owner-workspace-metadata-content"
      // See workspace-folder-hover-list.tsx: Chromium makes an overflowing
      // scroll container a sequential tab stop regardless of DOM tabIndex;
      // this keeps it out of the Tab order while pointer/wheel scroll works.
      tabIndex={-1}
    >
      {items.map((item) => (
        <span
          key={item.key}
          className="flex min-w-0 flex-col gap-0.5 py-2 first:pt-0 last:pb-0"
        >
          <span className="text-ui-sm font-medium">{item.name}</span>
          <span className="flex items-start gap-1.5 text-ui-xs text-muted-foreground">
            <GitBranch className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="break-words">{item.branch ?? "No branch"}</span>
          </span>
          <span className="flex items-start gap-1.5 text-ui-xs text-muted-foreground/70">
            <FolderGit2 className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="break-all">{item.runPath}</span>
          </span>
          {item.worktree === null ? null : (
            <WorktreePrPills
              worktrees={[item.worktree]}
              detailOnHover={false}
              maximumVisible={null}
              className="mt-0.5 flex-wrap overflow-visible"
              testId={`owner-workspace-prs-${item.key}`}
              openPrInApp={props.openPrInApp}
            />
          )}
        </span>
      ))}
    </span>
  );
}
