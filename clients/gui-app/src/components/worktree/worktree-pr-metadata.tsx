import { use, useCallback, type MouseEvent, type ReactNode } from "react";
import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { ExternalLink, FolderGit2, GitBranch } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
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

const PR_PILL_CLASS: Record<WorktreeDisplayedPrState, string> = {
  open: "border-green-600/30 bg-green-500/10 text-green-700 dark:border-green-400/30 dark:text-green-300",
  closed:
    "border-red-600/25 bg-red-500/10 text-red-700 dark:border-red-400/25 dark:text-red-300",
  merged:
    "border-purple-600/30 bg-purple-500/10 text-purple-700 dark:border-purple-400/30 dark:text-purple-300",
};

/**
 * Noninteractive pill palette for the owner-preview hover list, rendered
 * inside a Tooltip's inverted `bg-foreground` surface
 * (`components/ui/tooltip.tsx`) instead of the page's normal
 * background/foreground pair. Several presets give `--foreground` a
 * mid-lightness, tinted value rather than a near-black/near-white extreme
 * (e.g. Ayu, Everforest), so no fixed Tailwind text shade clears 4.5:1 in
 * every preset. `text-background` is the tooltip's own default text token -
 * guaranteed high contrast against `bg-foreground` in every preset, since
 * that pairing is the app's foundational readable-text contract - so state
 * lives entirely in the tint/border hue (and the state label itself), not
 * the text color. The 6% tint keeps every preset/state/mode combination
 * >=4.5:1 with the tint composited in (a 10% tint pushed Everforest/green
 * light to 4.49:1); see the ticket's contrast-matrix notes for the computed
 * ratios.
 */
const PR_PILL_INVERSE_CLASS: Record<WorktreeDisplayedPrState, string> = {
  open: "border-green-500/30 bg-green-500/6 text-background",
  closed: "border-red-500/25 bg-red-500/6 text-background",
  merged: "border-purple-500/30 bg-purple-500/6 text-background",
};

export function WorktreePrPills(props: {
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly detailOnHover: boolean;
  // False inside another Tooltip's content (e.g. the owner-workspace hover
  // preview): Radix duplicates Tooltip content into an always-mounted
  // visually-hidden a11y clone, so a real `<a>` there would exist twice in
  // the focus order. Renders the same pill visually as a plain, non-focusable
  // badge instead.
  readonly interactive: boolean;
  readonly className: string | undefined;
  readonly testId: string;
}): ReactNode {
  const references = worktreePrReferences(props.worktrees);
  if (references.length === 0) return null;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-hidden",
        props.className,
      )}
      data-testid={props.testId}
    >
      {references.map((reference) => (
        <WorktreePrPill
          key={reference.key}
          reference={reference}
          detailOnHover={props.detailOnHover}
          interactive={props.interactive}
        />
      ))}
    </span>
  );
}

function WorktreePrPill(props: {
  readonly reference: WorktreePrReference;
  readonly detailOnHover: boolean;
  readonly interactive: boolean;
}): ReactNode {
  const badgeClassName = cn(
    "gap-1 font-medium",
    props.interactive
      ? PR_PILL_CLASS[props.reference.state]
      : PR_PILL_INVERSE_CLASS[props.reference.state],
  );
  const pill = props.interactive ? (
    <Badge asChild variant="outline" className={badgeClassName}>
      <WorktreePrAnchor
        reference={props.reference}
        className="max-w-[min(60vw,16rem)]"
      />
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className={cn(badgeClassName, "max-w-[min(60vw,16rem)]")}
      data-testid="worktree-context-pr-pill"
      data-pr-state={props.reference.state}
    >
      <WorktreePrPillContent label={props.reference.label} />
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

function WorktreePrPillContent(props: { readonly label: string }): ReactNode {
  return (
    <>
      <span className="truncate">{props.label}</span>
      <ExternalLink className="size-3" aria-hidden />
    </>
  );
}

function WorktreePrAnchor(props: {
  readonly reference: WorktreePrReference;
  readonly className: string | undefined;
}): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const openExternal = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.stopPropagation();
      if (runnerHost === null) return;
      event.preventDefault();
      openExternalLink.mutate(props.reference.url);
    },
    [openExternalLink, props.reference.url, runnerHost],
  );
  return (
    <a
      href={props.reference.url}
      target="_blank"
      rel="noreferrer"
      aria-label={props.reference.ariaLabel}
      className={props.className}
      data-testid="worktree-context-pr-pill"
      data-pr-state={props.reference.state}
      onClick={openExternal}
    >
      <WorktreePrPillContent label={props.reference.label} />
    </a>
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

export function OwnerWorkspaceMetadataContent(props: {
  readonly binding: WorktreeBinding | null;
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly pending: boolean;
  readonly error: boolean;
}): ReactNode {
  if (props.pending && props.binding === null) {
    return (
      <span className="flex items-center gap-2 px-2.5 py-2 text-ui-xs">
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
      <span className="block px-2.5 py-2 text-ui-xs text-background/70">
        Unable to load workspace details
      </span>
    );
  }
  const items = ownerWorkspaceMetadataItems(props.binding, props.worktrees);
  if (items.length === 0) {
    return (
      <span className="block px-2.5 py-2 text-ui-xs text-background/70">
        No workspace linked
      </span>
    );
  }
  return (
    <span
      className="flex max-h-[min(60vh,20rem)] w-full flex-col gap-2 overflow-y-auto px-2.5 py-2 text-ui-xs"
      data-testid="owner-workspace-metadata-content"
      // See workspace-folder-hover-list.tsx: Chromium makes an overflowing
      // scroll container a sequential tab stop regardless of DOM tabIndex;
      // this keeps it out of the Tab order while pointer/wheel scroll works.
      tabIndex={-1}
    >
      {items.map((item) => (
        <span key={item.key} className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{item.name}</span>
          <span className="flex items-start gap-1.5 text-background/75">
            <GitBranch className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="break-words">{item.branch ?? "No branch"}</span>
          </span>
          <span className="flex items-start gap-1.5 text-background/60">
            <FolderGit2 className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="break-all">{item.runPath}</span>
          </span>
          {item.worktree === null ? null : (
            <WorktreePrPills
              worktrees={[item.worktree]}
              detailOnHover={false}
              interactive={false}
              className="mt-0.5 flex-wrap overflow-visible"
              testId={`owner-workspace-prs-${item.key}`}
            />
          )}
        </span>
      ))}
    </span>
  );
}
