/**
 * Shared defaults for the `git.*` host RPC surface.
 *
 * These values are protocol-level contract defaults. Host implementations and
 * clients should import them instead of redefining local literals.
 */
export const DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET = 256 * 1024;
export const DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET = 1_048_576;
