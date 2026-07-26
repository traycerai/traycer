const ILLEGAL_CHARACTERS_PATTERN = /[~^:?*[\\]/;

// The composed branch name is `${prefix}${suffix}` (or
// `${prefix}${repoSlug}-${suffix}`), sliced to 80 chars; the suffix material
// is always `[a-z0-9-]` (see `random-friendly-name.ts` / `slugify-branch-seed.ts`).
// Capping the prefix here at less than half the 80-char budget guarantees the
// slice always lands inside that suffix material, so truncation can never cut
// a composed name down to an illegal or empty ref - no post-composition repair
// needed.
const MAX_LENGTH = 40;

/**
 * Light client-side check for the configurable worktree branch prefix -
 * catches values that would make an illegal git ref before they're saved.
 * Git remains the final authority at branch-creation time.
 */
export function worktreeBranchPrefixError(value: string): string | null {
  if (value.length > MAX_LENGTH) {
    return `Prefix is too long (max ${MAX_LENGTH} characters).`;
  }
  if (/\s/.test(value)) return "Prefix can't contain spaces.";
  if (ILLEGAL_CHARACTERS_PATTERN.test(value)) {
    return "Prefix can't contain ~ ^ : ? * [ or \\.";
  }
  if (value.includes("..")) return 'Prefix can\'t contain "..".';
  if (value.includes("@{")) return 'Prefix can\'t contain "@{".';
  if (value.startsWith("/")) return 'Prefix can\'t start with "/".';
  if (value.includes("//")) return "Prefix can't contain consecutive slashes.";
  for (const component of value.split("/")) {
    if (component.length === 0) continue;
    if (component.startsWith(".")) {
      return `Prefix component "${component}" can't start with ".".`;
    }
    if (component.endsWith(".lock")) {
      return `Prefix component "${component}" can't end with ".lock".`;
    }
  }
  return null;
}
