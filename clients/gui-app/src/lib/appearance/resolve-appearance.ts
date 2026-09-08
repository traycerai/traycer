import type {
  WorkspaceAppearance,
  WorkspaceAppearanceRead,
} from "@traycer/protocol/host/workspace/appearance-schemas";

export function mergeAppearanceRead(
  read: WorkspaceAppearanceRead,
  previous: WorkspaceAppearanceRead | null,
): WorkspaceAppearanceRead {
  const cached =
    read.canonicalSourceRoot !== null &&
    read.canonicalSourceRoot === previous?.canonicalSourceRoot
      ? previous.appearance
      : null;
  if (read.status === "absent" || read.status === "non-git")
    return { ...read, appearance: null };
  const appearance = read.appearance;
  if (
    (read.status !== "present" && read.status !== "malformed") ||
    appearance === null
  )
    return { ...read, appearance: cached };
  const merged = { ...appearance };
  retainInvalidField(merged, cached, read.issues, "color");
  retainInvalidField(merged, cached, read.issues, "icon");
  retainInvalidField(merged, cached, read.issues, "wallpaper");
  return { ...read, appearance: merged };
}

function retainInvalidField<Key extends "color" | "icon" | "wallpaper">(
  appearance: WorkspaceAppearance,
  cached: WorkspaceAppearance | null,
  issues: readonly string[],
  field: Key,
): void {
  const previous = cached?.[field];
  if (
    issues.includes(field) &&
    appearance[field] === undefined &&
    previous !== undefined
  )
    appearance[field] = previous;
}
