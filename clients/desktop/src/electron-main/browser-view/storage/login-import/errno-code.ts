/**
 * The `code` of a Node errno-shaped error (`ENOENT`, `EPERM`, ...), or `null`.
 * The import classifies failures by this and nothing else: the message beside
 * it names a path, and a path under a browser profile is not for the log.
 */
export function errnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
