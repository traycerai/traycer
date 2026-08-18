/**
 * The output window (`UI.md` §4): a read-only view of one managed command's
 * log. Deliberately NOT a terminal - managed commands are spawned over pipes
 * with no PTY, so there are no escape sequences to emulate and the lines arrive
 * already framed. A text view is truer and cheaper than an xterm.
 *
 * One interleaved timeline (stdout, tinted stderr, and lifecycle records as
 * distinct rows) with timestamps on by default, opened at the tail and paged
 * backwards on demand. Follow mode is the default and pauses the moment the
 * human scrolls away from the newest line.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { ArrowDownToLine, Info } from "lucide-react";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { SegmentCopyButton } from "@/components/chat/segments/segment-copy-button";
import { ManagedCommandChatBacklink } from "@/components/managed-commands/managed-command-chat-backlink";
import { ManagedCommandLifecycleActions } from "@/components/managed-commands/managed-command-lifecycle-actions";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import {
  useHostReachability,
  resolvedHostLabel,
} from "@/hooks/agent/use-host-reachability";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { TileHostLoadState } from "@/components/epic-canvas/renderers/tile-host-load-state";
import { ShellOutputAvailabilityNotice } from "@/components/managed-commands/shell-output-availability-notice";
import { useEffectiveTerminalFont } from "@/hooks/settings/use-effective-terminal-font";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import { useManagedCommandOutputSession } from "@/hooks/managed-command/use-managed-command-output-session";
import type {
  ManagedCommand,
  ManagedCommandCadence,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import type {
  ManagedCommandOutputStoreHandle,
  ManagedCommandTimelineLine,
} from "@/stores/managed-commands/managed-command-output-store";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import {
  MANAGED_COMMAND_OUTPUT_WINDOW_TITLE,
  managedCommandStatusLabel,
} from "@/lib/managed-commands/managed-command-copy";
import {
  isShellOutputBanner,
  isShellOutputPanelReplacement,
  shellOutputHostAvailability,
  shellOutputStreamAvailability,
} from "@/lib/managed-commands/shell-output-availability";
import type { ManagedCommandOutputTileRef } from "@/stores/epics/canvas/types";
import { cn } from "@/lib/utils";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import {
  readReadingPosition,
  readingPositionIdentityForTileInstance,
  registerReadingPositionCapture,
  saveReadingPosition,
} from "@/lib/reading-position";

/**
 * How close to the newest line still counts as "following". A few pixels of
 * slack keeps sub-pixel scroll positions and a mid-flight append from reading
 * as the human deliberately scrolling away.
 */
const FOLLOW_SLACK_PX = 24;
/** Distance from the top that asks for the next page of older lines. */
const LOAD_OLDER_THRESHOLD_PX = 48;
/**
 * One test id for whatever the window has to say instead of (or over) the log;
 * the notice's `data-availability` carries WHICH state it is.
 */
const AVAILABILITY_NOTICE_TEST_ID = "managed-command-output-availability";

let nextManagedOutputSessionIdentity = 1;
const managedOutputSessionIdentityByStore = new WeakMap<object, string>();

function managedOutputSessionViewKey(
  tileInstanceId: string,
  store: object,
): string {
  const existing = managedOutputSessionIdentityByStore.get(store);
  if (existing !== undefined) return `${tileInstanceId}:${existing}`;
  const minted = `managed-output-session-${String(nextManagedOutputSessionIdentity)}`;
  nextManagedOutputSessionIdentity += 1;
  managedOutputSessionIdentityByStore.set(store, minted);
  return `${tileInstanceId}:${minted}`;
}

interface ManagedCommandReadingAnchor {
  readonly following: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

function isManagedCommandReadingAnchor(
  value: unknown,
): value is ManagedCommandReadingAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (
    !("following" in value) ||
    !("scrollTop" in value) ||
    !("scrollHeight" in value)
  ) {
    return false;
  }
  return (
    typeof value.following === "boolean" &&
    typeof value.scrollTop === "number" &&
    Number.isFinite(value.scrollTop) &&
    typeof value.scrollHeight === "number" &&
    Number.isFinite(value.scrollHeight)
  );
}

