/**
 * Lower-case ASCII slug. Used by the create-worktree modal to derive a repo
 * prefix (from the repo / folder name) that disambiguates default branch names
 * when several git workspaces are created at once - e.g. `traycer/api-swift-otter`.
 */
export function slugifyBranchSeed(value: string | null): string {
  if (value === null) return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 40);
}
