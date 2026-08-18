import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";

export function nextActiveProfileIdAfterDelete(input: {
  readonly profiles: ReadonlyArray<Pick<ProjectProfile, "id">>;
  readonly activeProfileId: string | null;
  readonly deletedProfileId: string;
}): string | null {
  const remaining = input.profiles.filter(
    (profile) => profile.id !== input.deletedProfileId,
  );
  if (remaining.length === 0) return null;
  if (
    input.activeProfileId !== null &&
    input.activeProfileId !== input.deletedProfileId &&
    remaining.some((profile) => profile.id === input.activeProfileId)
  ) {
    return input.activeProfileId;
  }
  const deletedIndex = input.profiles.findIndex(
    (profile) => profile.id === input.deletedProfileId,
  );
  const nextByIndex =
    deletedIndex >= 0 && deletedIndex < remaining.length
      ? remaining[deletedIndex]
      : undefined;
  if (nextByIndex !== undefined) return nextByIndex.id;
  const last = remaining[remaining.length - 1];
  return last === undefined ? null : last.id;
}
