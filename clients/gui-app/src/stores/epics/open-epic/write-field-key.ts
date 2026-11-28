import type { EpicWriteCommandIntent } from "./runtime/epic-write-command";

export type WriteField = "rename" | "status" | "reparent" | "epic-title";
export type OccupiedWriteFields = Readonly<Record<string, true | undefined>>;

export const EMPTY_OCCUPIED_WRITE_FIELDS: OccupiedWriteFields = Object.freeze(
  {},
);

export function writeFieldKey(
  field: WriteField,
  artifactId: string | null,
): string {
  return field === "epic-title" ? field : `${field}:${artifactId}`;
}

export function writeFieldKeyForIntent(
  intent: EpicWriteCommandIntent,
): string | null {
  switch (intent.kind) {
    case "update-epic-title":
      return writeFieldKey("epic-title", null);
    case "rename-artifact":
      return writeFieldKey("rename", intent.artifactId);
    case "update-artifact-status":
      return writeFieldKey("status", intent.artifactId);
    case "reparent-artifact":
      return writeFieldKey("reparent", intent.artifactId);
    case "delete-artifact":
      return null;
  }
}
