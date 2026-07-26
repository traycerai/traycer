/**
 * Selects the Electron main-process delivery target for a native-notification
 * click: the window that already has the notification's chat tile open, when
 * there is one. `deliverNotificationClick` falls back to owned-or-MRU
 * delivery whenever this reports no match.
 *
 * Understands two click-payload shapes (mirrors the gui-app parsers in
 * `notification-activation-envelope.ts` / `notifications/payload.ts`, which
 * main cannot import - that code is browser-only):
 *  - the V1 activation envelope: `{kind: "notificationActivation", version: 1,
 *    route, feed, originHostId}`, where `route` is a `NotificationPayload`;
 *  - a legacy raw route payload: the `NotificationPayload` itself, unwrapped.
 *
 * Every narrowing step fails closed: a structural mismatch anywhere (missing
 * field, wrong type, unrecognized kind) yields no match rather than guessing,
 * so a malformed or future-shaped payload can never mis-route a click - it
 * just falls through to the existing owned-or-MRU behavior.
 */
import type {
  JsonValue,
  PerWindowSnapshot,
} from "../../ipc-contracts/window-types";

const ACTIVATION_ENVELOPE_KIND = "notificationActivation";
const ACTIVATION_ENVELOPE_VERSION = 1;

/**
 * Tile kinds a chat notification can resolve to. `terminal-agent` is the
 * legacy/alternate tile type for the same chat content - see
 * `isChatArtifactTileType` in gui-app's `notifications/payload.ts`.
 */
const CHAT_TILE_TYPES = new Set(["chat", "terminal-agent"]);

/** Mirrors `NotificationPayloadKind` in gui-app's `notifications/payload.ts`. */
const KNOWN_ROUTE_KINDS = new Set([
  "session",
  "artifact",
  "epic",
  "approval",
  "interview",
  "chat",
  "terminal",
]);

/** Mirrors `NotificationActivationEnvelopeFeedSource` in gui-app's
 * `notification-activation-envelope.ts`. */
const KNOWN_FEED_SOURCES = new Set(["host", "app-local", "global"]);

export interface NotificationClickTarget {
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly originHostId: string | null;
}

/** Structural subset of `IpcWindowRegistry` this module needs. */
export interface NotificationTargetWindowRegistry {
  records(): ReadonlyArray<{ readonly windowId: string }>;
}

/** Structural subset of `IpcPerWindowState` this module needs. */
export interface NotificationTargetPerWindowState {
  get(windowId: string): PerWindowSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Non-empty-string check, matching the renderer's own `readString`. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isValidOriginHostId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Mirrors `parseEnvelopeFeed` in gui-app's `notification-activation-envelope.ts`. */
function isValidFeed(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.source !== "string" ||
    !KNOWN_FEED_SOURCES.has(value.source)
  ) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

/**
 * Reads `epicId` off a recognized-kind route object, and `chatId` too when
 * the route is chat-kind. An unrecognized `kind` (a future route shape, or a
 * stray envelope-shaped object) never yields fields - the renderer's own
 * `parseNotificationPayload` switch has the same closed set of cases.
 * `session` routes carry no `epicId` in their schema (`isNotificationPayloadRoutable`
 * never routes them), so they always yield null fields.
 */
function readRouteFields(route: unknown): {
  readonly epicId: string | null;
  readonly chatId: string | null;
} {
  if (!isRecord(route)) return { epicId: null, chatId: null };
  if (typeof route.kind !== "string" || !KNOWN_ROUTE_KINDS.has(route.kind)) {
    return { epicId: null, chatId: null };
  }
  if (route.kind === "session") return { epicId: null, chatId: null };
  const epicId = readString(route.epicId);
  if (route.kind !== "chat") return { epicId, chatId: null };
  return { epicId, chatId: readString(route.chatId) };
}

/**
 * Parses a native-notification click payload into the fields main needs to
 * pick a delivery target: accepts the V1 envelope first, falls back to a
 * legacy raw route payload, and reports all-null fields for anything else.
 *
 * An object identifying itself as an activation envelope (`kind ===
 * "notificationActivation"`) is treated as envelope-exclusive: it is never
 * reinterpreted as a legacy route, even when its version/feed/originHostId/
 * route don't validate - a hypothetical future-version envelope must not
 * leak a top-level `epicId` through the legacy path.
 */
export function parseNotificationClickTarget(
  payload: unknown,
): NotificationClickTarget {
  if (!isRecord(payload)) {
    return { epicId: null, chatId: null, originHostId: null };
  }
  if (payload.kind === ACTIVATION_ENVELOPE_KIND) {
    const originHostId = payload.originHostId;
    if (
      payload.version !== ACTIVATION_ENVELOPE_VERSION ||
      !isValidFeed(payload.feed) ||
      !isValidOriginHostId(originHostId)
    ) {
      return { epicId: null, chatId: null, originHostId: null };
    }
    const { epicId, chatId } = readRouteFields(payload.route);
    return { epicId, chatId, originHostId };
  }
  const { epicId, chatId } = readRouteFields(payload);
  return { epicId, chatId, originHostId: null };
}

function isJsonRecord(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * Matches a single opaque serialized tile ref (see gui-app's
 * `tile-schema/index.ts` / `types.ts` `EpicArtifactRef`) against the
 * notification's chat id and, when the notification carries one, its origin
 * host - tabs bind a host for life (root AGENTS.md), so a tile whose
 * persisted `hostId` disagrees with the notification's origin is never a
 * match even if the content id lines up.
 */
function tileMatchesChat(
  tile: JsonValue,
  chatId: string,
  originHostId: string | null,
): boolean {
  if (!isJsonRecord(tile)) return false;
  if (tile.id !== chatId) return false;
  if (typeof tile.type !== "string" || !CHAT_TILE_TYPES.has(tile.type)) {
    return false;
  }
  if (originHostId !== null && tile.hostId !== originHostId) return false;
  return true;
}

function canvasHasChatTile(
  canvas: JsonValue | undefined,
  chatId: string,
  originHostId: string | null,
): boolean {
  if (!isJsonRecord(canvas)) return false;
  const tiles = canvas.tilesByInstanceId;
  if (!isJsonRecord(tiles)) return false;
  return Object.values(tiles).some((tile) =>
    tileMatchesChat(tile, chatId, originHostId),
  );
}

/**
 * Scans every live window's per-window snapshot for the epic tab that holds
 * this chat/terminal-agent tile. Returns the first matching windowId, or
 * null when the chat is not open anywhere - the caller falls back to
 * owned-or-MRU delivery in that case.
 */
export function findWindowIdForOpenChat(
  windowRegistry: NotificationTargetWindowRegistry,
  perWindowState: NotificationTargetPerWindowState,
  epicId: string,
  chatId: string,
  originHostId: string | null,
): string | null {
  for (const record of windowRegistry.records()) {
    const snapshot = perWindowState.get(record.windowId);
    const matchingTabIds = snapshot.epicTabs
      .filter((tab) => tab.epicId === epicId)
      .map((tab) => tab.id);
    const hasMatch = matchingTabIds.some((tabId) =>
      canvasHasChatTile(snapshot.canvasByTabId[tabId], chatId, originHostId),
    );
    if (hasMatch) return record.windowId;
  }
  return null;
}
