/**
 * The browser tile's capture and record controls, plus the badge that stays
 * lit for the whole recording and the save toast a screenshot produces
 * (D20, D29, D06).
 *
 * ## One driver for the badge: `epic.fileEvents`
 *
 * Three sources could plausibly light this badge, and using more than one
 * would give the tile two arrival orders for one fact:
 *
 * 1. `epic.fileEvents` `recordingStarted` / `recordingEnded` - the EPIC-scoped
 *    stream. This is the driver. It is the only source that is true on both
 *    runtimes and for both initiators: an agent-started recording (D13's REPL
 *    verbs) lights the badge through exactly the same frames a button press
 *    does, and the frames reach every client with the epic open rather than
 *    only the one that owns the runtime.
 * 2. The per-tab store fed by the `browser.sessions` recording frames
 *    (`lib/browser-view/sessions/tab-recording-store.ts`). Deliberately NOT
 *    consulted here. Those frames are the desktop helper's readiness signal:
 *    they travel to the client that owns the Electron runtime, so a tile
 *    watching a HEADLESS tab never sees them, and the store's rows are dropped
 *    whenever that coordinator's stream leaves `live` - a reconnect would blank
 *    a badge whose recording is still running on the host.
 * 3. The manifest. It carries the SETTLED file and nothing about the run, by
 *    construction - between start and finalize there is no entry to observe.
 *    So it drives the badge's upload half only: once `recordingEnded` says
 *    `saved`, the clip entry's `status` is what says `pending` -> `available` /
 *    `local-only` / `failed`.
 *
 * The one thing added on top is an OPTIMISTIC `starting` phase set from the
 * start call's own `{ ok: true, recordingId }`, so the badge appears on the
 * click rather than a round trip later. It is superseded by the
 * `recordingStarted` frame for the same id and is not a second source of
 * truth: it can only ever precede the driver, never contradict it.
 *
 * ## Gating
 *
 * Both buttons are hidden unless the tab's host advertised
 * `epic.startTabRecording` in its last handshake
 * (`useHostSupportsMethod` -> `negotiated-manifest-registry`). That registry is
 * the canonical answer for a UNARY optional method - it is the one place "does
 * host X have method Y?" is answered without calling Y, and it fails closed.
 * The `retry`-predicate pattern in `use-chat-run-settings-query.ts` is the
 * right shape for a QUERY that may be answered `E_HOST_UNSUPPORTED`, but these
 * three methods are commands: probing `epic.startTabRecording` to find out
 * whether it exists would start a recording. So an old host produces a missing
 * button here, never a broken one and never a retry storm.
 */
import { useCallback, useEffect, useState } from "react";
import { Camera, Circle, Square } from "lucide-react";
import { toast } from "sonner";
import type {
  StartTabRecordingRefusal,
  TabRecordingOutcome,
} from "@traycer/protocol/host/epic/files";
import {
  normalizeEpicFileStatus,
  type EpicFileStatusOrUnknown,
} from "@traycer/protocol/persistence/epic/files";
import { appendEpicFileToNewConversationDraft } from "@/components/chat/quote/append-epic-file-to-draft";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useEpicCaptureTabScreenshot,
  useEpicRecordingClip,
  useEpicStartTabRecording,
  useEpicStopTabRecording,
} from "@/hooks/epic/use-epic-files";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  claimSharingNotice,
  COLLABORATOR_SHARING_COPY,
} from "@/lib/epic-files/capture-sharing-notice";
import { epicFileName } from "@/lib/epic-files/file-rows";
import { subscribeEpicRecordingEvents } from "@/lib/epic-files/file-events-store";
import { isEditableRole } from "@/lib/epic-permissions";
import { useMaybeEpicPermissionRole } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

/**
 * Everything the capture verbs need to name their subject. `null` at the call
 * site (a tile whose canvas tab has no epic behind it) hides both controls -
 * the epic is the authorization subject for every method here, so there is
 * nothing to ask without one.
 */
export interface BrowserTileCaptureTarget {
  readonly epicId: string;
  /** The tab's bound host. Never the app-wide active one. */
  readonly hostId: string;
  readonly tabId: string;
  /** The canvas tab a saved file's tile opens into. */
  readonly viewTabId: string;
}

