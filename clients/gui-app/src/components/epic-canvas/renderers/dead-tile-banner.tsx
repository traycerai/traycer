import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { cn } from "@/lib/utils";

/**
 * Dead-tile banners surface the per-tile host binding (CLAUDE.md):
 *
 * - **Terminal banners** replace the tile body. PTYs are
 *   host-pinned state - a terminal whose host is unreachable is
 *   permanently closed. The Close action drops the canvas tab.
 * - **Chat banners** sit above the chat history. The history can still
 *   render from cache; the banner offers to clone the chat onto the
 *   currently active host (clone-not-migrate per CLAUDE.md).
 * - **Workspace-file/git-diff banners** replace the tile body. Their
 *   content is read over the bound host's stream/RPC clients; the
 *   renderer addresses only the active host's client, so a tab bound
 *   to a different (or offline) host cannot fetch content. Unlike a
 *   terminal it is not permanently dead - switching the active host
 *   back makes it readable again - so the banner is informational, with
 *   no Close action (the tab strip already offers close).
 */

/**
 * Which entity owns the dead tile. The two have opposite durability semantics
 * and this banner is shared by both, so the copy has to vary by owner:
 *
 *   - `terminal` — a raw PTY. It really is gone; nothing returns when the Host
 *     does.
 *   - `agent` — an Agent using the Terminal interface. The Agent and its
 *     transcript are durable and come back with the Host. Only the tab goes
 *     away when it is closed.
 *
 * Telling an Agent's owner the session is "permanently closed" would say the
 * opposite of the Edge-state contract, so this is a prop rather than one
 * shared string.
 */
export type DeadTileOwnerKind = "terminal" | "agent";

export interface TerminalDeadTileBannerProps {
  readonly hostLabel: string;
  readonly ownerKind: DeadTileOwnerKind;
  readonly onClose: () => void;
  readonly testId: string;
}

export function TerminalDeadTileBanner(
  props: TerminalDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        {props.ownerKind === "agent" ? (
          <>
            Host &quot;{props.hostLabel}&quot; is unreachable, so this agent is
            unavailable until that host is back. The agent and its transcript
            are kept — closing this tab only removes it from the canvas.
          </>
        ) : (
          <>
            Host &quot;{props.hostLabel}&quot; is unreachable. This terminal is
            permanently closed.
          </>
        )}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onClose}
        >
          Close tab
        </Button>
        <ReportIssueAction
          context={createReportIssueContext(
            props.ownerKind === "agent"
              ? {
                  title: "Agent host is unreachable",
                  message: "The agent's bound host is unreachable.",
                  code: null,
                  source: "Agent",
                }
              : {
                  title: "Terminal host is unreachable",
                  message: "The terminal's bound host is unreachable.",
                  code: null,
                  source: "Terminal",
                },
          )}
          presentation="text"
          className={undefined}
        />
      </div>
    </div>
  );
}

export interface ManagedCommandDeletedBannerProps {
  /**
   * Whether the deletion itself was observed. `false` only when the window
   * never received a snapshot (restored for a shell the host had already
   * dropped), which is the one case where "deleted" cannot be confirmed -
   * only that the shell is no longer there.
   */
  readonly deletionConfirmed: boolean;
  readonly onClose: () => void;
  readonly testId: string;
}

/**
 * A shell deleted while its output window was open. Sits ABOVE the timeline
 * rather than replacing it: the scrollback the viewer already has is the last
 * trace of a history the host just destroyed, so it stays readable until the
 * tab is closed. Nothing can be paged in behind it and no lifecycle action
 * remains - the shell is gone, not merely stopped.
 */
export function ManagedCommandDeletedBanner(
  props: ManagedCommandDeletedBannerProps,
): ReactNode {
  return (
    <div
      className="flex min-w-0 items-center gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 text-ui-xs text-muted-foreground"
      data-testid={props.testId}
      role="status"
    >
      <span className="min-w-0 flex-1">
        {props.deletionConfirmed
          ? "This shell was deleted. Its output history is gone; what is shown below is only what this window had already read."
          : "This shell is no longer on this host. Its output history is gone; what is shown below is only what this window had already read."}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
        Close tab
      </Button>
    </div>
  );
}

export interface WorkspaceFileDeadTileBannerProps {
  readonly hostLabel: string;
  /**
   * `offline` - the bound host is not in the directory / not available.
   * `inactive` - the bound host is reachable but is not the renderer's
   * active host, so its RPC client is not addressable from here.
   */
  readonly reason: "offline" | "inactive";
  readonly testId: string;
}

