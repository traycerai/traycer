import { parseHttpUrl } from "@/lib/browser-view/browser-tab-display";

/**
 * The identity two URLs share when they name the same page (B4): host + path +
 * query, with the scheme, hash and a trailing slash ignored. `null` for
 * anything that is not http(s) - those never open in a browser tile at all.
 *
 * Scheme-insensitive on purpose: a site that upgrades `http://` to `https://`
 * (most do) commits the tab under the upgraded scheme, so keying on the scheme
 * would mint a fresh tab on every click of the original `http://` link instead
 * of focusing the one already open.
 *
 * Credentials are still part of the identity: `origin` drops the user-info, so
 * without this two URLs authenticating as different users would share a tab.
 */
export function samePageKey(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (parsed === null) return null;
  const path = parsed.pathname.replace(/\/$/, "");
  const password = parsed.password.length > 0 ? `:${parsed.password}` : "";
  const userInfo =
    parsed.username.length > 0 || parsed.password.length > 0
      ? `${parsed.username}${password}@`
      : "";
  return `${userInfo}${parsed.host}${path}${parsed.search}`;
}

/** The fragment, `""` when there is none (or the URL is not http(s)). */
export function hashOf(url: string): string {
  return parseHttpUrl(url)?.hash ?? "";
}
