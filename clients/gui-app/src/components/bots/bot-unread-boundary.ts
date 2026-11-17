import { BotVisitPresenceContext } from "@/components/bots/bot-read-presence-context";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useBotLifetime } from "@/lib/bots/bot-lifetime";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import type { BotReadCursorReadResponse } from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HostRpcRegistry } from "@/lib/host";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import { advanceTarget } from "@/lib/bots/bot-read-cursor";
import { useChatLocateRowAnswer } from "@/hooks/chats/use-chat-locate-row";

interface UnreadBoundary {
  readonly afterMessageId: string | null;
}

export interface BotTranscriptUnread extends UnreadBoundary {
  readonly visit: number;
}

/** Cards share one page destination; an explicit destination in any card retires it. */
export const BotUnreadPageNavigationContext = createContext<{
  readonly cancel: () => void;
  readonly isPending: (visit: number) => boolean;
} | null>(null);

/** A visual boundary belongs to a visit, not to the advancing read cursor. */
export function useBotUnreadBoundary(args: {
  readonly identity: string;
  readonly active: boolean;
  readonly read: BotReadCursorReadResponse | undefined;
  readonly conversationId: string;
}): UnreadBoundary | null {
  const { identity, active, read, conversationId } = args;
  const [held, setHeld] = useState<{
    readonly identity: string;
    readonly boundary: UnreadBoundary | null;
  }>({ identity, boundary: null });
  let boundary = held.identity === identity && active ? held.boundary : null;
  if (
    boundary === null &&
    active &&
    read !== undefined &&
    advanceTarget(read, conversationId) !== null
  ) {
    boundary = {
      afterMessageId: Object.hasOwn(read.cursors, conversationId)
        ? read.cursors[conversationId].messageId
        : null,
    };
  }
  if (held.identity !== identity || held.boundary !== boundary)
    setHeld({ identity, boundary });
  return boundary;
}

export const BotUnreadBoundaryContext = createContext<{
  readonly rowId: string | null;
  readonly cancelNavigation: () => void;
} | null>(null);

export type BotUnreadLanding =
  | { readonly kind: "boundary"; readonly rowId: string }
  | { readonly kind: "ordinal"; readonly ordinal: number | null };

type BoundaryTarget =
  | { readonly kind: "row"; readonly rowId: string; readonly messageId: string }
  | { readonly kind: "ordinal"; readonly ordinal: number }
  | { readonly kind: "locate"; readonly messageId: string }
  | { readonly kind: "none" };

function carries(row: TranscriptListRow, messageId: string): boolean {
  return (
    row.kind === "hydrated" &&
    (row.model.persistentMessageId === messageId ||
      row.model.turnMessageIds?.includes(messageId) === true)
  );
}

/** Merged assistant records retain their persisted order within the row. */
function hasRecordsAfter(row: TranscriptListRow, messageId: string): boolean {
  if (row.kind !== "hydrated") return false;
  const ids = row.model.turnMessageIds;
  if (ids === undefined) return false;
  const index = ids.lastIndexOf(messageId);
  return index >= 0 && index < ids.length - 1;
}

/** A placeholder prevents guessing who wrote the first unread row. */
function boundaryTarget(
  rows: readonly TranscriptListRow[],
  boundary: UnreadBoundary | null,
  viewerId: string | null,
): BoundaryTarget {
  if (boundary === null) return { kind: "none" };
  let after = -1;
  const afterMessageId = boundary.afterMessageId;
  if (afterMessageId !== null) {
    after = rows.findLastIndex((row) => carries(row, afterMessageId));
    if (after < 0) return { kind: "locate", messageId: afterMessageId };
    // The cursor can divide records inside one painted row. Include that row
    // rather than skipping its unread continuation along with the read part.
    if (hasRecordsAfter(rows[after], afterMessageId)) after -= 1;
  }
  for (const row of rows.slice(after + 1)) {
    if (row.kind === "placeholder")
      return { kind: "ordinal", ordinal: row.ordinal };
    if (viewerId !== null && row.model.senderUserId === viewerId) continue;
    if (row.model.persistentMessageId !== null) {
      return {
        kind: "row",
        rowId: row.model.id,
        messageId: row.model.persistentMessageId,
      };
    }
  }
  return { kind: "none" };
}

