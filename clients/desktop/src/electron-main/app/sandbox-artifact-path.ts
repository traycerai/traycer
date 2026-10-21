/** Resolve directory documents before either navigation or file requests are admitted. */
export function normalizeSandboxArtifactPath(url: string): string | null {
  try {
    // URL.pathname has already removed dot segments, so guard the supplied path.
    const rawPath = /^[^:]+:\/\/[^/?#]+([^?#]*)/.exec(url)?.[1];
    if (rawPath === undefined) return null;
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
