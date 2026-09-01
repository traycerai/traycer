import { parseHttpUrl } from "@/lib/browser-view/browser-tab-display";

/**
 * The identity two URLs share when they name the same page (B4): origin +
 * path + query, with the hash and a trailing slash ignored. `null` for
 * anything that is not http(s) - those never open in a browser tile at all.
 */
export function samePageKey(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null) return null;
  const path = parsed.pathname.replace(/\/$/, "");
  return `${parsed.origin}${path}${parsed.search}`;
}

/** The fragment, `""` when there is none (or the URL is not http(s)). */
export function hashOf(url: string): string {
  return parseHttpUrl(url)?.hash ?? "";
}
