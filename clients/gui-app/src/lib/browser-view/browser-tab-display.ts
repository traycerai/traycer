import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";

export const BROWSER_TAB_AGENT_ACTIVITY_MS = 400;

export interface SettledTabIdentity {
  readonly title: string;
  readonly url: string;
  readonly faviconUrl: string | null;
  readonly hasDocumentTitle: boolean;
}

/**
 * Every browser-tab reference surface (sidebar rows, chat chips) resolves the
 * same title-fallback chain, so it lives here once instead of drifting.
 */
export function resolveTabTitle(tab: BrowserTabInfo): string {
  const title = documentTitle(tab.title);
  if (title !== null) return title;
  const host = browserTabHostname(tab.url);
  return host ?? "Browser";
}

export function browserTabHostname(url: string): string | null {
  const hostname = parseBrowserUrl(url)?.hostname ?? "";
  return hostname.length > 0 ? hostname : null;
}

export function browserTabFaviconUrl(url: string): string | null {
  const parsed = parseHttpUrl(url);
  return parsed === null
    ? null
    : new URL("/favicon.ico", parsed.origin).toString();
}

export function browserTabOrigin(url: string): string | null {
  return parseHttpUrl(url)?.origin ?? null;
}

function isTransientBrowserTabStatus(
  status: BrowserTabInfo["status"],
): boolean {
  return status === "provisioning" || status === "navigating";
}

export function nextSettledTabIdentity(
  previous: SettledTabIdentity | null,
  tab: BrowserTabInfo,
): SettledTabIdentity {
  if (isTransientBrowserTabStatus(tab.status)) {
    if (previous === null) {
      return {
        title: "Browser",
        url: tab.url,
        faviconUrl: null,
        hasDocumentTitle: false,
      };
    }
    return previous;
  }
  const title = meaningfulDocumentTitle(tab.title, tab.url);
  if (title !== null) {
    return {
      title,
      url: tab.url,
      faviconUrl: browserTabFaviconUrl(tab.url),
      hasDocumentTitle: true,
    };
  }
  if (
    previous !== null &&
    previous.hasDocumentTitle &&
    browserTabOrigin(previous.url) !== null &&
    browserTabOrigin(previous.url) === browserTabOrigin(tab.url)
  ) {
    return previous;
  }
  return {
    title: browserTabHostname(tab.url) ?? "Browser",
    url: tab.url,
    faviconUrl: browserTabFaviconUrl(tab.url),
    hasDocumentTitle: false,
  };
}

export interface BrowserTabLabelRow {
  readonly key: string;
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
}

const TAB_ID_SUFFIX_LENGTH = 4;

/**
 * Sidebar secondary text: the hostname, and - only when two rows would read
 * identically (same title, same hostname) - the last few characters of the tab
 * id to tell them apart.
 */
export function disambiguateSecondaryLabels(
  rows: readonly BrowserTabLabelRow[],
): ReadonlyMap<string, string | null> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const bucket = labelBucket(row);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const labels = new Map<string, string | null>();
  for (const row of rows) {
    const hostname = browserTabHostname(row.url);
    if ((counts.get(labelBucket(row)) ?? 0) < 2) {
      labels.set(row.key, hostname);
      continue;
    }
    const suffix = row.tabId.slice(-TAB_ID_SUFFIX_LENGTH);
    labels.set(row.key, hostname === null ? suffix : `${hostname} (${suffix})`);
  }
  return labels;
}

function labelBucket(row: BrowserTabLabelRow): string {
  return `${row.title}\0${browserTabHostname(row.url) ?? ""}`;
}

function documentTitle(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function meaningfulDocumentTitle(
  title: string | null,
  url: string,
): string | null {
  const trimmed = documentTitle(title);
  if (trimmed === null) return null;
  return isFallbackTabTitle(trimmed, url) ? null : trimmed;
}

function isFallbackTabTitle(title: string, url: string): boolean {
  const normalizedTitle = normalizeIdentityText(title);
  const hostname = browserTabHostname(url);
  const host = browserTabHostLabel(url);
  const origin = browserTabOrigin(url);
  if (
    [hostname, host, origin, url].some(
      (candidate) =>
        candidate !== null &&
        normalizeIdentityText(candidate) === normalizedTitle,
    )
  )
    return true;
  const urlHostKey = hostname === null ? null : stripWww(hostname);
  const parsedTitle = parseBrowserUrl(
    title.includes("://") ? title : `https://${title}`,
  );
  return (
    parsedTitle !== null &&
    urlHostKey !== null &&
    stripWww(parsedTitle.hostname) === urlHostKey
  );
}

function normalizeIdentityText(value: string): string {
  return value.trim().toLowerCase().replace(/\/$/, "");
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function browserTabHostLabel(url: string): string | null {
  const host = parseHttpUrl(url)?.host ?? "";
  return host.length > 0 ? host : null;
}

function parseBrowserUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The one http(s) URL parser for the browser feature - link routing and
 * context attachments consume it too, so a URL that fails to parse has one
 * failure convention (`null`) everywhere.
 */
export function parseHttpUrl(url: string): URL | null {
  const parsed = parseBrowserUrl(url);
  return parsed?.protocol === "http:" || parsed?.protocol === "https:"
    ? parsed
    : null;
}