function useBoundaryTarget(args: {
  readonly identity: string;
  readonly boundary: UnreadBoundary | null;
  readonly rows: readonly TranscriptListRow[];
  readonly viewerId: string | null;
}): BoundaryTarget {
  const { identity, boundary, rows, viewerId } = args;
  const [held, setHeld] = useState<{
    readonly identity: string;
    readonly boundary: UnreadBoundary;
    readonly target: Extract<BoundaryTarget, { kind: "row" }>;
  } | null>(null);
  const current =
    held !== null &&
    held.identity === identity &&
    boundary !== null &&
    held.boundary.afterMessageId === boundary.afterMessageId;
  const target = useMemo(() => {
    if (current) {
      const row =
        rows.find(
          (item) =>
            item.kind === "hydrated" && item.model.id === held.target.rowId,
        ) ?? rows.find((item) => carries(item, held.target.messageId));
      if (row === undefined || row.kind !== "hydrated")
        return { kind: "locate" as const, messageId: held.target.messageId };
      return row.model.id === held.target.rowId
        ? held.target
        : { ...held.target, rowId: row.model.id };
    }
    return boundaryTarget(rows, boundary, viewerId);
  }, [boundary, current, held, rows, viewerId]);
  if (!current && held !== null) setHeld(null);
  if (!current && boundary !== null && target.kind === "row")
    setHeld({ identity, boundary, target });
  return target;
}

interface BoundaryIntent {
  readonly key: string | null;
  readonly epoch: string;
  readonly pending: boolean;
  readonly automatic: boolean;
  readonly landing: BotUnreadLanding | null;
}

/** Settle only the current visit's intent; explicit navigation wins over opening. */
function resolvedBoundaryIntent(
  intent: BoundaryIntent,
  state: {
    readonly current: boolean;
    readonly pending: boolean;
    readonly ready: boolean;
    readonly automatic: boolean;
  },
  target: BoundaryTarget,
  locationMissing: boolean,
): BoundaryIntent {
  if (state.current && intent.automatic && intent.pending && !state.automatic) {
    return { ...intent, pending: false, landing: null };
  }
  if (!state.pending || !state.ready) return intent;
  if (target.kind === "row") {
    return {
      ...intent,
      pending: false,
      landing: { kind: "boundary", rowId: target.rowId },
    };
  }
  if (target.kind === "none" || locationMissing)
    return { ...intent, pending: false, landing: null };
  return intent;
}

