import type { NavigateOptions } from "@tanstack/react-router";
import type { EpicViewTab } from "@/stores/epics/canvas/types";

export const LANDING_ROUTE: NavigateOptions = { to: "/" };

/**
 * Pathname portion of an href - everything before `?` or `#`. Pure string work
 * (no `URL`), so a relative href like `/epics/a/b?focus=x#h` parses without a
 * base. The single shared stripper for history/liveness/overlay code.
 */
export function hrefPathname(href: string): string {
  const boundary = href.search(/[?#]/);
  return boundary === -1 ? href : href.slice(0, boundary);
}

export function draftRoute(draftId: string): NavigateOptions {
  return {
    to: "/draft/$draftId",
    params: { draftId },
  };
}

export function draftPathname(draftId: string): string {
  return `/draft/${draftId}`;
}

export function botRoute(botId: string): NavigateOptions {
  return {
    to: "/bot/$botId",
    params: { botId },
  };
}

export function botPathname(botId: string): string {
  return `/bot/${encodeURIComponent(botId)}`;
}

const BOT_ROUTE_RE = /^\/bot\/([^/]+)\/?$/;

/**
 * Extract the bot id from a pathname if it matches `/bot/:botId`. Returns
 * `null` for any other route. The one parser every bot-route reader shares -
 * the navigation controller, desktop persistence and the kind module - so a
 * route-shape change cannot land in one of them and miss the rest.
 */
export function readBotIdFromPath(pathname: string): string | null {
  const match = BOT_ROUTE_RE.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const DEFAULT_EPIC_SEARCH = {
  focusedAt: undefined,
  focusArtifactId: undefined,
  focusThreadId: undefined,
  migrationSource: undefined,
} as const;

export function epicTabRoute(
  tab: Pick<EpicViewTab, "epicId" | "tabId">,
): NavigateOptions {
  return {
    to: "/epics/$epicId/$tabId",
    params: { epicId: tab.epicId, tabId: tab.tabId },
    search: DEFAULT_EPIC_SEARCH,
  };
}

type EpicPathInput = Pick<EpicViewTab, "tabId" | "epicId">;

export function epicPathname(input: EpicPathInput): string {
  return `/epics/${input.epicId}/${input.tabId}`;
}

const EPIC_ROUTE_RE = /^\/epics\/([^/]+)\/([^/]+)\/?$/;

/**
 * Extract the epic id from a pathname if it matches `/epics/:epicId/:tabId`.
 * Returns `null` for any other route. Shared by the keybinding
 * dispatcher and the command-palette context builder.
 */
export function readActiveEpicIdFromPath(pathname: string): string | null {
  const match = EPIC_ROUTE_RE.exec(pathname);
  return match === null ? null : match[1];
}

export function readActiveEpicTabIdFromPath(pathname: string): string | null {
  const match = EPIC_ROUTE_RE.exec(pathname);
  if (match === null) return null;
  const tabId = match[2];
  return typeof tabId === "string" ? tabId : null;
}
