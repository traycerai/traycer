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
  retainInvalidField(merged, cached, read.invalidFields, "color");
  retainInvalidField(merged, cached, read.invalidFields, "icon");
  return { ...read, appearance: merged };
}

function retainInvalidField(
  appearance: WorkspaceAppearance,
  cached: WorkspaceAppearance | null,
  invalidFields: readonly ("color" | "icon")[],
  field: "color" | "icon",
): void {
  if (!invalidFields.includes(field)) return;
  if (field === "color") {
    const previous = cached?.color;
    if (appearance.color === undefined && previous !== undefined)
      appearance.color = previous;
    return;
  }
  const previous = cached?.icon;
  if (appearance.icon === undefined && previous !== undefined)
    appearance.icon = previous;
}
