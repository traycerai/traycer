import { vi } from "vitest";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";

/**
 * Shared `vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator")`
 * factory: both the mention-chip and annotation-card tests resolve their
 * session across the coordinator REGISTRY rather than a surrounding sessions
 * context, so each seeds this lookup instead of the live subscription.
 */
export async function browserSessionsCoordinatorMockFactory(
  getSessions: () => ReadonlyArray<BrowserSessionInfo>,
) {
  const actual = await vi.importActual<
    typeof import("@/lib/browser-view/sessions/browser-sessions-coordinator")
  >("@/lib/browser-view/sessions/browser-sessions-coordinator");
  return {
    ...actual,
    subscribeToBrowserSessionsCoordinators: () => () => undefined,
    browserSessionAcrossCoordinators: (sessionId: string) =>
      getSessions().find((item) => item.sessionId === sessionId) ?? null,
  };
}
