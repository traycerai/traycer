/** Resolve only within this canvas's root, never across artifacts or schemes. */
export function resolveCanvasBoardLink(
  fromPath: string,
  href: string,
  boardPaths: readonly string[],
): string | null {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(href) ||
    href.startsWith("/") ||
    href.includes("\\")
  )
    return null;
  const path = href.split(/[?#]/, 1)[0];
  if (path === "") return null;
  const segments = fromPath.split("/").slice(0, -1);
  for (const encoded of path.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    )
      return null;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(segment);
  }
  const target = segments.join("/");
  return boardPaths.includes(target) ? target : null;
}
