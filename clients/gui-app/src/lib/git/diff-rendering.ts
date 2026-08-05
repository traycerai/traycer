/**
 * Patch cache key and diff theme name resolution for the Git Diff panel.
 */
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

/**
 * Resolves a light/dark theme to a Pierre diff theme name.
 */
export function resolveDiffThemeName(
  resolvedTheme: "light" | "dark",
): "pierre-light" | "pierre-dark" {
  return resolvedTheme === "dark" ? "pierre-dark" : "pierre-light";
}
