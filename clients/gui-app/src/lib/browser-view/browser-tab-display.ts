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
  const parsed = parseHttpBrowserUrl(url);
  return parsed === null
    ? null
    : new URL("/favicon.ico", parsed.origin).toString();
}

export function browserTabOrigin(url: string): string | null {
  return parseHttpBrowserUrl(url)?.origin ?? null;
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

export function disambiguateSecondaryLabels(
  rows: ReadonlyArray<{
    readonly key: string;
    readonly tabId: string;
    readonly title: string;
    readonly url: string;
  }>,
): ReadonlyMap<string, string | null> {
  const labels = baseSecondaryLabels(rows);
  appendDuplicateSuffixes(rows, labels);
  return labels;
}

function baseSecondaryLabels(
  rows: ReadonlyArray<{
    readonly key: string;
    readonly tabId: string;
    readonly title: string;
    readonly url: string;
  }>,
): Map<string, string | null> {
  const byTitle = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byTitle.get(row.title);
    if (group === undefined) {
      byTitle.set(row.title, [row]);
      continue;
    }
    byTitle.set(row.title, [...group, row]);
  }
  const labels = new Map<string, string | null>();
  for (const group of byTitle.values()) {
    if (group.length === 1) {
      const row = group[0];
      labels.set(row.key, browserTabHostname(row.url));
      continue;
    }
    const parsed = group.map((row) => ({
      row,
      hostname: browserTabHostname(row.url),
      host: browserTabHostLabel(row.url),
      path: browserTabPathname(row.url),
    }));
    for (const item of parsed) {
      const sameHostname = parsed.filter(
        (other) => other.hostname === item.hostname,
      );
      if (sameHostname.length === 1) {
        labels.set(item.row.key, item.hostname);
        continue;
      }
      const sameHost = sameHostname.filter((other) => other.host === item.host);
      if (sameHost.length === 1) {
        labels.set(item.row.key, item.host);
        continue;
      }
      const uniquePath = shortestUniquePath(
        item.path,
        sameHost.map((other) => other.path),
      );
      const base = item.host ?? item.hostname;
      if (base === null) {
        labels.set(item.row.key, uniquePath);
        continue;
      }
      labels.set(
        item.row.key,
        uniquePath === null ? base : `${base}${uniquePath}`,
      );
    }
  }
  return labels;
}

function appendDuplicateSuffixes(
  rows: ReadonlyArray<{
    readonly key: string;
    readonly tabId: string;
    readonly title: string;
    readonly url: string;
  }>,
  labels: Map<string, string | null>,
): void {
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const byLabel = new Map<string, string[]>();
  for (const [key, label] of labels) {
    const bucket = `${rowByKey.get(key)?.title ?? ""}\0${label ?? ""}`;
    const group = byLabel.get(bucket);
    if (group === undefined) {
      byLabel.set(bucket, [key]);
      continue;
    }
    group.push(key);
  }
  for (const keys of byLabel.values()) {
    if (keys.length < 2) continue;
    const suffixes = shortestUniqueIdSuffixes(
      keys.flatMap((key) => {
        const row = rowByKey.get(key);
        return row === undefined ? [] : [row.tabId];
      }),
    );
    for (const key of keys) {
      const row = rowByKey.get(key);
      if (row === undefined) continue;
      const suffix = suffixes.get(row.tabId) ?? row.tabId;
      const label = labels.get(key);
      labels.set(
        key,
        label === null || label === undefined ? suffix : `${label} (${suffix})`,
      );
    }
  }
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

function shortestUniqueIdSuffixes(
  ids: readonly string[],
): ReadonlyMap<string, string> {
  const suffixes = new Map<string, string>();
  if (ids.length === 0) return suffixes;
  const minLength = 4;
  let length = minLength;
  const maxLength = ids.reduce(
    (longest, id) => Math.max(longest, id.length),
    minLength,
  );
  while (length <= maxLength) {
    const next = ids.map((id) =>
      id.length <= length ? id : id.slice(-length),
    );
    if (new Set(next).size === ids.length) {
      ids.forEach((id, index) => {
        suffixes.set(id, next[index] ?? id);
      });
      return suffixes;
    }
    length += 1;
  }
  ids.forEach((id) => {
    suffixes.set(id, id);
  });
  return suffixes;
}

function browserTabHostLabel(url: string): string | null {
  const host = parseHttpBrowserUrl(url)?.host ?? "";
  return host.length > 0 ? host : null;
}

function browserTabPathname(url: string): string | null {
  return parseHttpBrowserUrl(url)?.pathname ?? null;
}

function parseBrowserUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function parseHttpBrowserUrl(url: string): URL | null {
  const parsed = parseBrowserUrl(url);
  return parsed?.protocol === "http:" || parsed?.protocol === "https:"
    ? parsed
    : null;
}

function shortestUniquePath(
  path: string | null,
  groupPaths: ReadonlyArray<string | null>,
): string | null {
  if (path === null || path === "" || path === "/") return null;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const others = groupPaths.filter((other) => other !== path);
  for (let count = 1; count <= segments.length; count += 1) {
    const candidate = `/${segments.slice(0, count).join("/")}`;
    const unique = others.every((other) => {
      if (other === null) return true;
      const otherSegments = other
        .split("/")
        .filter((segment) => segment.length > 0);
      return `/${otherSegments.slice(0, count).join("/")}` !== candidate;
    });
    if (unique) return candidate;
  }
  return path;
}
