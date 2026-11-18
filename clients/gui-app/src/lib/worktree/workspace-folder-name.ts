/**
 * Derive a short folder name from a workspace path for display/labels.
 * Falls back to the full path when no separator is present.
 */
export function workspaceFolderName(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/, "");
  const lastSlash = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  if (lastSlash < 0) return trimmed.length > 0 ? trimmed : workspacePath;
  return trimmed.slice(lastSlash + 1) || workspacePath;
}
