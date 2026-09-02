import type {
  BrowserSessionInfo,
  BrowserSessionsOpenRequest,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import {
  browserSessionsCoordinatorKey,
  type BrowserSessionsOwner,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";

/**
 * Shared builders for the browser session fixtures scattered across the
 * renderer, lib/browser-view, and composer suites. Every field here is an
 * override target, not a fact about production defaults - callers pass
 * whatever their assertions read, and get today's other fields for free.
 */

export function sessionInfo(
  overrides: Partial<BrowserSessionInfo> = {},
): BrowserSessionInfo {
  return {
    sessionId: "session-1",
    epicId: "epic-1",
    hostId: "host-1",
    profile: "primary",
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 1 },
    tabs: [],
    ...overrides,
  };
}

export function tabInfo(
  overrides: Partial<BrowserTabInfo> = {},
): BrowserTabInfo {
  return {
    tabId: "tab-1",
    url: "about:blank",
    originTier: "dev",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    ...overrides,
  };
}

export function owner(
  overrides: Partial<BrowserSessionsOwner> = {},
): BrowserSessionsOwner {
  return {
    hostId: "host-1",
    identityKey: "identity-1",
    ...overrides,
  };
}

export function openRequest(
  overrides: Partial<BrowserSessionsOpenRequest> = {},
): BrowserSessionsOpenRequest {
  return {
    epicId: "epic-1",
    ...overrides,
  };
}

export function coordinatorKey(
  epicId: string,
  ownerOverrides: Partial<BrowserSessionsOwner> = {},
): string {
  return browserSessionsCoordinatorKey(epicId, owner(ownerOverrides));
}
