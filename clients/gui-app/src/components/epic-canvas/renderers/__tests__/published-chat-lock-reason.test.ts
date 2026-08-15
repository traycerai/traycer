import { describe, expect, it } from "vitest";

import {
  publishedChatLockReason,
  replicaChatLockReason,
} from "@/components/epic-canvas/renderers/published-chat-lock-reason";
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/**
 * The locked composer's footer is the ONE sentence a reader of a read-only
 * copy gets, and it has to survive being read on the machine it is talking
 * about. `PublishedChatTile` reaches this surface for a foreign owner (the
 * sidebar's locked row, a cross-host chat) AND for this device's own
 * connected host (tickets 47/48: the host answered `CHAT_NOT_VISIBLE` about
 * itself, so the canvas substituted the published copy) - and the
 * foreign-owner sentence, read in that second case, tells the user their own
 * machine "lives on" somewhere else and is not available "from this device".
 * That copy is what sent two live debugging sessions after a healthy host on
 * 2026-08-11, so each state is pinned separately here.
 */
describe("publishedChatLockReason", () => {
  it("names the owning machine and this device when the owner is someone else", () => {
    const reason = publishedChatLockReason({
      ownerIsReachable: true,
      ownerIsThisHost: false,
      ownerLabel: "Ada's Mac",
      unreadableCount: 0,
      fidelityNotice: null,
      publishedAt: null,
      copyIsBehind: false,
    });

    expect(reason).toContain("which lives on Ada's Mac");
    expect(reason).toContain("not available live from this device");
  });

  it("names neither a host nor a second device when the owner IS this host", () => {
    const reason = publishedChatLockReason({
      ownerIsReachable: true,
      ownerIsThisHost: true,
      ownerLabel: "Ada's Mac",
      unreadableCount: 0,
      fidelityNotice: null,
      publishedAt: null,
      copyIsBehind: false,
    });

    expect(reason).toContain("last published copy");
    expect(reason).toContain("no longer on this host");
    // The three phrases that turn into lies once the owner is the reader's
    // own connected host.
    expect(reason).not.toContain("lives on");
    expect(reason).not.toContain("Ada's Mac");
    expect(reason).not.toContain("from this device");
  });

  it("keeps the offline sentence for an unreachable owner regardless of whose host it is", () => {
    // Nothing answered, so there is no "the host said it is not here" to
    // report - only a host to wait for. The same-host reword is a
    // REACHABLE-owner distinction and must not leak into this arm.
    for (const ownerIsThisHost of [false, true]) {
      const reason = publishedChatLockReason({
        ownerIsReachable: false,
        ownerIsThisHost,
        ownerLabel: "Ada's Mac",
        unreadableCount: 0,
        fidelityNotice: null,
        publishedAt: null,
        copyIsBehind: false,
      });
      expect(reason).toContain("which is offline");
      expect(reason).toContain("Sending resumes when that host is back.");
    }
  });

  it("still appends the unreadable-item and fidelity tails to the same-host sentence", () => {
    // The tails are appended to whichever base was chosen - the split must
    // not drop them for the new arm.
    expect(
      publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 2,
        fidelityNotice: null,
        publishedAt: null,
        copyIsBehind: false,
      }),
    ).toContain("2 items need a newer version of Traycer to render.");
    expect(
      publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 0,
        fidelityNotice: "1 attachment is unavailable.",
        publishedAt: null,
        copyIsBehind: false,
      }),
    ).toContain("1 attachment is unavailable.");
  });

  describe("freshness sentence", () => {
    it("says nothing about freshness when there is no evidence either way", () => {
      const reason = publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 0,
        fidelityNotice: null,
        publishedAt: null,
        copyIsBehind: false,
      });

      expect(reason).not.toContain("Published");
      expect(reason).not.toContain("continued");
    });

    it("reports the agent has continued when behind is proven but there is no publish time", () => {
      const reason = publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 0,
        fidelityNotice: null,
        publishedAt: null,
        copyIsBehind: true,
      });

      expect(reason).toContain(
        "The agent has continued since this copy was published.",
      );
    });

    it("states when the copy was published when it is not behind", () => {
      const publishedAt = Date.parse("2026-08-14T12:00:00Z");
      const reason = publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 0,
        fidelityNotice: null,
        publishedAt,
        copyIsBehind: false,
      });

      expect(reason).toContain(
        `Published ${formatAbsoluteDateTime(publishedAt)}.`,
      );
      expect(reason).not.toContain("continued");
    });

    it("states when the copy was published and that the agent has continued since when behind", () => {
      const publishedAt = Date.parse("2026-08-14T12:00:00Z");
      const reason = publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 0,
        fidelityNotice: null,
        publishedAt,
        copyIsBehind: true,
      });

      expect(reason).toContain(
        `Published ${formatAbsoluteDateTime(publishedAt)}; the agent has continued since.`,
      );
    });

    it("sits before the unreadable-items tail", () => {
      const publishedAt = Date.parse("2026-08-14T12:00:00Z");
      const reason = publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 2,
        fidelityNotice: null,
        publishedAt,
        copyIsBehind: false,
      });

      const freshnessIndex = reason.indexOf(
        `Published ${formatAbsoluteDateTime(publishedAt)}.`,
      );
      const unreadableIndex = reason.indexOf(
        "2 items need a newer version of Traycer to render.",
      );
      expect(freshnessIndex).toBeGreaterThanOrEqual(0);
      expect(unreadableIndex).toBeGreaterThan(freshnessIndex);
    });

    it("sits before the fidelity notice tail", () => {
      const publishedAt = Date.parse("2026-08-14T12:00:00Z");
      const reason = publishedChatLockReason({
        ownerIsReachable: true,
        ownerIsThisHost: true,
        ownerLabel: "Ada's Mac",
        unreadableCount: 0,
        fidelityNotice: "1 attachment is unavailable.",
        publishedAt,
        copyIsBehind: false,
      });

      const freshnessIndex = reason.indexOf(
        `Published ${formatAbsoluteDateTime(publishedAt)}.`,
      );
      const fidelityIndex = reason.indexOf("1 attachment is unavailable.");
      expect(freshnessIndex).toBeGreaterThanOrEqual(0);
      expect(fidelityIndex).toBeGreaterThan(freshnessIndex);
    });
  });
});

describe("replicaChatLockReason", () => {
  it("names the owning machine when the owner is someone else", () => {
    const reason = replicaChatLockReason({
      ownerIsReachable: true,
      ownerIsThisHost: false,
      ownerLabel: "Ada's Mac",
      unreadableCount: 0,
    });

    expect(reason).toContain("which lives on Ada's Mac");
    expect(reason).toContain("not available live from this device");
  });

  it("drops the other-machine phrasing when the owner IS this host", () => {
    const reason = replicaChatLockReason({
      ownerIsReachable: true,
      ownerIsThisHost: true,
      ownerLabel: "Ada's Mac",
      unreadableCount: 0,
    });

    expect(reason).toContain("synced copy of this agent");
    expect(reason).toContain("no longer on this host");
    expect(reason).not.toContain("lives on");
    expect(reason).not.toContain("Ada's Mac");
    expect(reason).not.toContain("from this device");
  });
});
