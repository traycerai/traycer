/**
 * Resolve directory documents before either navigation or file requests are
 * admitted. Takes the path as the URL wrote it: `URL.pathname` has already
 * removed dot segments, and those must be refused, not resolved.
 */
export function normalizeSandboxArtifactRawPath(
  rawPath: string,
): string | null {
  try {
    let path = decodeURIComponent(rawPath).replace(/^\//, "");
    if (path === "" || path.endsWith("/")) path += "index.html";
    if (
      path.includes("..") ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "")
    )
      return null;
    return path;
  } catch {
    return null;
  }
}
