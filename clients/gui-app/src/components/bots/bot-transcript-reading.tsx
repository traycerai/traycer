import type { BotReadPosition } from "@traycer/protocol/host/bot/schemas";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatMessage } from "@/stores/composer/chat-store";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import { useBotReadCursors } from "@/hooks/bots/use-bot-read-cursor";
import {
  useAdvanceWhilePresented,
  usePresented,
} from "@/hooks/bots/use-bot-read-while-presented";
import { useBotMarkRepresentedRead } from "@/hooks/bots/use-bot-mark-represented-read";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { advanceTarget } from "@/lib/bots/bot-read-cursor";
import { isDocumentFocused } from "@/lib/notifications/notification-presence";
import { BotUnreadBanner } from "@/components/bots/bot-unread-banner";

/** The Threads policy, shared by every automatic bot-conversation read. */
const READ_AFTER_MS = 1_000;

type ObserveRow = (node: HTMLElement, message: ChatMessage) => () => void;
const ObservedRowsContext = createContext<ObserveRow | null>(null);
import { BotReadPresenceContext } from "@/components/bots/bot-read-presence-context";
export type BotUnreadLanding =
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "ordinal"; readonly ordinal: number };

/** Only the transcript's actual message renderer registers, never a placeholder or post stand-in. */
export function BotReadObservedRow(props: {
  readonly message: ChatMessage;
  readonly children: ReactNode;
}): ReactNode {
  const observe = useContext(ObservedRowsContext);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null && observe !== null)
        return observe(node, props.message);
    },
    [observe, props.message],
  );
  if (observe === null) return props.children;
  return (
    <div ref={ref} data-bot-read-row={props.message.id}>
      {props.children}
    </div>
  );
}

interface ObservedRow {
  readonly message: ChatMessage;
  readonly covered: { from: number; to: number }[];
  timer: number | null;
  complete: boolean;
  size: { readonly width: number; readonly height: number } | null;
}

const NO_SEEN_ROWS: ReadonlyMap<string, ChatMessage> = new Map();

