import type {
  BrowserSessionInfo,
  BrowserSessionsOpenRequest,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
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

/** The epic every other builder here defaults to. */
export const FIXTURE_EPIC_ID = "epic-1";

export function epicScope(epicId: string): HostResourceScope {
  return { kind: "epic", epicId };
}

export function independentScope(): HostResourceScope {
  return { kind: "independent" };
}

export function sessionInfo(
  overrides: Partial<BrowserSessionInfo>,
): BrowserSessionInfo {
  return {
    sessionId: "session-1",
    scope: epicScope(FIXTURE_EPIC_ID),
    hostId: "host-1",
    profile: "primary",
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 1 },
    tabs: [],
    ...overrides,
  };
}

export function tabInfo(overrides: Partial<BrowserTabInfo>): BrowserTabInfo {
  return {
    tabId: "tab-1",
    url: "about:blank",
    originTier: "dev",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    boundWindowId: null,
    ...overrides,
  };
}

export function owner(
  overrides: Partial<BrowserSessionsOwner>,
): BrowserSessionsOwner {
  return {
    hostId: "host-1",
    identityKey: "identity-1",
    ...overrides,
  };
}

export function openRequest(
  overrides: Partial<BrowserSessionsOpenRequest>,
): BrowserSessionsOpenRequest {
  return {
    scope: epicScope(FIXTURE_EPIC_ID),
    ...overrides,
  };
}

/**
 * A coordinator key by scope. It takes the scope rather than an epic id so a
 * suite can key an independent inventory without reaching past the kit.
 */
export function coordinatorKey(
  scope: HostResourceScope,
  ownerOverrides: Partial<BrowserSessionsOwner>,
): string {
  return browserSessionsCoordinatorKey(scope, owner(ownerOverrides));
}
