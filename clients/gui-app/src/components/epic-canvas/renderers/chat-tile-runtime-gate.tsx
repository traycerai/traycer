import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useDeadlineReached } from "@/hooks/use-deadline-reached";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import {
  createReportIssueContext,
  type ReportIssueContext,
} from "@/lib/report-issue-context";
import {
  hostIsBehindClient,
  HOST_UPDATE_SKEW_COPY,
} from "@/lib/host/version-skew-copy";
import type { PreSnapshotRetryEvidence } from "@/stores/chats/chat-session-store";
import {
  useChatTileHostUpdate,
  type ChatTileHostUpdate,
} from "./use-chat-tile-host-update";

// The chat tile's pre-snapshot states - loading, stalled-but-still-retrying,
// and fatal-close error - and the gate that picks between them. Kept separate
// from chat-tile.tsx so Fast Refresh stays intact (components only here; the
// host-update affordance the panes share is a hook in its own module).

/**
 * How many failed attempts before the tile stops presenting the load as
 * ordinary.
 *
 * Three, because two is one retry - the shape of a host restart or a
 * sleep-wake redial, both of which recover on their own - and telling the
 * reader something is wrong there would be wrong more often than right. The
 * third failure is the first one that is a pattern.
 */
export const STALLED_CHAT_LOAD_ATTEMPTS = 3;

/**
 * ...and how long the wait itself may run before the same pane is shown
 * anyway, counted from when the wait began rather than from any failure.
 *
 * The count alone is not enough, for two different reasons. The reconnect
 * ladder backs off, so a host that refuses slowly - or a dial that hangs
 * before failing - can spend a long time on attempt one. And a host that acks
 * `chat.subscribe` and then goes silent never produces an attempt to count at
 * all, which is the case that would otherwise spin forever.
 *
 * 20s is deliberately more patient than `TILE_CONTENT_BUDGET_MS` (15s): this
 * pane is not terminal and the load may still land on its own, so the cost of
 * waiting slightly longer is a few more seconds of spinner where it was about
 * to succeed.
 */
export const STALLED_CHAT_LOAD_ELAPSED_MS = 20_000;

/**
 * The fatal-close fields these panes read. A structural subset of
 * `FatalErrorDetails` rather than the type itself: it names exactly what the
 * presentation depends on, so a caller can hand over a whole close and the
 * compiler still holds this component to the three fields it renders.
 */
export interface ChatTileFatalDetails {
  readonly code: string;
  readonly reason: string;
  readonly upgradeGuidance: IncompatibilityUpgradeGuidance | null;
}

/**
 * Which pre-snapshot state the tile is in, and the only place that decides.
 *
 * The three arms are ordered by how much they know: a fatal close is the
 * host's own verdict on this attempt, a stall is our own observation - either
 * a streak of attempts the host never answered or simply a wait that has run
 * too long - and the spinner is what remains when the load is still ordinary.
 * Mounted only while `snapshotLoaded` is false, so a tile showing a transcript
 * pays for none of it.
 *
 * It needs a ROUTER above it, which the pre-snapshot path did not before:
 * `useChatTileHostUpdate` reaches `useRouter()` through
 * `useSystemTabModalActions` to offer the Settings jump. Every suite that
 * mounts a real `<ChatTile>` already wraps in `TestRouterProvider`; a new one
 * that renders the loading state without a router fails here, on a hook it
 * never asked for, so it is named rather than left to be rediscovered.
 */