function useObservedRows(
  enabled: boolean,
  epoch: string,
): {
  readonly observe: ObserveRow;
  readonly seen: ReadonlyMap<string, ChatMessage>;
} {
  const nodes = useRef(new Map<HTMLElement, ObservedRow>());
  const observer = useRef<IntersectionObserver | null>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const [seen, setSeen] = useState<{
    readonly enabled: boolean;
    readonly epoch: string;
    readonly messages: ReadonlyMap<string, ChatMessage>;
  }>({ enabled, epoch, messages: NO_SEEN_ROWS });
  const observe = useCallback<ObserveRow>((node, message) => {
    const row: ObservedRow = {
      message,
      covered: [],
      timer: null,
      complete: false,
      size: null,
    };
    nodes.current.set(node, row);
    observer.current?.observe(node);
    resizeObserver.current?.observe(node);
    return () => {
      if (row.timer !== null) window.clearTimeout(row.timer);
      observer.current?.unobserve(node);
      resizeObserver.current?.unobserve(node);
      nodes.current.delete(node);
    };
  }, []);
  if (seen.enabled !== enabled || seen.epoch !== epoch)
    setSeen({ enabled, epoch, messages: NO_SEEN_ROWS });
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const stop = (row: ObservedRow): void => {
      if (row.timer !== null) window.clearTimeout(row.timer);
      row.timer = null;
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const node = entry.target;
          if (!(node instanceof HTMLElement)) continue;
          const row = nodes.current.get(node);
          if (row === undefined) continue;
          stop(row);
          if (row.complete) continue;
          const box = entry.boundingClientRect;
          const visible = entry.intersectionRect;
          if (
            !entry.isIntersecting ||
            box.height <= 0 ||
            visible.width < box.width ||
            visible.height <= 0
          )
            continue;
          const from = Math.max(0, (visible.top - box.top) / box.height);
          const to = Math.min(1, (visible.bottom - box.top) / box.height);
          row.timer = window.setTimeout(() => {
            row.timer = null;
            if (!isDocumentFocused()) return;
            const now = node.getBoundingClientRect();
            if (
              now.top !== box.top ||
              now.left !== box.left ||
              now.width !== box.width ||
              now.height !== box.height
            ) {
              io.unobserve(node);
              io.observe(node);
              return;
            }
            row.covered.push({ from, to });
            row.covered.sort((a, b) => a.from - b.from);
            const merged: { from: number; to: number }[] = [];
            for (const span of row.covered) {
              const previous = merged.at(-1);
              if (previous !== undefined && span.from <= previous.to)
                previous.to = Math.max(previous.to, span.to);
              else merged.push({ ...span });
            }
            row.covered.splice(0, row.covered.length, ...merged);
            if (
              merged.length === 1 &&
              merged[0].from === 0 &&
              merged[0].to === 1
            ) {
              row.complete = true;
              setSeen((previous) => ({
                enabled,
                epoch,
                messages: new Map(previous.messages).set(
                  row.message.id,
                  row.message,
                ),
              }));
            }
          }, READ_AFTER_MS);
        }
      },
      { threshold: [0, 1] },
    );
    observer.current = io;
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const node = entry.target;
              if (!(node instanceof HTMLElement)) continue;
              const row = nodes.current.get(node);
              if (row === undefined) continue;
              const size = {
                width: entry.contentRect.width,
                height: entry.contentRect.height,
              };
              const previous = row.size;
              row.size = size;
              if (
                previous === null ||
                (previous.width === size.width &&
                  previous.height === size.height)
              )
                continue;
              stop(row);
              row.covered.length = 0;
              row.complete = false;
              setSeen((previousSeen) => {
                const messages = new Map(previousSeen.messages);
                messages.delete(row.message.id);
                return { enabled, epoch, messages };
              });
              io.unobserve(node);
              io.observe(node);
            }
          });
    resizeObserver.current = resized;
    nodes.current.forEach((row, node) => {
      row.covered.length = 0;
      row.complete = false;
      io.observe(node);
      resized?.observe(node);
    });
    // A tall row can move without crossing an intersection-ratio threshold.
    // Re-observe after motion so its next dwell uses the newly exposed extent.
    const moved = (event: Event): void => {
      for (const [node, row] of nodes.current) {
        if (event.target instanceof Element && !event.target.contains(node))
          continue;
        if (row.complete) continue;
        stop(row);
        io.unobserve(node);
        io.observe(node);
      }
    };
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    const observedNodes = nodes.current;
    return () => {
      for (const row of observedNodes.values()) stop(row);
      io.disconnect();
      resized?.disconnect();
      observer.current = null;
      resizeObserver.current = null;
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [enabled, epoch]);
  return {
    observe,
    seen:
      seen.enabled === enabled && seen.epoch === epoch
        ? seen.messages
        : NO_SEEN_ROWS,
  };
}

function carries(row: TranscriptListRow, id: string): boolean {
  return (
    row.kind === "hydrated" &&
    (row.model.persistentMessageId === id ||
      row.model.turnMessageIds?.includes(id) === true)
  );
}

interface ReadAnchor {
  readonly position: BotReadPosition;
  readonly rowKey: string;
  readonly ordinal: number | null;
  readonly epoch: string;
}

function sameAnchor(a: ReadAnchor | null, b: ReadAnchor | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.epoch === b.epoch &&
      a.rowKey === b.rowKey &&
      a.ordinal === b.ordinal &&
      a.position.messageId === b.position.messageId &&
      a.position.seq === b.position.seq)
  );
}

function matchesCursor(
  anchor: ReadAnchor | null,
  cursor: BotReadPosition,
  epoch: string,
): boolean {
  return (
    anchor !== null &&
    anchor.epoch === epoch &&
    anchor.position.messageId === cursor.messageId &&
    anchor.position.seq === cursor.seq
  );
}

