import type { ReactNode } from "react";
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

export interface TerminalDeadTileBannerProps {
  readonly hostLabel: string;
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
        Host &quot;{props.hostLabel}&quot; is unreachable. This terminal is
        permanently closed.
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
          context={createReportIssueContext({
            title: "Terminal host is unreachable",
            message: "The terminal's bound host is unreachable.",
            code: null,
            source: "Terminal",
          })}
          presentation="text"
          className={undefined}
        />
      </div>
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
        This change is no longer available. The chat edit it came from was
        reverted, removed, or is no longer loaded.
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Change is no longer available",
          message: "The source chat edit could not be resolved.",
          code: null,
          source: "Snapshot diff",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}

export interface ChatDeadTileBannerProps {
  readonly hostLabel: string;
  readonly onClone: () => void;
  readonly cloning: boolean;
  readonly className: string | undefined;
  readonly testId: string;
}

export function ChatDeadTileBanner(props: ChatDeadTileBannerProps): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className={cn(
        "flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-ui-sm text-warning-foreground",
        props.className,
      )}
    >
      <span className="min-w-0 flex-1">
        Bound host &quot;{props.hostLabel}&quot; is offline. Continue this
        thread on the active host?
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.cloning}
        onClick={props.onClone}
      >
        Clone chat
      </Button>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Chat host is offline",
          message: "The chat's bound host is offline.",
          code: null,
          source: "Chat",
        })}
        presentation="icon"
        className="shrink-0 text-warning-foreground"
      />
    </div>
  );
}
