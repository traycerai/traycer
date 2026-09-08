/**
 * Patch cache key and diff theme name resolution for the Git Diff panel.
 */
import { registerCustomTheme, type DiffsThemeNames } from "@pierre/diffs";
import { getActiveSyntaxTheme } from "@/lib/themes/syntax-theme";
import { contentFingerprint } from "@/lib/text-hash";

/**
 * Builds a stable cache key for a diff patch: scope, plus a length-and-two-
 * seeded-hashes fingerprint of the patch (ADR-0002's shape). Whitespace is
 * normalized before hashing.
 *
 * The fingerprint itself lives in `@/lib/text-hash` so the codebase carries
 * ONE content-fingerprint family. Two independent schemes would mean two
 * collision-risk arguments to maintain and two places to fix if either is ever
 * found weak.
 */
export function buildPatchCacheKey(patch: string, scope: string): string {
  return `${scope}:${contentFingerprint(patch.trim())}`;
}

const registeredThemes = new Set<string>();

/** Registers imported TextMate rules once before the diff worker resolves them. */
export function resolveDiffThemeName(
  resolvedTheme: "light" | "dark",
): DiffsThemeNames {
  const custom = getActiveSyntaxTheme();
  if (custom?.name !== undefined) {
    if (!registeredThemes.has(custom.name)) {
      registerCustomTheme(custom.name, () => Promise.resolve(custom));
      registeredThemes.add(custom.name);
    }
    return custom.name;
  }
  return resolvedTheme === "dark" ? "pierre-dark" : "pierre-light";
}
