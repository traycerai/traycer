import { describe, expect, it } from "vitest";
import { historyPinUnavailableReason } from "@/components/epics/history-pin-availability";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * Lane 9 item 5: `historyPinUnavailableReason` gained a required
 * `localHomePinSupported` argument (`epic.setPinned@1.1` negotiation).
 *
 * Read directly off the production source: a `local-home` row on a
 * supported host returns from ITS OWN branch and never reaches the session
 * check - `historyPinUnavailableReason` returns `null` there unconditionally,
 * regardless of `cloudAuthorized`. (The coordinator's brief described this
 * case as falling through to the session check; the shipped code and its own
 * docstring - "does not require a cloud verdict... returns from its own
 * branch and never reaches the session check" - say otherwise. Pinned against
 * the code, and flagged back rather than silently matched to the brief.)
 */
function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: "history-epic-1",
    epicId: "epic-from-history",
    taskType: "epic",
    title: "Row",
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
    ...overrides,
  };
}

describe("historyPinUnavailableReason - the version gate", () => {
  it("refuses a local-home row when the host does not support the local arm - unchanged behaviour", () => {
    expect(
      historyPinUnavailableReason(
        historyItem({ isLocalHome: true }),
        true,
        false,
      ),
    ).toBe("local-home");
  });

  it("admits a local-home row on a supported host regardless of the cloud session", () => {
    // The row returns from its own branch - see the module doc. A withdrawn
    // cloud verdict must not refuse a write the host's own disk can serve.
    expect(
      historyPinUnavailableReason(
        historyItem({ isLocalHome: true }),
        false,
        true,
      ),
    ).toBe(null);
    expect(
      historyPinUnavailableReason(
        historyItem({ isLocalHome: true }),
        true,
        true,
      ),
    ).toBe(null);
  });

  it("still checks the session for a non-local-home row - unaffected by the new argument", () => {
    expect(historyPinUnavailableReason(historyItem({}), false, false)).toBe(
      "unverified-session",
    );
    expect(historyPinUnavailableReason(historyItem({}), false, true)).toBe(
      "unverified-session",
    );
    expect(historyPinUnavailableReason(historyItem({}), true, false)).toBe(
      null,
    );
    expect(historyPinUnavailableReason(historyItem({}), true, true)).toBe(null);
  });

  it("still returns 'phase' regardless of the new argument", () => {
    expect(
      historyPinUnavailableReason(
        historyItem({ taskType: "phase" }),
        true,
        true,
      ),
    ).toBe("phase");
    expect(
      historyPinUnavailableReason(
        historyItem({ taskType: "phase" }),
        false,
        false,
      ),
    ).toBe("phase");
  });

  it("still returns 'preserved-orphan' regardless of the new argument", () => {
    expect(
      historyPinUnavailableReason(
        historyItem({ isPreservedOrphan: true }),
        true,
        true,
      ),
    ).toBe("preserved-orphan");
    expect(
      historyPinUnavailableReason(
        historyItem({ isPreservedOrphan: true }),
        false,
        false,
      ),
    ).toBe("preserved-orphan");
  });
});