function initialManagedCommandFollowing(
  anchor: ManagedCommandReadingAnchor | null,
): boolean {
  return anchor === null ? true : anchor.following;
}

export interface ManagedCommandOutputTileProps {
  readonly node: ManagedCommandOutputTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly epicId: string;
}

/**
 * Three layers, because each one gates the hooks of the next: the host has to
 * be reachable before a stream is dialled, and the stream's store has to exist
 * before it can be read. Every layer answers with the same
 * `ShellOutputAvailability` vocabulary and the same notice, so the reader
 * cannot tell where the seam is - only which wait, or which ending, this is.
 */
export function ManagedCommandOutputTile(props: ManagedCommandOutputTileProps) {
  const { epicId, node } = props;
  const reachability = useHostReachability(node.hostId);
  // Same bounded, worded wait the terminal tiles get (audit S5): a bare
  // spinner said nothing about which host it was waiting on and had no end.
  const hostLoad = useBoundedHostLoad({
    hostId: node.hostId,
    hostLabel: resolvedHostLabel(reachability),
    pending:
      reachability.status === "checking" ||
      reachability.status === "host-starting",
  });
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    node.instanceId,
  );

  const hostGate = shellOutputHostAvailability(reachability);
  if (hostGate !== null) {
    return (
      <ShellOutputAvailabilityNotice
        availability={hostGate}
        onClose={closeCanvasTile}
        onReopen={null}
        className={undefined}
        testId={AVAILABILITY_NOTICE_TEST_ID}
      />
    );
  }
  // Below the availability gate, not instead of it: the gate answers for
  // the HOST (unreachable / starting, in the shared shell vocabulary); this
  // bounds the remaining load window so a reachable host's slow read can
  // never hold the tile on a bare skeleton (the F4 class).
  if (hostLoad.kind !== "ready") {
    return (
      <TileHostLoadState
        load={hostLoad}
        subject="shell-output"
        onRetry={null}
        testId="managed-command-output-load"
      />
    );
  }
  return (
    <ManagedCommandOutputTileLive
      epicId={epicId}
      node={node}
      viewTabId={props.viewTabId}
      onClose={closeCanvasTile}
    />
  );
}

function ManagedCommandOutputTileLive(props: {
  readonly epicId: string;
  readonly node: ManagedCommandOutputTileRef;
  readonly viewTabId: string;
  readonly onClose: () => void;
}) {
  const { epicId, node } = props;
  const { session, reopen } = useManagedCommandOutputSession({
    epicId,
    commandId: node.id,
    hostId: node.hostId,
  });

  if (session === null) {
    return (
      <ShellOutputAvailabilityNotice
        availability={{ kind: "bootstrapping", phase: "opening-stream" }}
        onClose={props.onClose}
        onReopen={null}
        className={undefined}
        testId={AVAILABILITY_NOTICE_TEST_ID}
      />
    );
  }
  return (
    <ManagedCommandOutputTileBody
      epicId={epicId}
      node={node}
      viewTabId={props.viewTabId}
      onClose={props.onClose}
      onReopen={reopen}
      session={session}
    />
  );
}