export function ChatTilePreSnapshotGate(props: {
  readonly fatalClose: ChatTileFatalDetails | null;
  readonly retries: PreSnapshotRetryEvidence | null;
  readonly onRetry: () => void;
}): ReactNode {
  const hostUpdate = useChatTileHostUpdate();
  // The wait starts when this gate first renders for this session, NOT at the
  // first failure - that distinction is the whole deadline.
  //
  // A host can ack `chat.subscribe` and then send neither a snapshot nor a
  // close, with heartbeat pongs keeping the socket alive underneath. Nothing
  // ever transitions to `reconnecting`, so `retries` stays null forever, and a
  // budget anchored on the first failure never arms at all: the tile spins
  // until the tab is closed. Invariant 6 asks for a deadline on every
  // host-dependent loading state, and "no evidence yet" is precisely the state
  // that needs one most, because it is the one nothing else can end.
  const [waitStartedAt] = useState(() => Date.now());
  // The streak's own start still wins where it is EARLIER, so a tile mounting
  // into a stall that is already old inherits it instead of restarting the
  // budget. `Math.min` rather than a preference for one or the other: whichever
  // came first is when this wait actually began, and a failure that lands after
  // this gate mounted does not restart it.
  const waitBeganAt =
    props.retries === null
      ? waitStartedAt
      : Math.min(props.retries.firstAt, waitStartedAt);
  // Evaluated HERE rather than in the session store, which records the instant
  // and never reads a clock to compare against it.
  const stalledLongEnough = useDeadlineReached(
    waitBeganAt + STALLED_CHAT_LOAD_ELAPSED_MS,
  );
  if (props.fatalClose !== null) {
    return (
      <ChatTileError
        details={props.fatalClose}
        hostUpdate={hostUpdate}
        onRetry={props.onRetry}
      />
    );
  }
  // Either arm alone is enough, and the elapsed one no longer requires a
  // failure to have happened: a wait long enough to give up presenting as
  // ordinary is a wait long enough whether the host refused three times or
  // said nothing at all.
  if (
    stalledLongEnough ||
    (props.retries !== null &&
      props.retries.count >= STALLED_CHAT_LOAD_ATTEMPTS)
  ) {
    return (
      <ChatTileStillTrying
        retries={props.retries}
        hostUpdate={hostUpdate}
        onRetry={props.onRetry}
      />
    );
  }
  return <ChatTileLoading />;
}

export function ChatTileLoading(): ReactNode {
  return (
    <div
      data-testid="chat-tile-loading"
      role="status"
      aria-label="Loading agent"
      aria-live="polite"
      className="flex w-full flex-1 items-center justify-center px-6 py-8"
    >
      <MutedAgentSpinner />
      <span className="sr-only">Loading agent</span>
    </div>
  );
}

/**
 * Shown when the host terminates `chat.subscribe` with a fatal error before
 * any snapshot - the chat will never load on this attempt, so we surface the
 * reason and a retry instead of spinning forever. The wire collapses
 * CHAT_INVALID / CHAT_NOT_VISIBLE / etc. into one UNAUTHORIZED code; the
 * human-readable `reason` carries the real cause, so we drop the redundant
 * `CODE: ` prefix for display.
 *
 * `HOST_OLDER_THAN_DATA` is the one code with a remedy the reader can act on:
 * the host is serving a chat store a NEWER host wrote, so no retry can help
 * and the only fix is updating that host. It gets the host-update copy and the
 * update jump; every other code keeps the generic failure copy. See
 * {@link describeFatalCopy} for why that is decided from the code and not from
 * the two app versions.
 */
export function ChatTileError(props: {
  readonly details: ChatTileFatalDetails;
  readonly hostUpdate: ChatTileHostUpdate;
  readonly onRetry: () => void;
}): ReactNode {
  const detail = props.details.reason.replace(/^[A-Z_]+:\s*/, "");
  const copy = describeFatalCopy(props.details);
  return (
    <ChatTilePane
      testId="chat-tile-error"
      errorCode={props.details.code}
      settled
      title={copy.paneTitle}
      body={detail}
      hostUpdateLabel={copy.hostUpdateLabel}
      hostUpdate={props.hostUpdate}
      onRetry={props.onRetry}
      reportContext={createReportIssueContext({
        title: copy.reportTitle,
        message: "The agent could not be opened.",
        code: props.details.code,
        source: "Chat",
      })}
    />
  );
}