/**
 * Every refusal arm is a cap or a placement fact the host checked before doing
 * any work (D21), so each gets its own sentence rather than a generic failure.
 * The copy lives client-side because the enum is CLOSED and branched on here.
 */
const START_RECORDING_REFUSAL_COPY: Readonly<
  Record<StartTabRecordingRefusal, string>
> = {
  "tab-not-found": "This tab isn't available on its host any more.",
  "already-recording": "This tab is already being recorded.",
  "host-limit": "This host is already running two recordings.",
  "unsupported-runtime": "This tab's browser can't be recorded.",
};

/** The badge's upload half, once the run has ended and saved. */
const UPLOAD_STATUS_COPY: Readonly<Record<EpicFileStatusOrUnknown, string>> = {
  pending: "Uploading",
  available: "Saved",
  failed: "Upload failed",
  "local-only": "Kept on its device",
  unknown: "Saved",
};

const RECORDING_OUTCOME_COPY: Readonly<Record<TabRecordingOutcome, string>> = {
  saved: "Saved",
  failed: "Recording failed",
  discarded: "Nothing recorded",
};

/** How long a settled badge stays up before the toolbar goes quiet again. */
const SETTLED_BADGE_LINGER_MS = 6_000;

type CaptureBadgeState =
  | { readonly phase: "starting"; readonly recordingId: string }
  | {
      readonly phase: "recording";
      readonly recordingId: string;
      readonly startedAt: number;
    }
  | {
      readonly phase: "ended";
      readonly recordingId: string;
      readonly outcome: TabRecordingOutcome;
    };

/**
 * The gate, and ONLY the gate. Everything past it - three host mutations, the
 * clip lookup, the file-events subscription - is in the inner component so a
 * tile that will never show these buttons builds none of it. That also means
 * the gate answers on surfaces that carry no host client and no epic session
 * (a canvas pane whose handle is still resolving, a peek tile on the mobile
 * switcher): both reads below tolerate their absence and refuse, where a
 * mutation hook would throw and take the tile down with it.
 */
export function BrowserTileCaptureControls(props: {
  readonly target: BrowserTileCaptureTarget;
  readonly capture: boolean;
  readonly record: boolean;
  readonly disabled: boolean;
}) {
  const supported = useHostSupportsMethod(
    props.target.hostId,
    "epic.startTabRecording",
  );
  // A capture MINTS a manifest entry, and minting is an owner/editor write
  // (D06). The host is the gate; hiding the buttons here just stops offering a
  // viewer a control whose every press would be refused.
  const canWrite = isEditableRole(useMaybeEpicPermissionRole());
  if (!supported || !canWrite) return null;
  return (
    <BrowserTileCaptureControlsBody
      target={props.target}
      capture={props.capture}
      record={props.record}
      disabled={props.disabled}
    />
  );
}