/** Hydration may continue a boundary intent; a later explicit navigation retires it. */
function useBotBoundaryNavigation(args: {
  readonly identity: string;
  readonly active: boolean;
  readonly ready: boolean;
  readonly boundary: UnreadBoundary | null;
  readonly rows: readonly TranscriptListRow[];
  readonly viewerId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly conversationId: string;
  readonly epoch: string;
  readonly windowEpoch: number;
  readonly automatic: boolean;
  readonly onNavigate: (landing: BotUnreadLanding) => void;
}): {
  readonly rowId: string | null;
  readonly navigate: () => void;
  readonly cancelNavigation: () => void;
} {
  const {
    identity,
    active,
    ready,
    boundary,
    rows,
    viewerId,
    client,
    botId,
    conversationId,
    epoch,
    windowEpoch,
    automatic,
    onNavigate,
  } = args;
  const key = active ? identity : null;
  const [intent, setIntent] = useState<BoundaryIntent>({
    key,
    epoch,
    pending: automatic,
    automatic,
    landing: null,
  });
  const current = intent.key === key && intent.epoch === epoch;
  if (!current)
    setIntent({
      key,
      epoch,
      pending: intent.key !== key && automatic,
      automatic,
      landing: null,
    });
  const pending =
    current && active && intent.pending && (!intent.automatic || automatic);
  const target = useBoundaryTarget({ identity, boundary, rows, viewerId });
  const locator = useMemo(
    () =>
      pending && target.kind === "locate"
        ? { kind: "message" as const, messageId: target.messageId }
        : null,
    [pending, target],
  );
  const located = useChatLocateRowAnswer({
    client,
    epicId: botId,
    chatId: conversationId,
    target: locator,
    epoch: windowEpoch,
  });
  const locatedOrdinal = located.status === "found" ? located.ordinal : null;
  const locationMissing = located.status === "missing";
  const navigate = useCallback(
    () =>
      setIntent({ key, epoch, pending: true, automatic: false, landing: null }),
    [epoch, key],
  );
  const cancelNavigation = useCallback(() => {
    setIntent((previous) =>
      previous.pending || previous.landing !== null
        ? { ...previous, pending: false, landing: null }
        : previous,
    );
  }, []);
  // Retire hydration during render, and publish the resulting external scroll
  // intent after commit. A later reader action can cancel either phase.
  const resolved = resolvedBoundaryIntent(
    intent,
    { current, pending, ready, automatic },
    target,
    locationMissing,
  );
  if (resolved !== intent) setIntent(resolved);
  const landing = current ? intent.landing : null;
  const issued = useRef<BotUnreadLanding | null>(null);
  useEffect(() => {
    if (landing !== null) {
      if (issued.current === landing) return;
      issued.current = landing;
      onNavigate(landing);
    } else if (pending && ready && target.kind === "ordinal") {
      onNavigate(target);
    } else if (pending && ready && locatedOrdinal !== null) {
      onNavigate({ kind: "ordinal", ordinal: locatedOrdinal });
    } else if (!pending) {
      onNavigate({ kind: "ordinal", ordinal: null });
    }
  }, [landing, locatedOrdinal, onNavigate, pending, ready, target]);

  return {
    rowId: active && target.kind === "row" ? target.rowId : null,
    navigate,
    cancelNavigation,
  };
}

interface BotBoundaryNavigationResult {
  readonly rowId: string | null;
  readonly navigate: () => void;
  readonly cancelNavigation: () => void;
}

export function useBotTranscriptBoundary(
  props: {
    readonly botId: string;
    readonly conversationId: string;
    readonly enabled: boolean;
    readonly unread: BotTranscriptUnread | null | undefined;
    readonly rows: readonly TranscriptListRow[];
    readonly epoch: string;
    readonly windowEpoch: number;
    readonly automaticBoundary: boolean;
    readonly onNavigate: (landing: BotUnreadLanding) => void;
  },
  read: BotReadCursorReadResponse | undefined,
  client: HostClient<HostRpcRegistry> | null,
): BotBoundaryNavigationResult {
  const paneVisible = usePaneVisible();
  const viewerId = useCloudChatViewerId();
  const lifetime = useBotLifetime();
  const identity = `${lifetime}:${viewerId}:${props.botId}:${props.conversationId}`;
  const visitPresent = useContext(BotVisitPresenceContext);
  const active = visitPresent && paneVisible;
  const ownBoundary = useBotUnreadBoundary({
    identity,
    active: active && props.unread === undefined,
    read,
    conversationId: props.conversationId,
  });
  const boundary = props.unread === undefined ? ownBoundary : props.unread;
  return useBotBoundaryNavigation({
    identity,
    active,
    ready: props.enabled && read !== undefined,
    boundary,
    rows: props.rows,
    viewerId,
    client,
    botId: props.botId,
    conversationId: props.conversationId,
    epoch: props.epoch,
    windowEpoch: props.windowEpoch,
    automatic: props.automaticBoundary,
    onNavigate: props.onNavigate,
  });
}