export function WorkspaceFileDeadTileBanner(
  props: WorkspaceFileDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        {props.reason === "offline"
          ? `This file is on host "${props.hostLabel}", which is currently unreachable. The preview will load once that host is back.`
          : `This file is on host "${props.hostLabel}". Switch your active host to "${props.hostLabel}" to view it.`}
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Workspace file is unavailable",
          message: "The workspace file's bound host is unavailable.",
          code: null,
          source: "Workspace file",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

export interface GitDiffDeadTileBannerProps {
  readonly hostLabel: string;
  readonly reason: "offline" | "inactive";
  readonly testId: string;
}

export function GitDiffDeadTileBanner(
  props: GitDiffDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        {props.reason === "offline"
          ? `This diff is on host "${props.hostLabel}", which is currently unreachable. The diff will load once that host is back.`
          : `This diff is on host "${props.hostLabel}". Switch your active host to "${props.hostLabel}" to view it.`}
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Git diff is unavailable",
          message: "The Git diff's bound host is unavailable.",
          code: null,
          source: "Git changes",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

/**
 * PR detail tiles subscribe through their OWN bound host's client
 * (`useHostStreamClientFor`), never the app's active host - so unlike
 * `GitDiffDeadTileBanner` there is no "inactive" reason, only "the bound
 * host itself is unreachable." The heavy PR cache lives on that host, so
 * nothing can render until it returns.
 */
export interface PrDetailDeadTileBannerProps {
  readonly hostLabel: string;
  readonly testId: string;
}

export function PrDetailDeadTileBanner(
  props: PrDetailDeadTileBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        This pull request is on host &quot;{props.hostLabel}&quot;, which is
        currently unreachable. It will load once that host is back.
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Pull request is unavailable",
          message: "The PR tile's bound host is unavailable.",
          code: null,
          source: "Pull request",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

/**
 * Snapshot diff tiles re-read their before/after content live from a chat
 * session. When that source is gone - the chat was deleted, the edit's blocks
 * were pruned/edited away, or the file dropped out of the cumulative set - the
 * tile can no longer resolve content. Unlike the offline/inactive banners this
 * is terminal for the tile's payload (the referenced edit no longer exists),
 * so the copy reflects that rather than promising a later load.
 */
export interface SnapshotDiffSourceUnavailableBannerProps {
  readonly testId: string;
}

export function SnapshotDiffSourceUnavailableBanner(
  props: SnapshotDiffSourceUnavailableBannerProps,
): ReactNode {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
    >
      <p className="max-w-md">
        This change is no longer available. The agent edit it came from was
        reverted, removed, or is no longer loaded.
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Change is no longer available",
          message: "The source agent edit could not be resolved.",
          code: null,
          source: "Snapshot diff",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

export interface ChatHostStartingBannerProps {
  readonly className: string | undefined;
  readonly testId: string;
}

/**
 * Non-destructive counterpart to `ChatDeadTileBanner` for the
 * `"host-starting"` reachability state: the host directory is empty because
 * this machine's own host has not published yet (boot, ensure/respawn,
 * post-wake re-probe). No bound host's fate is knowable in that window, so
 * offering "Clone chat" would invite users to fork healthy threads - the
 * banner is purely informational and clears on its own once the local host
 * publishes.
 */
export function ChatHostStartingBanner(
  props: ChatHostStartingBannerProps,
): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className={cn(
        "flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-ui-sm text-muted-foreground",
        props.className,
      )}
    >
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
      />
      <span className="min-w-0 flex-1">
        Waiting for the host to start&hellip;
      </span>
    </div>
  );
}

/**
 * Three distinct causes land on this ONE banner, and no two of them are the
 * same sentence (chat-sync-v2 tickets 35 and 49):
 *
 * - `host-offline` - the bound host is genuinely unreachable. Nothing was
 *   asked and nothing answered, so the host is what has to come back.
 * - `chat-not-visible` - a reachable host that is NOT this device answered,
 *   and answered that it has nothing for this chat (`chat.subscribe`
 *   terminated `CHAT_NOT_VISIBLE`). "is offline" would be false here.
 * - `chat-not-on-this-host` - the same answer, from the host this device is
 *   connected to (a leased-identity twin, a store this identity never
 *   adopted). Naming that host as a place the history "isn't available"
 *   reads as "your own machine is unreachable" - the lie that sent two live
 *   debugging sessions after a healthy host on 2026-08-11. The host
 *   ANSWERED; the chat is what is missing. The clone it offers also lands on
 *   this same machine, so the "stays bound to <label>" disclosure the other
 *   two carry has nothing left to disclose.
 * - `chat-no-longer-shared` - the record plane RETRACTED this chat from this
 *   viewer (`remove` with reason `revoked`: unshared, flipped back to private,
 *   or epic-membership loss). The one member of this taxonomy that is not about
 *   a host at all - the chat exists, its host is fine, and it is the VIEWER's
 *   entitlement that changed. It is also the only one with nothing to offer:
 *   the other three all end in "clone it and carry on", which needs read access
 *   to a transcript this viewer no longer has.
 */
export type ChatDeadTileBannerReason =
  | "host-offline"
  | "chat-not-visible"
  | "chat-not-on-this-host"
  | "chat-no-longer-shared";

export interface ChatDeadTileBannerProps {
  readonly hostLabel: string;
  readonly reason: ChatDeadTileBannerReason;
  readonly onClone: () => void;
  readonly cloning: boolean;
  readonly className: string | undefined;
  readonly testId: string;
}

const CHAT_DEAD_TILE_BANNER_COPY: Record<
  ChatDeadTileBannerReason,
  {
    readonly message: (hostLabel: string) => ReactNode;
    readonly reportTitle: string;
    readonly reportMessage: string;
    /**
     * Whether this reason ends in an action the reader can actually take.
     *
     * Three of the four do: the transcript is readable (as a published copy or
     * from the owner host) and cloning carries it onto a live host. `revoked`
     * does not - the clone would have to read bytes the server just stopped
     * serving this viewer, so offering the button would be an invitation to a
     * failure. Same reasoning `ChatHostStartingBanner` withholds it under.
     */
    readonly offersClone: boolean;
  }
> = {
  "host-offline": {
    message: (hostLabel) => (
      <>
        Bound host &quot;{hostLabel}&quot; is offline. Continuing here creates a
        new agent on the active host; this one stays bound to &quot;
        {hostLabel}&quot;.
      </>
    ),
    reportTitle: "Agent host is offline",
    reportMessage: "The agent's bound host is offline.",
    offersClone: true,
  },
  "chat-not-visible": {
    message: (hostLabel) => (
      <>
        This agent&apos;s history isn&apos;t available on &quot;{hostLabel}
        &quot;. Continuing here creates a new agent on the active host; this one
        stays bound to &quot;{hostLabel}&quot;.
      </>
    ),
    reportTitle: "Agent history unavailable",
    reportMessage: "The agent's history could not be found on its bound host.",
    offersClone: true,
  },
  // Deliberately names no host: the one it would name is the machine the
  // reader is looking at, and every label this device could print for it
  // ("mac-mini", the raw id) reads as somewhere else. Nor does it offer to
  // wait - the host already answered, so there is nothing to come back.
  "chat-not-on-this-host": {
    message: () => (
      <>
        This agent&apos;s history is no longer on this host. Showing the last
        published copy; cloning creates a new agent from it.
      </>
    ),
    reportTitle: "Agent history missing on this host",
    reportMessage:
      "The connected host answered that it no longer has this agent's history.",
    offersClone: true,
  },
  // Names no host on purpose, like the arm above it, but for the opposite
  // reason: there is nothing wrong with any host here. Saying "on <label>"
  // would invite the reader to go looking at a machine that is working
  // perfectly. Nor does it say WHICH revocation happened (unshared vs
  // shared->private vs removed from the epic) - the feed does not tell this
  // client, and guessing would be worse than the fact itself.
  "chat-no-longer-shared": {
    message: () => (
      <>
        This agent is no longer shared with you. Its transcript is no longer
        available here.
      </>
    ),
    reportTitle: "Agent is no longer shared",
    reportMessage: "Access to this agent was revoked while its tab was open.",
    offersClone: false,
  },
};

export function ChatDeadTileBanner(props: ChatDeadTileBannerProps): ReactNode {
  const copy = CHAT_DEAD_TILE_BANNER_COPY[props.reason];
  return (
    // A live region, like the other two chat banners: which of the three
    // truths above is on screen is carried ONLY by this sentence, and the
    // banner appears (and swaps between reasons) mid-session without any
    // focus move - unannounced, a screen-reader user is told nothing about
    // why the composer beneath it locked. Polite `status` rather than
    // `alert`: nothing here is urgent and the transcript stays readable.
    <div
      role="status"
      data-reason={props.reason}
      data-testid={props.testId}
      className={cn(
        "flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-ui-sm text-warning-foreground",
        props.className,
      )}
    >
      <span className="min-w-0 flex-1">{copy.message(props.hostLabel)}</span>
      {copy.offersClone ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.cloning}
          onClick={props.onClone}
        >
          Clone agent
        </Button>
      ) : null}
      <ReportIssueAction
        context={createReportIssueContext({
          title: copy.reportTitle,
          message: copy.reportMessage,
          code: null,
          source: "Agent",
        })}
        presentation="icon"
        className="shrink-0 text-warning-foreground"
      />
    </div>
  );
}