function BrowserTileCaptureControlsBody(props: {
  readonly target: BrowserTileCaptureTarget;
  readonly capture: boolean;
  readonly record: boolean;
  readonly disabled: boolean;
}) {
  const { epicId, hostId, tabId, viewTabId } = props.target;
  const [badge, setBadge] = useState<CaptureBadgeState | null>(null);
  const captureScreenshot = useEpicCaptureTabScreenshot(epicId, tabId);
  const startRecording = useEpicStartTabRecording(epicId, tabId);
  const stopRecording = useEpicStopTabRecording(epicId, tabId);
  const openTile = useEpicTileNavigation().openTile;
  const openNewConversation = useNewConversationModalOpenStore(
    (state) => state.open,
  );

  // The driver. A `recordingStarted` for this tab always wins - it is the only
  // frame that can begin a run, including one an agent began. A
  // `recordingEnded` settles only the run the badge is showing: an id this
  // client never saw start belongs to a run it is not badging.
  useEffect(
    () =>
      subscribeEpicRecordingEvents(epicId, (event) => {
        if (event.tabId !== tabId) return;
        if (event.kind === "recordingStarted") {
          setBadge({
            phase: "recording",
            recordingId: event.recordingId,
            startedAt: Date.now(),
          });
          return;
        }
        setBadge((current) =>
          current === null || current.recordingId !== event.recordingId
            ? current
            : {
                phase: "ended",
                recordingId: event.recordingId,
                outcome: event.outcome ?? "saved",
              },
        );
      }),
    [epicId, tabId],
  );

  const recordingId = badge === null ? null : badge.recordingId;
  const clip = useEpicRecordingClip(
    badge !== null && badge.phase === "ended" ? recordingId : null,
  );
  const uploadStatus: EpicFileStatusOrUnknown | null =
    clip === null ? null : normalizeEpicFileStatus(clip.entry.status);

  // A settled badge lingers briefly and then the toolbar goes quiet. "Settled"
  // means the upload is no longer in flight, so a `pending` clip keeps the
  // badge up for as long as the bytes are going - which is the whole point of
  // showing the upload state at all.
  //
  // A clip that has not replicated yet reads as settled rather than as
  // pending: its entry may never arrive on this client, and a badge that
  // waits for one would be stuck on screen for the rest of the session. If it
  // does arrive `pending` within the linger, this flips back to false, the
  // timer is cancelled by the cleanup below, and the badge stays lit until the
  // upload actually finishes.
  const settled =
    badge !== null &&
    badge.phase === "ended" &&
    (badge.outcome !== "saved" || uploadStatus !== "pending");
  useEffect(() => {
    if (!settled) return;
    const timer = window.setTimeout(() => {
      setBadge(null);
    }, SETTLED_BADGE_LINGER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [settled, recordingId]);

  const onCapture = useCallback(() => {
    captureScreenshot.mutate(
      { epicId, tabId, save: true },
      {
        onSuccess: (response) => {
          if (response.saved === null) return;
          const path = response.saved.path;
          toast.success(`Saved ${epicFileName(path)}`, {
            description: claimSharingNotice(epicId)
              ? COLLABORATOR_SHARING_COPY
              : undefined,
            action: (
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    appendEpicFileToNewConversationDraft({
                      epicId,
                      path,
                      image: true,
                    });
                    openNewConversation({
                      epicId,
                      tabId: viewTabId,
                      placement: null,
                      parentId: null,
                      // The capture lives on the tab's host and the tile is
                      // bound to it for life, so the chat that references it
                      // is created there - not on whichever host is active
                      // app-wide.
                      hostId,
                    });
                  }}
                >
                  Attach to chat
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    openTile(
                      tileIntent(
                        makeEpicFileTileRef({ hostId, epicId, path }),
                        { epicId },
                        "explicit",
                        "direct_ui",
                      ),
                    );
                  }}
                >
                  Open
                </Button>
              </div>
            ),
          });
        },
      },
    );
  }, [
    captureScreenshot,
    epicId,
    hostId,
    openNewConversation,
    openTile,
    tabId,
    viewTabId,
  ]);

  const onToggleRecording = useCallback(() => {
    if (recordingId !== null && badge !== null && badge.phase !== "ended") {
      stopRecording.mutate({ epicId, recordingId });
      return;
    }
    startRecording.mutate(
      // `null` keeps the tile's live size: a user-started recording records
      // what the user can see (D22). Only an agent names a viewport.
      { epicId, tabId, viewport: null },
      {
        onSuccess: (response) => {
          if (!response.ok) {
            toast.warning("Couldn't start recording", {
              description: START_RECORDING_REFUSAL_COPY[response.reason],
            });
            return;
          }
          // Optimistic, and superseded by this run's own `recordingStarted`
          // frame. If that frame never comes (no file-events stream on this
          // host) the badge stays on `starting` - which is honest, and the
          // stop button still addresses the run by the id the host just
          // minted.
          setBadge({ phase: "starting", recordingId: response.recordingId });
        },
      },
    );
  }, [badge, epicId, recordingId, startRecording, stopRecording, tabId]);

  const inFlight = badge !== null && badge.phase !== "ended";
  return (
    <>
      {props.capture ? (
        <CaptureScreenshotButton
          disabled={props.disabled}
          pending={captureScreenshot.isPending}
          onCapture={onCapture}
        />
      ) : null}
      {props.record ? (
        <RecordTabButton
          disabled={props.disabled}
          pending={startRecording.isPending || stopRecording.isPending}
          inFlight={inFlight}
          onToggle={onToggleRecording}
        />
      ) : null}
      {badge === null ? null : (
        <BrowserTileRecordingBadge badge={badge} uploadStatus={uploadStatus} />
      )}
    </>
  );
}