function anchorIndex(
  rows: readonly TranscriptListRow[],
  anchor: ReadAnchor,
): number {
  return rows.findIndex((row) =>
    anchor.ordinal === null
      ? row.key === anchor.rowKey
      : row.ordinal === anchor.ordinal,
  );
}

function currentAnchor(
  cursor: BotReadPosition | null,
  row: TranscriptListRow | undefined,
  held: {
    readonly current: ReadAnchor | null;
    readonly next: ReadAnchor | null;
  },
  epoch: string,
): ReadAnchor | null {
  if (cursor === null) return null;
  if (row !== undefined)
    return { position: cursor, rowKey: row.key, ordinal: row.ordinal, epoch };
  if (matchesCursor(held.current, cursor, epoch)) return held.current;
  if (matchesCursor(held.next, cursor, epoch)) return held.next;
  return null;
}

function unreadRange(
  rows: readonly TranscriptListRow[],
  cursor: BotReadPosition | null,
  anchor: ReadAnchor | null,
): readonly TranscriptListRow[] | null {
  if (cursor === null) return rows;
  if (anchor === null) return null;
  const index = anchorIndex(rows, anchor);
  return index < 0 ? null : rows.slice(index + 1);
}

function qualifiedPrefix(
  range: readonly TranscriptListRow[],
  seen: ReadonlyMap<string, ChatMessage>,
  positions: ReadonlyMap<string, BotReadPosition>,
  boundary: {
    readonly cursor: BotReadPosition | null;
    readonly target: BotReadPosition;
    readonly epoch: string;
  },
): ReadAnchor | null {
  const { cursor, target, epoch } = boundary;
  let qualified: ReadAnchor | null = null;
  for (const row of range) {
    if (row.kind === "placeholder" || seen.get(row.model.id) !== row.model)
      break;
    const id = row.model.persistentMessageId;
    const position = id === null ? undefined : positions.get(id);
    if (position === undefined || position.seq > target.seq) break;
    if (position.seq > (cursor?.seq ?? -Infinity))
      qualified = { position, rowKey: row.key, ordinal: row.ordinal, epoch };
    if (position.messageId === target.messageId) break;
  }
  return qualified;
}

/** A turn can grow in the row that already carries the cursor. */
function observedTurnExtension(
  row: TranscriptListRow | undefined,
  target: BotReadPosition,
  seen: ReadonlyMap<string, ChatMessage>,
  context: {
    readonly positions: ReadonlyMap<string, BotReadPosition>;
    readonly epoch: string;
  },
): ReadAnchor | null {
  const { positions, epoch } = context;
  if (
    row?.kind !== "hydrated" ||
    !carries(row, target.messageId) ||
    seen.get(row.model.id) !== row.model
  )
    return null;
  const position = positions.get(target.messageId);
  if (position === undefined || position.seq !== target.seq) return null;
  return { position, rowKey: row.key, ordinal: row.ordinal, epoch };
}

function unreadLanding(
  range: readonly TranscriptListRow[] | null,
  seen: ReadonlyMap<string, ChatMessage>,
  cursor: BotReadPosition | null,
): BotUnreadLanding {
  const first = range?.find(
    (row) => row.kind === "placeholder" || seen.get(row.model.id) !== row.model,
  );
  if (first?.kind === "placeholder")
    return { kind: "ordinal", ordinal: first.ordinal };
  if (first?.kind === "hydrated" && first.model.persistentMessageId !== null)
    return { kind: "message", messageId: first.model.persistentMessageId };
  return cursor === null
    ? { kind: "ordinal", ordinal: 0 }
    : { kind: "message", messageId: cursor.messageId };
}

