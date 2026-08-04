export type ReadingPositionSurfaceKind =
  "native" | "bundle-diff" | "chat" | "managed-command" | "terminal";

export type ReadingPositionDurability = "durable" | "renderer-live";

/**
 * Dual identity for one reading surface. `viewKey` identifies the exact tile;
 * `contentKey` is the last-left fallback used only when that exact view has no
 * record. Renderer-live surfaces deliberately carry no content key.
 */
export interface ReadingPositionIdentity {
  readonly viewKey: string;
  readonly contentKey: string | null;
  readonly deletionKey: string | null;
  readonly epicId: string | null;
  readonly hostId: string | null;
  readonly durability: ReadingPositionDurability;
}

export type ReadingPositionAnchorValidator<T> = (
  anchor: unknown,
) => anchor is T;
