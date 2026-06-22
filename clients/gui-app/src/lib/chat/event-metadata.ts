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
