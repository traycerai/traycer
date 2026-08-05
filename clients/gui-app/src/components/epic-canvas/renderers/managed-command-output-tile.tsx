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
} from "react";
import { useStore } from "zustand";
import { ArrowDownToLine } from "lucide-react";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ManagedCommandChatBacklink } from "@/components/managed-commands/managed-command-chat-backlink";
import { ManagedCommandLifecycleActions } from "@/components/managed-commands/managed-command-lifecycle-actions";
import { ManagedCommandKindIcon } from "@/components/managed-commands/managed-command-kind-icon";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import { ManagedCommandConnectionNotice } from "@/components/managed-commands/managed-command-connection-notice";
import { ManagedCommandDeletedBanner } from "@/components/epic-canvas/renderers/dead-tile-banner";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { useManagedCommandOutputSession } from "@/hooks/managed-command/use-managed-command-output-session";
import type {
  ManagedCommandOutputStoreHandle,
  ManagedCommandTimelineLine,
} from "@/stores/managed-commands/managed-command-output-store";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import {
  managedCommandKindLabel,
  managedCommandOutputWindowTitle,
  managedCommandStatusLabel,
  managedCommandTitle,
} from "@/lib/managed-commands/managed-command-copy";
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

export function ManagedCommandOutputTile(props: ManagedCommandOutputTileProps) {
  const { epicId, node } = props;
  const reachability = useHostReachability(node.hostId);
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    node.instanceId,
  );

  if (reachability.status === "unreachable") {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
        data-testid="managed-command-output-unreachable"
        role="status"
      >
        <p className="max-w-md">
          Host &quot;{reachability.hostLabel}&quot; is unreachable, so this
          output cannot be read. The command and its log are kept on that host.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={closeCanvasTile}
        >
          Close tab
        </Button>
      </div>
    );
  }
  if (
    reachability.status === "checking" ||
    reachability.status === "host-starting"
  ) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId={undefined}
          variant={undefined}
        />
      </div>
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
  const session = useManagedCommandOutputSession({
    epicId,
    commandId: node.id,
    hostId: node.hostId,
  });

  if (session === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  return (
    <ManagedCommandOutputTileBody
      epicId={epicId}
      node={node}
      viewTabId={props.viewTabId}
      onClose={props.onClose}
      session={session}
    />
  );
}

function ManagedCommandOutputTileBody(props: {
  readonly epicId: string;
  readonly node: ManagedCommandOutputTileRef;
  readonly viewTabId: string;
  readonly onClose: () => void;
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
  const unsupported =
    useStreamMethodSupport("managedCommand.subscribeOutput") === "unsupported";

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

  if (unsupported) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-canvas px-6 text-center text-ui-sm text-muted-foreground"
        data-testid="managed-command-output-unavailable"
        role="status"
      >
        This host is too old to show monitors and shells.
      </div>
    );
  }

  // The command is gone either way; only how we learned differs. A `deleted`
  // frame arrives while the window is open, a NOT_FOUND close greets a window
  // restored for a command deleted while the app was shut.
  const gone = deleted || fatalClose !== null;

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-canvas">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        {command === null ? null : (
          <>
            <ManagedCommandKindIcon kind={command.kind} className={undefined} />
            <ManagedCommandStatusDot
              status={command.status}
              className={undefined}
            />
          </>
        )}
        <span
          className="min-w-0 flex-1 truncate text-ui-sm font-medium"
          data-testid="managed-command-output-title"
        >
          {command === null ? "Output" : managedCommandTitle(command)}
        </span>
        {command === null ? null : (
          <>
            <span
              className="shrink-0 text-ui-xs text-muted-foreground"
              data-testid="managed-command-output-status"
            >
              {managedCommandStatusLabel(command.status)}
            </span>
            <ManagedCommandChatBacklink
              epicId={epicId}
              tabId={props.viewTabId}
              chatId={command.chatId}
              fallbackHostId={node.hostId}
              testId="managed-command-output-backlink"
              className={undefined}
            />
            {gone ? null : (
              <ManagedCommandLifecycleActions
                command={command}
                epicId={epicId}
                hostId={node.hostId}
                className={undefined}
              />
            )}
          </>
        )}
      </div>

      {gone ? (
        <ManagedCommandDeletedBanner
          kindLabel={
            command === null ? null : managedCommandKindLabel(command.kind)
          }
          onClose={props.onClose}
          testId="managed-command-output-deleted"
        />
      ) : null}
      {!gone && connectionStatus !== "open" ? (
        <ManagedCommandConnectionNotice
          hasContent={lines.length > 0}
          testId="managed-command-output-disconnected"
          className="border-b border-border/60 px-3"
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={viewRef}
          onScroll={onScroll}
          data-testid="managed-command-output-timeline"
          role="log"
          aria-label={
            command === null
              ? "Output"
              : managedCommandOutputWindowTitle(command.kind)
          }
          className="h-full w-full overflow-y-auto px-3 py-2 font-mono text-ui-xs leading-relaxed"
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
 * Wall-clock time of day, seconds included: a human reading a monitor at 3am is
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
