import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";

export function readMetadataString(
  event: ChatEvent,
  key: string,
): string | null {
  const metadata = event.metadata;
  if (metadata === null) return null;
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

export function readMetadataNumber(
  event: ChatEvent,
  key: string,
): number | null {
  const metadata = event.metadata;
  if (metadata === null) return null;
  const value = metadata[key];
  return typeof value === "number" ? value : null;
}

/**
 * Raw metadata value for structured payloads (objects the caller validates
 * with a schema - e.g. the `folderIntent` a `setup.failed` event carries).
 * Returns `undefined` when the event has no metadata or the key is absent.
 */
export function readMetadataValue(event: ChatEvent, key: string): unknown {
  const metadata = event.metadata;
  if (metadata === null) return undefined;
  return metadata[key];
}
