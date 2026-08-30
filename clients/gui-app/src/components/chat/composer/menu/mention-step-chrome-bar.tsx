import type { ReactNode } from "react";
import { RefreshIcon } from "@/components/refresh-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { PrSourceNoticeHint } from "@/components/epic-canvas/pr/pr-source-notice";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import type {
  MentionStepChrome,
  MentionStepChromeFreshness,
  MentionStepChromeRefresh,
} from "@/lib/composer/mentions";
import { useRelativeTimestamp } from "@/lib/relative-time";

import { GithubMentionFilterPopover } from "./github-mention-filter-popover";

/**
 * The mention menu's per-step top bar: freshness, the ⓘ that explains a paused
 * source, the filter funnel, and refresh - rendered from whatever the current
 * step published into the picker store.
 *
 * A step with no chrome renders nothing at all, so the menu header keeps its
 * previous shape for every step that had none.
 */
export function MentionStepChromeBar(props: {
  readonly chrome: MentionStepChrome;
  readonly onReturnFocus: (resumeText: string | null) => void;
}): ReactNode {
  const { chrome, onReturnFocus } = props;
  return (
    <>
      {chrome.freshness === null ? null : (
        <FreshnessStamp freshness={chrome.freshness} />
      )}
      {chrome.notice === null ? null : (
        <PrSourceNoticeHint
          notice={chrome.notice}
          subject={
            chrome.filter?.section === "issues" ? "issues" : "pull-requests"
          }
        />
      )}
      <span className="flex-1" />
      {chrome.filter === null ? null : (
        <GithubMentionFilterPopover
          filter={chrome.filter}
          onReturnFocus={onReturnFocus}
        />
      )}
      {chrome.refresh === null ? null : (
        <RefreshButton
          key={chrome.refresh.targetKey}
          refresh={chrome.refresh}
        />
      )}
    </>
  );
}

/**
 * `Updated 2m ago` / `Not yet fetched` / `Checking…`.
 *
 * It deliberately never claims what is on screen. A section paused before its
 * first successful fetch has no "last updated" to show, and saying so plainly
 * is the honest answer in both states.
 */
function FreshnessStamp(props: {
  readonly freshness: MentionStepChromeFreshness;
}): ReactNode {
  const { freshness } = props;
  if (freshness.checking) {
    return (
      <span className="shrink-0 text-ui-xs text-muted-foreground/60">
        Checking…
      </span>
    );
  }
  if (freshness.updatedAt === null) {
    return (
      <span className="shrink-0 text-ui-xs text-muted-foreground/60">
        Not yet fetched
      </span>
    );
  }
  return <UpdatedStamp updatedAt={freshness.updatedAt} />;
}

// Its own leaf so the shared 60s clock tick repaints the label rather than the
// whole menu header.
function UpdatedStamp(props: { readonly updatedAt: number }): ReactNode {
  const relative = useRelativeTimestamp(props.updatedAt);
  return (
    <span className="shrink-0 text-ui-xs text-muted-foreground/60">
      {`Updated ${relative.toLowerCase()}`}
    </span>
  );
}

/**
 * Icon-only and click-only: the desktop window's Reload owns ⌘R, and a bare
 * `R` is impossible inside a menu where typing filters the list.
 * `onMouseDown` preventDefault so pressing it never takes focus off the
 * composer - the caret has to survive a refresh.
 */
function RefreshButton(props: {
  readonly refresh: MentionStepChromeRefresh;
}): ReactNode {
  const { refresh } = props;
  const spinner = useRefreshSpinner({
    onRefresh: refresh.onRefresh,
    externalRefreshing: refresh.refreshing,
    timeoutMs: refresh.timeoutMs,
  });
  return (
    <TooltipWrapper
      label={refresh.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={refresh.label}
          className="-my-1 text-muted-foreground/70 hover:text-foreground"
          disabled={spinner.refreshing}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={spinner.trigger}
        >
          <RefreshIcon refreshing={spinner.refreshing} className="size-3.5" />
        </Button>
      </span>
    </TooltipWrapper>
  );
}

/**
 * The degraded-source banner above the rows.
 *
 * Not an ⓘ and not a pause: waiting does not fix a missing or signed-out `gh`,
 * so the copy has to say what to do. Cached rows still render below it.
 */
export function MentionStepChromeBanner(props: {
  readonly chrome: MentionStepChrome;
}): ReactNode {
  const banner = props.chrome.banner;
  if (banner === null) return null;
  const what = banner.section === "pull-requests" ? "pull requests" : "issues";
  return (
    <div
      role="status"
      data-testid="mention-github-unavailable-banner"
      className="mx-2 mb-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-ui-xs text-foreground"
    >
      <span className="font-semibold">GitHub CLI unavailable</span>
      {` — Install and sign in to the GitHub CLI (gh auth login) to load ${what}. Cached rows stay visible and may be stale.`}
    </div>
  );
}

/**
 * The appended status row - the `Loading…` idiom while `busy`, a plain
 * statement otherwise. The dots are conditional because they MEAN in-flight
 * work: spinning beside "Couldn't reach GitHub." would claim progress a read
 * that has given up is not making (the failed slash-command row above makes
 * the same choice).
 */
export function MentionStepChromeStatusRow(props: {
  readonly label: string;
  readonly busy: boolean;
}): ReactNode {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-ui-xs text-muted-foreground/80">
      {props.busy ? (
        <AgentSpinningDots
          testId={undefined}
          variant="orbit"
          className="text-muted-foreground/80"
        />
      ) : null}
      {props.label}
    </div>
  );
}
