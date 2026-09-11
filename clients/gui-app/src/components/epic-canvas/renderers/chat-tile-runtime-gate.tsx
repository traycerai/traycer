import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { resolvedHostLabel } from "@/hooks/agent/use-host-reachability";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useDeadlineReached } from "@/hooks/use-deadline-reached";
import {
  hostIsBehindClient,
  HOST_UPDATE_SKEW_COPY,
} from "@/lib/host/version-skew-copy";
import {
  buildReportIssueDraftContext,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import type { PreSnapshotRetryEvidence } from "@/stores/chats/chat-session-store";
import {
  CHAT_LOAD_DEADLINE_MS,
  chatLoadAttemptsThisWait,
  chatLoadWaitBeganAt,
  chatPreContentElapsed,
  chatPreContentReport,
  describeChatPreContent,
  STALLED_CHAT_LOAD_ELAPSED_MS,
  type ChatPreContentInput,
  type ChatPreContentView,
  type ChatTileFatalDetails,
  type ChatTilePreContentFrame,
} from "./chat-pre-content";
import { useChatTileHostUpdate } from "./use-chat-tile-host-update";

// The chat tile's body before it has a transcript. Kept separate from
// chat-tile.tsx so Fast Refresh stays intact: components only here. The arms
// and their words are pure functions in `chat-pre-content.ts`, and the
// host-update affordance is a hook in its own module.

/** The session's side of the wait, for a tile that has a handle. */
export interface ChatTilePreContentSession {
  readonly fatalClose: ChatTileFatalDetails | null;
  readonly connectionStatus: StreamConnectionStatus;
  readonly retries: PreSnapshotRetryEvidence | null;
  /**
   * A person's retry: the store's `retryFromUser`, never the automatic
   * `retry` (see `onChatRetryFromUser` in `chat-tile.tsx`). It can throw. The
   * store rethrows a stream factory's failure after restoring a `closed`
   * status, and this body then reads that status as nothing retrying.
   */
  readonly onRetry: () => void;
}

/**
 * The chat tile's body until its first transcript lands, in both places that
 * wait is shown: `ChatTile`'s handle-pending branch (`session` is null) and
 * the session view before the first snapshot. `classifyChatPreContent` picks
 * the arm, from the one wait `ChatTile` records above both (`frame`), so the
 * handle arriving restarts no deadline.
 *
 * It needs a ROUTER above it: `useChatTileHostUpdate` reaches `useRouter()`
 * through `useSystemTabModalActions` to offer the Settings jump. Every suite
 * that mounts a real `<ChatTile>` already wraps in `TestRouterProvider`; a new
 * one that renders this without a router fails here, on a hook it never asked
 * for, so it is named rather than left to be rediscovered.
 */
export function ChatTilePreContent(props: {
  readonly testId: string;
  readonly frame: ChatTilePreContentFrame;
  /** `null` while the tile has no session handle: no store, nothing to retry. */
  readonly session: ChatTilePreContentSession | null;
}): ReactNode {
  const { frame, session } = props;
  const tabHostId = useTabHostId();
  const lease = useHostLease(tabHostId);
  const hostUpdate = useChatTileHostUpdate();
  const retries = session?.retries ?? null;
  const waitBeganAt = chatLoadWaitBeganAt(frame.wait, retries);
  // Both deadlines hang off the one anchor. They are evaluated here rather
  // than in the session store, which records instants and never reads a clock
  // to compare against them.
  const slow = useDeadlineReached(waitBeganAt + STALLED_CHAT_LOAD_ELAPSED_MS);
  const overdue = useDeadlineReached(waitBeganAt + CHAT_LOAD_DEADLINE_MS);
  const input: ChatPreContentInput = {
    session:
      session === null
        ? null
        : {
            fatalClose: session.fatalClose,
            connectionStatus: session.connectionStatus,
            retries,
            attemptsThisWait: chatLoadAttemptsThisWait(frame.wait, retries),
          },
    lease,
    reachabilityStatus: frame.reachability.status,
    hostKind: frame.reachability.hostKind,
    hostLabel: resolvedHostLabel(frame.reachability),
    // The versions are the only skew evidence a wait has: there is no close
    // to read a code or a guidance off. The predicate answers from the two
    // alone, where `describeVersionSkew`'s fallback would warn and offer a
    // host update on versions it cannot compare - and a slow load is not yet
    // an attributed skew.
    hostBehindClient: hostIsBehindClient({
      hostAppVersion: hostUpdate.hostAppVersion,
      clientAppVersion: hostUpdate.clientAppVersion,
    }),
    elapsed: chatPreContentElapsed(slow, overdue),
  };
  const view = describeChatPreContent(input);
  const onTryAgain =
    session === null || !view.offersTryAgain
      ? null
      : () => {
          // The new wait first, because the retry can throw. Time spent
          // reading this body was not loading time.
          frame.restartWait(retries?.count ?? 0);
          session.onRetry();
        };
  // Built at click time: the elapsed time is only true then, and the draft's
  // private diagnostics read a support registry that trails render.
  const report = (): ReportIssueDraftContext =>
    buildReportIssueDraftContext(
      chatPreContentReport(input, Date.now() - waitBeganAt),
      null,
    );
  const spinner = view.spinner ? (
    <AgentSpinningDots
      className="shrink-0 text-muted-foreground"
      testId={`${props.testId}-spinner`}
      variant={undefined}
    />
  ) : null;
  const detail =
    view.detail === null ? null : (
      <p className="max-w-md text-ui-sm text-muted-foreground">{view.detail}</p>
    );
  const actions = (
    <ChatTilePreContentActions
      view={view}
      onOpenHostUpdate={hostUpdate.openHostUpdate}
      onTryAgain={onTryAgain}
      report={report}
    />
  );
  return (
    <div
      data-testid={props.testId}
      data-arm={view.kind}
      data-has-handle={session === null ? "false" : "true"}
      data-wait-began-at={waitBeganAt}
      data-error-code={view.code ?? undefined}
      role={view.settled ? undefined : "status"}
      aria-live={view.settled ? undefined : "polite"}
      className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      {view.layout === "card" ? (
        <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-canvas-border/70 bg-canvas p-4">
          <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
            {view.settled ? (
              <AlertTriangle className="size-4 text-destructive" aria-hidden />
            ) : (
              spinner
            )}
            <span>{view.headline}</span>
          </div>
          {detail}
          {actions}
        </div>
      ) : (
        <>
          {spinner}
          <p className="max-w-md text-ui-sm text-muted-foreground">
            {view.headline}
          </p>
          {detail}
          {actions}
        </>
      )}
    </div>
  );
}

function ChatTilePreContentActions(props: {
  readonly view: ChatPreContentView;
  readonly onOpenHostUpdate: () => void;
  readonly onTryAgain: (() => void) | null;
  readonly report: () => ReportIssueDraftContext;
}): ReactNode {
  const { view } = props;
  if (
    !view.offersHostUpdate &&
    props.onTryAgain === null &&
    !view.offersReport
  ) {
    return null;
  }
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {/* Offered only for a HOST that has to move. "Update the app" is a
          different remedy on a different surface (the app updater), and this
          jump would send that reader to a host page with nothing to fix. */}
      {view.offersHostUpdate ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          data-testid="chat-tile-host-update"
          onClick={props.onOpenHostUpdate}
        >
          {HOST_UPDATE_SKEW_COPY.action}
        </Button>
      ) : null}
      {props.onTryAgain === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onTryAgain}
        >
          Try again
        </Button>
      )}
      {view.offersReport ? (
        <ReportIssueAction
          context={props.report}
          presentation="text"
          className={undefined}
        />
      ) : null}
    </div>
  );
}