interface ChatTileFatalCopy {
  readonly paneTitle: string;
  readonly reportTitle: string;
  /** The host-update affordance's label, or `null` for no such offer. */
  readonly hostUpdateLabel: string | null;
}

/**
 * What a fatal close tells the reader to DO.
 *
 * The host-update arm is decided by the host's own statements and never by
 * relative versions, which is the whole point: `HOST_OLDER_THAN_DATA` says a
 * store on that machine was written by a build newer than the one serving it,
 * so an app at 1.3 talking to a host at 1.4 still needs the HOST to move.
 * Routing this through `describeVersionSkew` answered "Your app is too old"
 * for exactly that case and hid the only action that could help.
 *
 * `CHAT_STORE_UNUSABLE` is the neighbouring code and is deliberately NOT here.
 * The host emits it for a malformed stamp, a shape that disagrees with its
 * stamp, or failed integrity verification, and says so at the emitting site:
 * "the remedy differs - this one needs a repair or a support report, not a
 * host update". Its pane is the generic one, whose Report issue is that
 * report.
 */
function describeFatalCopy(details: ChatTileFatalDetails): ChatTileFatalCopy {
  if (fatalRemedyIsHostUpdate(details)) {
    return {
      paneTitle: HOST_UPDATE_SKEW_COPY.title,
      reportTitle: HOST_UPDATE_SKEW_COPY.title,
      hostUpdateLabel: HOST_UPDATE_SKEW_COPY.action,
    };
  }
  return {
    paneTitle: "This agent could not be opened.",
    reportTitle: "This agent could not be opened",
    hostUpdateLabel: null,
  };
}

/**
 * Whether the host has said, one way or the other, that IT is the leg that has
 * to move. The code is the authoritative form; the guidance is the general
 * one, and covers a future code this build has never heard of whose host still
 * marked the direction. Neither is a version comparison.
 */
function fatalRemedyIsHostUpdate(details: ChatTileFatalDetails): boolean {
  if (details.code === HOST_OLDER_THAN_DATA_FATAL_CODE) return true;
  const guidance = details.upgradeGuidance;
  if (guidance === null) return false;
  return guidance.hostShouldUpgrade && !guidance.clientShouldUpgrade;
}

/**
 * Shown when the stream keeps failing before the first snapshot ever lands
 * (invariant 6: every host-dependent loading state carries a deadline AND a
 * terminal presentation - this is the deadline for the one wait that has no
 * terminal close to trigger the pane above).
 *
 * NOT a terminal state: the stream is still live or still reconnecting
 * underneath, and a snapshot that finally arrives replaces this with the
 * transcript on its own. A retryable fatal - the shape a host too old for its
 * own chat store answers `chat.subscribe` with, forever - is handled inside
 * the transport as an ordinary drop, so there is no close for this pane to
 * quote. It says what it can see instead: how many attempts have failed, and,
 * when the versions prove the bound host is behind this app, the update that
 * ends it.
 *
 * `retries` is nullable because the two ways a load stalls do not look alike.
 * A host that refuses produces a streak to count; a host that acks and then
 * goes quiet produces NO evidence at all, and that silence is the case the
 * elapsed deadline exists for. The body says only what is true in each.
 */