function ManagedCommandOutputTileBody(props: {
  readonly epicId: string;
  readonly node: ManagedCommandOutputTileRef;
  readonly viewTabId: string;
  readonly onClose: () => void;
  readonly onReopen: () => void;
  readonly session: ManagedCommandOutputStoreHandle;
}) {
  const { epicId, node, session } = props;
  const store = session.store;
  const command = useStore(store, (state) => state.command);
  const lines = useStore(store, (state) => state.lines);
  const deleted = useStore(store, (state) => state.deleted);
  const fatalClose = useStore(store, (state) => state.fatalClose);
  const connectionStatus = useStore(store, (state) => state.connectionStatus);
  const reachedStart = useStore(store, (state) => state.reachedStart);
  const loadingOlder = useStore(store, (state) => state.loadingOlder);
  const loadOlder = useStore(store, (state) => state.loadOlder);
  // Asked of the client this window's own subscription rides on. The app-wide
  // reader answers for the DEFAULT host, and a tab is bound to its own host for
  // life - when the two differ, the default host's answer is about the wrong
  // machine, and this window would either call a capable host too old or take
  // an old host's refusal for a deletion.
  const streamSupport = useStreamMethodSupportFor(
    session.streamMethodSupport,
    "managedCommand.subscribeOutput",
  );
  const terminalFont = useEffectiveTerminalFont();

  const visible = useTileBodyVisible();
  const readingIdentity = useMemo(
    () => ({
      ...readingPositionIdentityForTileInstance(node.instanceId),
      viewKey: managedOutputSessionViewKey(node.instanceId, store),
    }),
    [node.instanceId, store],
  );
  const restoredReadingAnchor = useMemo(
    () =>
      readReadingPosition(
        readingIdentity,
        "managed-command",
        isManagedCommandReadingAnchor,
      ),
    [readingIdentity],
  );
  const viewRef = useRef<HTMLDivElement>(null);
  const lastReadingAnchorRef = useRef<ManagedCommandReadingAnchor | null>(
    restoredReadingAnchor,
  );
  const restoredReadingPositionRef = useRef(false);
  const [following, setFollowing] = useState(() =>
    initialManagedCommandFollowing(restoredReadingAnchor),
  );
  // What the timeline looked like at the last moment we could measure it:
  // the oldest row's identity, and how tall the document was. A page of older
  // lines prepends content ABOVE the viewport, which slides everything the
  // human is reading down by exactly the height added.
  const anchorRef = useRef<{
    readonly firstSeq: number | null;
    readonly scrollHeight: number;
  }>({ firstSeq: null, scrollHeight: 0 });

  const scrollToNewest = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.scrollTop = view.scrollHeight;
  }, []);

  const captureReadingPosition = useCallback((): void => {
    const view = viewRef.current;
    const anchor =
      view !== null && view.clientHeight !== 0
        ? {
            following,
            scrollTop: view.scrollTop,
            scrollHeight: view.scrollHeight,
          }
        : lastReadingAnchorRef.current;
    if (anchor === null) return;
    lastReadingAnchorRef.current = anchor;
    saveReadingPosition(readingIdentity, "managed-command", anchor);
  }, [following, readingIdentity]);

  useLayoutEffect(
    () =>
      registerReadingPositionCapture({
        captureKey: node.instanceId,
        identity: readingIdentity,
        capture: captureReadingPosition,
      }),
    [captureReadingPosition, node.instanceId, readingIdentity],
  );

  useLayoutEffect(() => {
    if (!visible) {
      captureReadingPosition();
      restoredReadingPositionRef.current = false;
      return;
    }
    if (restoredReadingPositionRef.current || lines.length === 0) return;
    // Read again after a hidden interval: that path captures a newer anchor
    // without changing `readingIdentity`, so the mount seed can be stale.
    const anchor = readReadingPosition(
      readingIdentity,
      "managed-command",
      isManagedCommandReadingAnchor,
    );
    if (anchor === null || anchor.following) {
      restoredReadingPositionRef.current = true;
      return;
    }
    const view = viewRef.current;
    if (view === null || view.clientHeight === 0) return;
    const max = Math.max(0, view.scrollHeight - view.clientHeight);
    const proportional =
      anchor.scrollHeight <= 0
        ? 0
        : Math.round(
            (anchor.scrollTop / anchor.scrollHeight) * view.scrollHeight,
          );
    view.scrollTop =
      anchor.scrollTop <= max ? anchor.scrollTop : Math.min(proportional, max);
    restoredReadingPositionRef.current = true;
  }, [captureReadingPosition, lines.length, readingIdentity, visible]);

  // Runs before paint, so the correction is never a visible jump. Browsers do
  // have native scroll anchoring, but the spec suppresses it at scrollTop 0 -
  // precisely where a load-older fires - so the position has to be held here.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const firstSeq = lines.length > 0 ? lines[0].seq : null;
    const previous = anchorRef.current;
    const prepended =
      previous.firstSeq !== null &&
      firstSeq !== null &&
      firstSeq < previous.firstSeq;
    if (prepended) {
      view.scrollTop += view.scrollHeight - previous.scrollHeight;
    }
    anchorRef.current = { firstSeq, scrollHeight: view.scrollHeight };
  }, [lines]);

  // Following is a scroll effect, not render state: new lines land, then the
  // view is pinned back to the bottom.
  useEffect(() => {
    if (!following) return;
    scrollToNewest();
  }, [following, lines, scrollToNewest]);

  // A Terminal typography change resizes every row at once, so the geometry
  // both the follow latch and the prepend correction were measured against is
  // wrong the moment it lands - and no line arrived to trigger the effects that
  // normally re-measure. Re-pin before paint instead of leaving the reader
  // somewhere they did not scroll to.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (following) view.scrollTop = view.scrollHeight;
    anchorRef.current = {
      firstSeq: anchorRef.current.firstSeq,
      scrollHeight: view.scrollHeight,
    };
  }, [following, terminalFont.fontFamily, terminalFont.fontSize]);

  const onScroll = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    // Keep the anchor honest between renders: the human scrolling is the other
    // way the measurable geometry changes.
    anchorRef.current = {
      firstSeq: anchorRef.current.firstSeq,
      scrollHeight: view.scrollHeight,
    };
    const distanceFromBottom =
      view.scrollHeight - view.scrollTop - view.clientHeight;
    setFollowing(distanceFromBottom <= FOLLOW_SLACK_PX);
    const nextAnchor = {
      following: distanceFromBottom <= FOLLOW_SLACK_PX,
      scrollTop: view.scrollTop,
      scrollHeight: view.scrollHeight,
    };
    lastReadingAnchorRef.current = nextAnchor;
    saveReadingPosition(readingIdentity, "managed-command", nextAnchor);
    if (view.scrollTop <= LOAD_OLDER_THRESHOLD_PX) {
      loadOlder();
    }
  }, [loadOlder, readingIdentity]);

  // Derived here, after the scroll machinery above, and read only by the JSX
  // below: what the window shows is a pure function of the store's signals
  // and the bound host's capability, computed once per render.
  const availability = shellOutputStreamAvailability({
    streamSupport,
    connectionStatus,
    snapshotArrived: command !== null,
    hasLines: lines.length > 0,
    deleted,
    fatalClose,
  });

  // A terminal state, or a host that cannot serve the stream: the panel is the
  // sentence, and nothing of the log survives under it. Whatever this window
  // had read is not the history any more - the host destroyed or withdrew
  // that - and a ghost of it contradicted every other surface's account of a
  // deleted shell.
  if (isShellOutputPanelReplacement(availability)) {
    return (
      <ShellOutputAvailabilityNotice
        availability={availability}
        onClose={props.onClose}
        onReopen={props.onReopen}
        className={undefined}
        testId={AVAILABILITY_NOTICE_TEST_ID}
      />
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-canvas">
      {isShellOutputBanner(availability) ? (
        <ShellOutputAvailabilityNotice
          availability={availability}
          onClose={props.onClose}
          onReopen={props.onReopen}
          testId={AVAILABILITY_NOTICE_TEST_ID}
          className="border-b border-border/60 px-3"
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        {/*
         * Present whenever a snapshot has said what this shell is - including
         * under a failed stream. Process status and stream status are two
         * different facts: a broken output stream must never hide Stop for a
         * process that is still running.
         */}
        {command === null ? null : (
          <ManagedCommandOutputControls
            command={command}
            epicId={epicId}
            hostId={node.hostId}
            viewTabId={props.viewTabId}
          />
        )}
        <div
          ref={viewRef}
          onScroll={onScroll}
          data-testid="managed-command-output-timeline"
          role="log"
          aria-label={
            command === null ? "Output" : MANAGED_COMMAND_OUTPUT_WINDOW_TITLE
          }
          // Command output is terminal output, so it follows the Terminal
          // typography settings the way a terminal tile does. `font-mono` and
          // the `text-*` scales would silently track the Code font instead,
          // leaving a Terminal override with no effect on the one surface
          // whose whole content is a program's stdout. Colours stay the log
          // view's own (stderr tint, lifecycle rows).
          style={{
            fontFamily: terminalFont.fontFamily,
            fontSize: `${terminalFont.fontSize}px`,
          }}
          // The floating cluster hangs over this surface, so the log reserves
          // a lane for it on the right. Without that, the cluster sits on the
          // tail of whichever line happens to be at the top - permanently,
          // since the log scrolls under it - and a reader loses the end of a
          // line for no reason they can see. The lane is a share of the
          // width, capped: a fixed lane the cluster's full width took a third
          // of a narrow pane away from the log, which is the one thing a
          // person opened it to read - so on a narrow pane the lane shrinks
          // and the cluster may overlap the tail of a long line, and on a wide
          // one it never grows past what the cluster actually needs.
          className="h-full w-full overflow-y-auto py-2 pr-[min(30%,12rem)] pl-3 leading-relaxed"
        >
          {loadingOlder ? (
            <div className="flex justify-center py-1">
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="managed-command-output-loading-older"
                variant={undefined}
              />
            </div>
          ) : null}
          {reachedStart && lines.length > 0 ? (
            <p className="py-1 text-center text-muted-foreground/60">
              Start of the retained log
            </p>
          ) : null}
          {/*
           * An opened, empty log says so. Blank, it was indistinguishable from
           * a stream that never connected.
           */}
          {availability.kind === "empty" ? (
            <ShellOutputAvailabilityNotice
              availability={availability}
              onClose={props.onClose}
              onReopen={props.onReopen}
              className={undefined}
              testId={AVAILABILITY_NOTICE_TEST_ID}
            />
          ) : null}
          {lines.map((line) => (
            <OutputRow key={line.seq} line={line} />
          ))}
        </div>
        {following ? null : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="managed-command-output-jump-live"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
            onClick={() => {
              setFollowing(true);
              scrollToNewest();
            }}
          >
            <ArrowDownToLine aria-hidden className="size-3.5" />
            Jump to live
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The window's whole chrome, floating over the log's top-right corner instead
 * of sitting in a bar above it.
 *
 * The bar this replaces spent a permanent row of every shell window restating
 * what the TAB beside it already said - the same glyph, the same
 * "Monitor · deploy watcher" - so the log, which is the only thing here a
 * person came to read, started one line lower for nothing. Identity lives in
 * the tab; what stays is the pair of facts the tab cannot carry: what the shell
 * is doing right now, and the two verbs that change it.
 *
 * Backdrop-blurred rather than opaque, so it reads as hovering over the log
 * rather than as a hole punched in it, and the reader can still see that text
 * continues underneath.
 */
function ManagedCommandOutputControls(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string;
}) {
  return (
    <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1">
      {/*
       * Stays pointer-transparent: it is a readout, and it sits permanently
       * over a corner of a scrollable log, so a wheel turn there has to reach
       * the log rather than land on a label that cannot do anything with it.
       */}
      <span
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-canvas/80 px-2 py-1 text-ui-xs text-foreground/85 shadow-sm backdrop-blur-sm"
        data-testid="managed-command-output-status"
      >
        <ManagedCommandStatusDot
          status={props.command.status}
          className={undefined}
        />
        {managedCommandStatusLabel(props.command.status)}
      </span>
      <span className="pointer-events-auto flex shrink-0 items-center rounded-md border border-border/60 bg-canvas/80 px-0.5 shadow-sm backdrop-blur-sm">
        <ManagedCommandOutputDetails
          command={props.command}
          epicId={props.epicId}
          hostId={props.hostId}
          viewTabId={props.viewTabId}
        />
        <ManagedCommandLifecycleActions
          command={props.command}
          epicId={props.epicId}
          hostId={props.hostId}
          className={undefined}
        />
      </span>
    </div>
  );
}

/**
 * Everything about this shell that is not its output, one click away.
 *
 * The window used to answer "what exactly is this running, and where?" with
 * nothing at all - you went to the agent's transcript and found the tool call.
 * That is the surface refusing to say what it plainly knows, and it is the
 * question a person reading a log at 3am actually has.
 *
 * Every field here is CURRENT, not historical, and says so. The retained log
 * spans every run of this shell, and a restart can re-spec both the command and
 * its directory - so these describe the shell as it stands now rather than
 * whatever produced the lines being read. The transcript's start card is the
 * other half of that pair: it holds the command the creating call asked for,
 * frozen.
 */
function ManagedCommandOutputDetails(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string;
}) {
  const { command } = props;
  const pid = command.status.state === "running" ? command.status.pid : null;
  return (
    <Popover>
      <TooltipWrapper
        label="Details"
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Shell details"
            data-testid="managed-command-output-details"
            className="size-6 text-muted-foreground hover:text-foreground"
          >
            <Info aria-hidden className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-[min(90vw,26rem)] p-3 text-ui-xs"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          <DetailRow label="Command">
            {/* Wrapping, not truncated: a shell command is the one value here
                worth reading in full, and it is the reason someone opened this.
                Copyable for the "run it myself" move. */}
            <span className="flex items-start gap-1">
              <span
                className="min-w-0 font-mono wrap-anywhere"
                data-testid="managed-command-output-details-command"
              >
                {command.command ?? "—"}
              </span>
              {command.command === null ? null : (
                <SegmentCopyButton
                  value={command.command}
                  ariaLabel="Copy command"
                  className={undefined}
                />
              )}
            </span>
          </DetailRow>
          <DetailRow label="Directory">
            <span className="font-mono wrap-anywhere">
              {command.cwd ?? "—"}
            </span>
          </DetailRow>
          {/* Only while it runs: a pid outlives nothing, and a stale one points
              at whatever the OS handed out next. */}
          {pid === null ? null : (
            <DetailRow label="PID">
              <span className="font-mono tabular-nums">{pid}</span>
            </DetailRow>
          )}
          {command.cadence === null ? null : (
            <DetailRow label="Notifies">
              <span data-testid="managed-command-output-details-cadence">
                {managedCommandCadenceSentence(command.cadence)}
              </span>
            </DetailRow>
          )}
          <DetailRow label="Started by">
            <ManagedCommandChatBacklink
              epicId={props.epicId}
              tabId={props.viewTabId}
              chatId={command.chatId}
              fallbackHostId={props.hostId}
              testId="managed-command-output-backlink"
              className={undefined}
            />
          </DetailRow>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function DetailRow(props: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 text-foreground/90">{props.children}</dd>
    </>
  );
}

/**
 * The pacing in one short line. Whoever opened this popover already knows what
 * a monitor is; each number gets a one-word tag and no more, so the row reads
 * at a glance instead of as a paragraph.
 */
function managedCommandCadenceSentence(cadence: ManagedCommandCadence): string {
  const duration = (ms: number): string =>
    ms % 1000 === 0 ? `${(ms / 1000).toString()}s` : `${ms.toString()}ms`;
  return `On output · ${duration(cadence.debounceMs)} quiet · ${duration(cadence.maxWaitMs)} max wait · ${duration(cadence.throttleMs)} min gap`;
}

const CHANNEL_CLASS = {
  stdout: "text-foreground",
  stderr: "text-destructive",
  lifecycle: "text-muted-foreground italic",
} as const;

function OutputRow(props: { readonly line: ManagedCommandTimelineLine }) {
  const { line } = props;
  return (
    <div
      data-testid={`managed-command-output-line-${line.seq}`}
      data-channel={line.channel}
      className="flex min-w-0 gap-2"
    >
      <span
        data-testid={`managed-command-output-time-${line.seq}`}
        className="shrink-0 tabular-nums text-muted-foreground/60"
      >
        {formatLineTime(line.atMs)}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere",
          CHANNEL_CLASS[line.channel],
        )}
      >
        {line.text}
      </span>
    </div>
  );
}

/**
 * Wall-clock time of day, seconds included: a human reading a shell at 3am is
 * matching lines against something else that happened, and the date is already
 * carried by the window they are in. `null` is a line the host could not read a
 * timestamp from - a partial record left by a crash.
 */
function formatLineTime(atMs: number | null): string {
  if (atMs === null) return "--:--:--";
  return new Date(atMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
