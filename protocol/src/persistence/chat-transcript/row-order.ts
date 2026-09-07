import {
  chatImportedMetadataSchema,
  type ChatEvent,
  type ChatImportedMetadata,
} from "@traycer/protocol/persistence/epic/chat-events";


/** The row's sort key. */
export interface CanonicalRowOrderKey {
  readonly createdAt: number;
}

/**
 * Compares two rows by canonical order.
 * Do not "improve" this by breaking ties on id: that would reorder existing transcripts, because the input order it would displace is the projection's insert order, which is meaningful.
 */
export function compareCanonicalRowOrder(
  a: CanonicalRowOrderKey,
  b: CanonicalRowOrderKey,
): number {
  return a.createdAt - b.createdAt;
}

/** Sorts into canonical order without mutating the input. */
export function sortIntoCanonicalRowOrder<T>(
  rows: readonly T[],
  keyOf: (row: T) => CanonicalRowOrderKey,
): readonly T[] {
  return [...rows].sort((a, b) => compareCanonicalRowOrder(keyOf(a), keyOf(b)));
}

/**
 * A metadata value the renderer would accept as present.
 * A predicate that accepted it would materialize a row the renderer does not draw, and every ordinal after that event would be off by one - bodies under the wrong rows, silently, for the rest of the transcript.
 */
function renderableMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

/** The origin a forked-chat link row points at. */
export interface ForkedChatLinkRowSource {
  readonly sourceChatId: string;
  readonly sourceHostId: string;
  /** The source chat's title as captured at fork time, or `null` when the event carried none. */
  readonly sourceChatTitle: string | null;
}

/** The forked-chat link row's source, or `null` when this event draws no row. */
export function forkedChatLinkRowSource(
  event: ChatEvent,
): ForkedChatLinkRowSource | null {
  if (event.type !== "chat.forked") return null;
  const metadata = event.metadata;
  if (metadata === null) return null;
  const sourceChatId = renderableMetadataString(metadata, "sourceChatId");
  const sourceHostId = renderableMetadataString(metadata, "sourceHostId");
  if (sourceChatId === null || sourceHostId === null) return null;
  return {
    sourceChatId,
    sourceHostId,
    sourceChatTitle: renderableMetadataString(metadata, "sourceChatTitle"),
  };
}

/** What a notification-anchor error row renders. */
export interface NotificationAnchorRowSource {
  readonly message: string;
  /** Provider error code, when the event carried one. */
  readonly code: string | null;
}

/** The notification-anchor error row's content, or `null` when this event draws no row. */
export function notificationAnchorRowSource(
  event: ChatEvent,
): NotificationAnchorRowSource | null {
  if (event.type !== "send.failed") return null;
  const metadata = event.metadata;
  if (metadata === null) return null;
  if (metadata.notificationAnchor !== true) return null;
  if (event.message === null) return null;
  return {
    message: event.message,
    code: renderableMetadataString(metadata, "code"),
  };
}

/**
 * The imported-chat provenance row's content, or `null` when this event draws no row.
 * Parsed through the metadata schema rather than read field by field: the bag is untyped on the wire, and a half-written one must produce no row at all rather than a row that says "Imported from undefined".
 */
export function importedChatMarkerRowSource(
  event: ChatEvent,
): ChatImportedMetadata | null {
  if (event.type !== "chat.imported") return null;
  const parsed = chatImportedMetadataSchema.safeParse(event.metadata);
  return parsed.success ? parsed.data : null;
}

export function eventMaterializesTranscriptRow(event: ChatEvent): boolean {
  return (
    forkedChatLinkRowSource(event) !== null ||
    notificationAnchorRowSource(event) !== null ||
    importedChatMarkerRowSource(event) !== null
  );
}