export function ChatTileStillTrying(props: {
  readonly retries: PreSnapshotRetryEvidence | null;
  readonly hostUpdate: ChatTileHostUpdate;
  readonly onRetry: () => void;
}): ReactNode {
  // Versions are the ONLY evidence available here: there is no close to read a
  // code or a guidance off, which is what separates this pane from the fatal
  // one. The predicate answers from the two versions alone, where
  // `describeVersionSkew`'s own fallback would warn and default to host-update
  // copy on versions it cannot compare - and a stalled load is not yet an
  // attributed skew. The WORDS are the shared constant either way, so this pane
  // and the fatal one above name the remedy identically.
  const hostIsBehind = hostIsBehindClient({
    hostAppVersion: props.hostUpdate.hostAppVersion,
    clientAppVersion: props.hostUpdate.clientAppVersion,
  });
  return (
    <ChatTilePane
      testId="chat-tile-still-trying"
      errorCode={props.retries?.code ?? null}
      // The reconnects continue underneath, so this keeps the spinner it
      // replaced - and the spinner's live region, so a reader who was told the
      // agent was loading is told when that stops being the whole story.
      settled={false}
      title={
        hostIsBehind ? HOST_UPDATE_SKEW_COPY.title : "Still opening this agent"
      }
      body={describeStall(props.retries)}
      hostUpdateLabel={hostIsBehind ? HOST_UPDATE_SKEW_COPY.action : null}
      hostUpdate={props.hostUpdate}
      onRetry={props.onRetry}
      reportContext={createReportIssueContext({
        title: "This agent has not opened",
        message: "The agent's stream has not delivered this agent's history.",
        // Null unless the transport surfaced the host's own code, which is
        // exactly why it is worth carrying into a report when it is there.
        code: props.retries?.code ?? null,
        source: "Chat",
      })}
    />
  );
}

/**
 * The shared body of both panes above. One component because they differ only
 * in their words and their liveness: the same title/detail/actions block,
 * where a wrong-shaped copy of it would be the second place a host-update
 * offer could quietly stop matching the first.
 */
function ChatTilePane(props: {
  readonly testId: string;
  readonly errorCode: string | null;
  /**
   * Whether this attempt is OVER. It decides the two things that follow from
   * that one fact and must not disagree: a settled failure is announced once
   * under a warning mark, while a wait still running keeps the spinner and the
   * spinner's live region so a reader hears the state change.
   */
  readonly settled: boolean;
  readonly title: string;
  readonly body: string;
  /**
   * The host-update affordance's label, or `null` for no such offer. Each
   * caller decides from its own evidence, and only ever for a HOST that has to
   * move: "update the app" is a different remedy on a different surface (the
   * app updater), and this jump would send that reader to a host page with
   * nothing to fix.
   */
  readonly hostUpdateLabel: string | null;
  readonly hostUpdate: ChatTileHostUpdate;
  readonly onRetry: () => void;
  readonly reportContext: ReportIssueContext;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      data-error-code={props.errorCode === null ? undefined : props.errorCode}
      role={props.settled ? undefined : "status"}
      aria-live={props.settled ? undefined : "polite"}
      className="flex w-full flex-1 items-center justify-center px-6 py-8"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-canvas-border/70 bg-canvas p-4 text-center">
        <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
          {props.settled ? (
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
          ) : (
            <MutedAgentSpinner />
          )}
          <span>{props.title}</span>
        </div>
        <p className="text-ui-sm text-muted-foreground">{props.body}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {props.hostUpdateLabel !== null ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="chat-tile-host-update"
              onClick={props.hostUpdate.openHostUpdate}
            >
              {props.hostUpdateLabel}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onRetry}
          >
            Retry
          </Button>
          <ReportIssueAction
            context={props.reportContext}
            presentation="text"
            className={undefined}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * What this pane can honestly say happened.
 *
 * With a streak it counts it. Without one there is nothing to count - the
 * stream never dropped - so it reports the silence itself rather than
 * inventing a "0 attempts", which would read as a failure that never occurred
 * and send a reader looking for one.
 */
function describeStall(retries: PreSnapshotRetryEvidence | null): string {
  if (retries === null) {
    return "The host has not sent this agent's messages yet.";
  }
  return `The host has not opened this agent after ${describeAttempts(retries.count)}.`;
}

function describeAttempts(count: number): string {
  return count === 1 ? "1 attempt" : `${count} attempts`;
}