function useQualifiedRange(args: {
  readonly rows: readonly TranscriptListRow[];
  readonly epoch: string;
  readonly cursor: BotReadPosition | null;
  readonly target: BotReadPosition | null;
  readonly presented: boolean;
  readonly seen: ReadonlyMap<string, ChatMessage>;
  readonly positions: ReadonlyMap<string, BotReadPosition>;
}): {
  readonly range: readonly TranscriptListRow[] | null;
  readonly qualified: ReadAnchor | null;
} {
  const { rows, epoch, cursor, target, presented, seen, positions } = args;
  // Remember only the current cursor row and the next proposed prefix.
  // Neither is trusted until the cloud cursor names the same persisted pair.
  const [anchors, setAnchors] = useState<{
    readonly current: ReadAnchor | null;
    readonly next: ReadAnchor | null;
  }>({ current: null, next: null });
  const cursorRow =
    cursor === null
      ? undefined
      : rows.findLast((row) => carries(row, cursor.messageId));
  const current = currentAnchor(cursor, cursorRow, anchors, epoch);
  const range = unreadRange(rows, cursor, current);
  let qualified: ReadAnchor | null = null;
  if (presented && target !== null) {
    if (range !== null)
      qualified = qualifiedPrefix(range, seen, positions, {
        cursor,
        target,
        epoch,
      });
    qualified =
      observedTurnExtension(cursorRow, target, seen, { positions, epoch }) ??
      qualified;
  }
  const next =
    qualified ?? (anchors.next?.epoch === epoch ? anchors.next : null);
  if (!sameAnchor(anchors.current, current) || !sameAnchor(anchors.next, next))
    setAnchors({ current, next });
  return { range, qualified };
}

export function BotTranscriptReading(props: {
  readonly botId: string;
  readonly conversationId: string;
  readonly hostId: string;
  readonly enabled: boolean;
  readonly epoch: string;
  readonly channelBanner: boolean;
  readonly rows: readonly TranscriptListRow[];
  readonly records: readonly OpenMessage[];
  readonly onNavigate: (landing: BotUnreadLanding) => void;
  readonly children: ReactNode;
}): ReactNode {
  const client = useTabHostClient();
  const read = useBotReadCursors(props.botId, props.hostId)?.data;
  const outerPresented = useContext(BotReadPresenceContext);
  const presented = usePresented(props.enabled && outerPresented);
  const target =
    read === undefined ? null : advanceTarget(read, props.conversationId);
  const { observe, seen } = useObservedRows(
    presented && target !== null,
    props.epoch,
  );
  const cursor = read?.cursors[props.conversationId] ?? null;
  const positions = useMemo(
    () =>
      new Map(
        props.records
          .filter(
            (record) =>
              record.role === "assistant" || record.message.kind === "user",
          )
          .map((record) => [
            record.messageId,
            { messageId: record.messageId, seq: record.timestamp },
          ]),
      ),
    [props.records],
  );
  const { range, qualified } = useQualifiedRange({
    rows: props.rows,
    epoch: props.epoch,
    cursor,
    target,
    presented,
    seen,
    positions,
  });
  useAdvanceWhilePresented({
    client,
    botId: props.botId,
    conversationId: props.conversationId,
    target: qualified?.position ?? null,
  });
  const mark = useBotMarkRepresentedRead(
    target === null
      ? []
      : [
          {
            botId: props.botId,
            conversationId: props.conversationId,
            ...target,
          },
        ],
  );
  const navigate = (): void =>
    props.onNavigate(unreadLanding(range, seen, cursor));
  return (
    <ObservedRowsContext value={props.enabled ? observe : null}>
      {props.channelBanner && (target !== null || mark.failed) ? (
        <BotUnreadBanner
          label="Unread messages"
          navigateTestId={undefined}
          onNavigate={navigate}
          onMarkRead={mark.markRead}
          pending={mark.pending}
          failed={mark.failed}
        />
      ) : null}
      {props.children}
    </ObservedRowsContext>
  );
}
