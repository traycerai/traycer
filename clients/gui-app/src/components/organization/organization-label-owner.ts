import type { LabelDefinition } from "@traycer/protocol/host/organization/schemas";
export function hasSharedLabelOwner(
  labels: readonly LabelDefinition[],
  userId: string | null,
): boolean {
  return labels.some(
    (label) => label.kind === "custom" && label.ownerId !== userId,
  );
}

export function labelOwnerName(
  label: LabelDefinition,
  userId: string | null,
): string {
  if (label.kind === "system") return "System";
  if (label.ownerId === userId) return "You";
  return `Shared · ${label.ownerId.slice(0, 8)}`;
}
