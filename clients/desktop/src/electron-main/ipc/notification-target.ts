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
 * Tile kinds a chat/approval/interview notification's `chatId` can resolve
 * to. `chat`/`terminal-agent` per `isChatArtifactTileType` in gui-app's
 * `notifications/payload.ts`; `terminal` too, because
 * `routeEpicChatNotification` there tries `routeLegacyTerminalNotification`
 * first - a legacy shape where `chatId` is actually a raw terminal id,
 * matched against `type === "terminal"` tiles - before falling back to the
 * chat-artifact lookup.
 */
const CHAT_TILE_TYPES = new Set(["chat", "terminal-agent", "terminal"]);

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

/**
 * Route kinds that resolve to a chat/terminal-agent tile via `chatId`.
 * `approval` and `interview` both route through the renderer's
 * `routeEpicChatNotification` exactly like `chat` (see `routeNotification` in
 * gui-app's `notifications/payload.ts`), so they need the same chat-tile
 * targeting.
 */
const CHAT_TARGET_ROUTE_KINDS = new Set(["chat", "approval", "interview"]);

export interface NotificationClickTarget {
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly tabId: string | null;
  readonly artifactId: string | null;
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
 * Reads `epicId` off a recognized-kind route object, plus whichever of
 * `chatId` (chat/approval/interview), `tabId` (terminal), or `artifactId`
 * (artifact) identifies the exact tile/tab for that route kind. An
 * unrecognized `kind` (a future route shape, or a stray envelope-shaped
 * object) never yields fields - the renderer's own `parseNotificationPayload`
 * switch has the same closed set of cases. `session` routes carry no
 * `epicId` in their schema (`isNotificationPayloadRoutable` never routes
 * them), so they always yield null fields. `epic` routes have no exact-tile
 * identity to target, so they always yield null fields and fall back to
 * owned-or-MRU.
 */
function readRouteFields(route: unknown): {
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly tabId: string | null;
  readonly artifactId: string | null;
} {
  const allNullFields = { chatId: null, tabId: null, artifactId: null };
  if (!isRecord(route)) return { epicId: null, ...allNullFields };
  if (typeof route.kind !== "string" || !KNOWN_ROUTE_KINDS.has(route.kind)) {
    return { epicId: null, ...allNullFields };
  }
  if (route.kind === "session") {
    return { epicId: null, ...allNullFields };
  }
  const epicId = readString(route.epicId);
  if (route.kind === "terminal") {
    return {
      epicId,
      chatId: null,
      tabId: readString(route.tabId),
      artifactId: null,
    };
  }
  if (route.kind === "artifact") {
    return {
      epicId,
      chatId: null,
      tabId: null,
      artifactId: readString(route.artifactId),
    };
  }
  if (!CHAT_TARGET_ROUTE_KINDS.has(route.kind)) {
    return { epicId, ...allNullFields };
  }
  return {
    epicId,
    chatId: readString(route.chatId),
    tabId: null,
    artifactId: null,
  };
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
const ALL_NULL_TARGET: NotificationClickTarget = {
  epicId: null,
  chatId: null,
  tabId: null,
  artifactId: null,
  originHostId: null,
};

export function parseNotificationClickTarget(
  payload: unknown,
): NotificationClickTarget {
  if (!isRecord(payload)) {
    return ALL_NULL_TARGET;
  }
  if (payload.kind === ACTIVATION_ENVELOPE_KIND) {
    const originHostId = payload.originHostId;
    if (
      payload.version !== ACTIVATION_ENVELOPE_VERSION ||
      !isValidFeed(payload.feed) ||
      !isValidOriginHostId(originHostId)
    ) {
      return ALL_NULL_TARGET;
    }
    const { epicId, chatId, tabId, artifactId } = readRouteFields(
      payload.route,
    );
    return { epicId, chatId, tabId, artifactId, originHostId };
  }
  const { epicId, chatId, tabId, artifactId } = readRouteFields(payload);
  return { epicId, chatId, tabId, artifactId, originHostId: null };
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
 * notification's content id and, when the notification carries one, its
 * origin host - tabs bind a host for life (root AGENTS.md), so a tile whose
 * persisted `hostId` disagrees with the notification's origin is never a
 * match even if the content id lines up. `allowedTypes` narrows further to a
 * specific tile-type set (chat targeting); `null` accepts any tile type
 * (artifact targeting, mirroring gui-app's type-agnostic
 * `findOpenArtifactInTab`).
 */
function tileMatchesContent(
  tile: JsonValue,
  contentId: string,
  originHostId: string | null,
  allowedTypes: ReadonlySet<string> | null,
): boolean {
  if (!isJsonRecord(tile)) return false;
  if (tile.id !== contentId) return false;
  if (
    allowedTypes !== null &&
    (typeof tile.type !== "string" || !allowedTypes.has(tile.type))
  ) {
    return false;
  }
  if (originHostId !== null && tile.hostId !== originHostId) return false;
  return true;
}

function canvasHasMatchingTile(
  canvas: JsonValue | undefined,
  contentId: string,
  originHostId: string | null,
  allowedTypes: ReadonlySet<string> | null,
): boolean {
  if (!isJsonRecord(canvas)) return false;
  const tiles = canvas.tilesByInstanceId;
  if (!isJsonRecord(tiles)) return false;
  return Object.values(tiles).some((tile) =>
    tileMatchesContent(tile, contentId, originHostId, allowedTypes),
  );
}

function findWindowIdForOpenContent(
  windowRegistry: NotificationTargetWindowRegistry,
  perWindowState: NotificationTargetPerWindowState,
  epicId: string,
  contentId: string,
  originHostId: string | null,
  allowedTypes: ReadonlySet<string> | null,
): string | null {
  for (const record of windowRegistry.records()) {
    const snapshot = perWindowState.get(record.windowId);
    const matchingTabIds = snapshot.epicTabs
      .filter((tab) => tab.epicId === epicId)
      .map((tab) => tab.id);
    const hasMatch = matchingTabIds.some((tabId) =>
      canvasHasMatchingTile(
        snapshot.canvasByTabId[tabId],
        contentId,
        originHostId,
        allowedTypes,
      ),
    );
    if (hasMatch) return record.windowId;
  }
  return null;
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
  return findWindowIdForOpenContent(
    windowRegistry,
    perWindowState,
    epicId,
    chatId,
    originHostId,
    CHAT_TILE_TYPES,
  );
}

/**
 * Scans every live window's per-window snapshot for the epic tab that holds
 * this artifact tile, regardless of tile type - mirrors gui-app's
 * type-agnostic `findOpenArtifactInTab` (an `artifact` notification's target
 * can be any artifact-tile kind: chat, spec, workspace-file, git-diff, etc).
 * Returns the first matching windowId, or null when the artifact is not open
 * anywhere - the caller falls back to owned-or-MRU delivery in that case.
 */
export function findWindowIdForOpenArtifact(
  windowRegistry: NotificationTargetWindowRegistry,
  perWindowState: NotificationTargetPerWindowState,
  epicId: string,
  artifactId: string,
  originHostId: string | null,
): string | null {
  return findWindowIdForOpenContent(
    windowRegistry,
    perWindowState,
    epicId,
    artifactId,
    originHostId,
    null,
  );
}

/**
 * Scans every live window's per-window snapshot for the exact epic tab a
 * terminal notification names (`route.tabId`). Terminal routes carry a tab
 * identity directly rather than a chat-tile id (see `routeTerminalNotification`
 * in gui-app's `notifications/payload.ts`), so this matches on `epicTabs`
 * instead of scanning canvas tiles. Returns the first matching windowId, or
 * null when that tab is not open anywhere - the caller falls back to
 * owned-or-MRU delivery in that case.
 */
export function findWindowIdForOpenTab(
  windowRegistry: NotificationTargetWindowRegistry,
  perWindowState: NotificationTargetPerWindowState,
  epicId: string,
  tabId: string,
): string | null {
  for (const record of windowRegistry.records()) {
    const snapshot = perWindowState.get(record.windowId);
    const hasMatch = snapshot.epicTabs.some(
      (tab) => tab.id === tabId && tab.epicId === epicId,
    );
    if (hasMatch) return record.windowId;
  }
  return null;
}
