const ILLEGAL_CHARACTERS_PATTERN = /[~^:?*[\\]/;
// Intentional: matches git's own "no ASCII control characters" ref-name rule
// (bytes below 0x20, plus DEL).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_PATTERN = /[\x00-\x1f\x7f]/;

// The composed branch name is `${prefix}${suffix}` (single workspace) or
// `${prefix}${repoSlug}-${suffix}` (multi-workspace), sliced to 80 chars. The
// prefix is capped at 40 chars below, but `repoSlug` (`slugify-branch-seed.ts`)
// is ALSO capped at 40 chars - a max-length prefix plus a max-length slug
// already exceeds 80 on its own, so the slice can land inside the repo-slug
// material, not just the random suffix. That is still safe: both the repo
// slug and the suffix (`random-friendly-name.ts`) are ASCII-sanitized to
// `[a-z0-9-]`, so every character reachable at the cutoff - suffix or repo
// slug - comes from that safe set. Truncation can therefore never cut a
// composed name down to an illegal or empty ref (a lone trailing `-` is a
// valid ref character), so no post-composition repair is needed.
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
  if (CONTROL_CHARACTERS_PATTERN.test(value)) {
    return "Prefix can't contain control characters.";
  }
  if (ILLEGAL_CHARACTERS_PATTERN.test(value)) {
    return "Prefix can't contain ~ ^ : ? * [ or \\.";
  }
  if (value.includes("..")) return 'Prefix can\'t contain "..".';
  if (value.includes("@{")) return 'Prefix can\'t contain "@{".';
  if (value.startsWith("-")) return 'Prefix can\'t start with "-".';
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