function CaptureScreenshotButton(props: {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onCapture: () => void;
}) {
  return (
    <TooltipWrapper
      label="Capture screenshot"
      side="top"
      sideOffset={6}
      align="center"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Capture screenshot"
        data-testid="browser-tile-capture"
        disabled={props.disabled || props.pending}
        onClick={props.onCapture}
      >
        {props.pending ? (
          <AgentSpinningDots
            className="text-muted-foreground"
            testId="browser-tile-capture-pending"
            variant={undefined}
          />
        ) : (
          <Camera aria-hidden />
        )}
      </Button>
    </TooltipWrapper>
  );
}

/**
 * One button for both edges of a run: `inFlight` is the badge's own
 * pre-`ended` state, so the label, the pressed state and the icon never
 * disagree with what the badge is showing.
 */
function RecordTabButton(props: {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly inFlight: boolean;
  readonly onToggle: () => void;
}) {
  const label = props.inFlight ? "Stop recording" : "Record tab";
  return (
    <TooltipWrapper label={label} side="top" sideOffset={6} align="center">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={props.inFlight}
        data-testid="browser-tile-record"
        disabled={props.disabled || props.pending}
        onClick={props.onToggle}
      >
        {props.inFlight ? (
          <Square aria-hidden />
        ) : (
          <Circle aria-hidden className="text-destructive" />
        )}
      </Button>
    </TooltipWrapper>
  );
}

/**
 * Lit for the whole run (D20). `role="status"` with a polite live region so a
 * screen reader hears the run start, and hears how it ended - a recording
 * control is not a place to leave the state visual-only. The elapsed clock is
 * NOT in the live region for the same reason: a per-second announcement would
 * bury the two edges that matter.
 */
function BrowserTileRecordingBadge(props: {
  readonly badge: CaptureBadgeState;
  readonly uploadStatus: EpicFileStatusOrUnknown | null;
}) {
  const badge = props.badge;
  const live = badge.phase === "recording";
  return (
    <div
      className={cn(
        "flex min-w-0 shrink items-center gap-1.5 rounded-sm border px-2 py-1 text-ui-xs",
        live
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground",
      )}
      data-testid="browser-tile-recording-badge"
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          live ? "bg-destructive motion-safe:animate-pulse" : "bg-current",
        )}
      />
      <span role="status" aria-live="polite" className="min-w-0 truncate">
        {recordingBadgeLabel(badge, props.uploadStatus)}
      </span>
      {live ? (
        <RecordingElapsed key={badge.startedAt} startedAt={badge.startedAt} />
      ) : null}
    </div>
  );
}

function recordingBadgeLabel(
  badge: CaptureBadgeState,
  uploadStatus: EpicFileStatusOrUnknown | null,
): string {
  switch (badge.phase) {
    case "starting":
      return "Starting recording";
    case "recording":
      return "Recording";
    case "ended":
      // While the run saved but its clip entry has not replicated yet there is
      // no status to report, so the outcome's own word stands in - never a
      // guessed "Uploading" for bytes that may already be up.
      return badge.outcome === "saved" && uploadStatus !== null
        ? UPLOAD_STATUS_COPY[uploadStatus]
        : RECORDING_OUTCOME_COPY[badge.outcome];
    default: {
      const unhandled: never = badge;
      void unhandled;
      return "";
    }
  }
}

/**
 * Wall-clock elapsed since the host said the run began, re-read once a second.
 * `startedAt` is the arrival of the `recordingStarted` frame rather than a
 * host timestamp: the frame carries none, and a clock skew between two
 * machines would make the tile's own counter start negative.
 *
 * The caller keys this on `startedAt`, so a second run remounts it and the
 * clock re-seeds from its own initializer - no effect re-runs to reset it.
 */
function RecordingElapsed(props: { readonly startedAt: number }) {
  const startedAt = props.startedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return (
    <span className="shrink-0 tabular-nums">
      {minutes}:{String(remainder).padStart(2, "0")}
    </span>
  );
}
