import { describe, expect, it } from "vitest";
import type { HostUpdateStoreFloorRefusal } from "@traycer/protocol/host/maintenance/index";
import {
  describeHostStoreFloorRpcRefusal,
  hostStoreFormatRestriction,
  hostStoreFormatRestrictionFromRpc,
  type HostStoreFormatOffer,
} from "../host-overview-store-formats";

const RUNNING_VERSION = "1.3.0-rc.4";

function offer(overrides: Partial<HostStoreFormatOffer>): HostStoreFormatOffer {
  return {
    version: "1.2.0",
    publishedFormats: { chatDb: 8 },
    runningVersion: RUNNING_VERSION,
    installSupportsStoreFloor: true,
    storeFormats: {
      chatDb: {
        current: 9,
        onDiskMax: 9,
        epicCount: 1,
        survey: "complete",
      },
    },
    ...overrides,
  };
}

describe("hostStoreFormatRestriction", () => {
  it("never restricts the running version's own row - a catalog row is judged by its version, not by its published formats", () => {
    // The applicability call passes `null` as the declaration on purpose: a
    // catalog row is a signed registry artifact whose version is its
    // identity. Passing the published formats instead would make the running
    // version's own row read as a downgrade - withheld on a pre-floor peer,
    // "Checking chat stores…" while the survey is pending. Both twins here.
    expect(
      hostStoreFormatRestriction(
        offer({
          version: RUNNING_VERSION,
          publishedFormats: { chatDb: 9 },
          installSupportsStoreFloor: false,
        }),
      ),
    ).toBeNull();
    expect(
      hostStoreFormatRestriction(
        offer({
          version: RUNNING_VERSION,
          publishedFormats: { chatDb: 9 },
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "pending",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("leaves pre-1.4 peers unrestricted because null means no report", () => {
    expect(
      hostStoreFormatRestriction(offer({ storeFormats: null })),
    ).toBeNull();
  });

  it("keeps an older row disabled while the first survey is pending", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "pending",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "pending",
      reason: "Checking chat stores…",
      detail: null,
      confirmation: null,
    });
  });

  it("clears a same-format rollback while the first survey is still pending - formats settle it before any survey state (Codex)", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0-rc.1",
          publishedFormats: { chatDb: 9 },
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "pending",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("keeps an older-format target pending while the first survey is pending - formats cannot excuse it", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.2.0",
          publishedFormats: { chatDb: 8 },
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "pending",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "pending",
      reason: "Checking chat stores…",
      detail: null,
      confirmation: null,
    });
  });

  it("unlocks an older row after a completed empty survey", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "complete",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("allows a same-format RC downgrade after a completed survey", () => {
    expect(
      hostStoreFormatRestriction(
        offer({ version: "1.3.0-rc.1", publishedFormats: { chatDb: 9 } }),
      ),
    ).toBeNull();
  });

  it("marks newer on-disk data as blocked and exposes confirmation copy", () => {
    const restriction = hostStoreFormatRestriction(offer({}));
    expect(restriction).toEqual({
      kind: "blocked",
      reason: "Reads chat store format 8; this device has 9",
      detail:
        "Can't open chat stores written by this host; installing anyway loses access to those chats until you update forward.",
      confirmation:
        "This device has chat stores written in format 9. v1.2.0 reads format 8, so it can't open those chats, and it may fail to start until you update the host again. Nothing is deleted; updating forward restores access.",
    });
  });

  it("marks an incomplete failed survey as disabled with inspection guidance", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 1,
              survey: "failed",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "failed",
      reason: "Chat stores couldn't be read",
      detail:
        "This device's chat stores couldn't be read, so installing this version may lose access to those chats.",
      confirmation:
        "This device's chat stores couldn't be read, so Traycer can't verify v1.2.0 can open them.",
    });
  });

  it("refuses an older target whose format is unknown", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0",
          runningVersion: "1.3.1",
          publishedFormats: null,
        }),
      ),
    ).toEqual({
      kind: "unknown",
      reason: "Chat store format not published",
      detail:
        "v1.3.0 doesn't publish which chat store format it reads, so this device's data can't be verified against it.",
      confirmation:
        "v1.3.0 doesn't publish which chat store format it reads, so Traycer can't verify it can open this device's chats.",
    });
  });

  it("keeps an unknown target pending until the host's first survey completes", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0",
          runningVersion: "1.3.1",
          publishedFormats: null,
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "pending",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "pending",
      reason: "Checking chat stores…",
      detail: null,
      confirmation: null,
    });
  });

  it("allows an unknown target after a completed empty survey", () => {
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0",
          runningVersion: "1.3.1",
          publishedFormats: null,
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 0,
              survey: "complete",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("uses a published format for a release outside the fixed table", () => {
    expect(
      hostStoreFormatRestriction(
        offer({ version: "1.2.0", publishedFormats: { chatDb: 9 } }),
      ),
    ).toBeNull();
  });

  it("clears a failed survey when the target's own format equals this build's", () => {
    // The rc.4 -> rc.1 case: both stamp chatDb 9, so a walk that failed could
    // not have found anything that changes the answer.
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0-rc.1",
          publishedFormats: { chatDb: 9 },
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 1,
              survey: "failed",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("clears a failed survey from the released table too, without a published format", () => {
    // Same as above, but the target's format is resolved from
    // `storeFormatsFromReleasedTable` rather than the catalog's own metadata -
    // the fix must not depend on the registry row carrying `storeFormats`.
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0-rc.1",
          publishedFormats: null,
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 1,
              survey: "failed",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("still restricts a failed survey when the unknown target's format cannot clear it", () => {
    // Same shape as "refuses an older target whose format is unknown" above,
    // but with a failed rather than complete survey - the unknown-target
    // branch returns before the failed-survey check runs either way, so the
    // restriction is unchanged by the survey outcome.
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0",
          runningVersion: "1.3.1",
          publishedFormats: null,
          storeFormats: {
            chatDb: {
              current: 9,
              onDiskMax: null,
              epicCount: 1,
              survey: "failed",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "unknown",
      reason: "Chat store format not published",
      detail:
        "v1.3.0 doesn't publish which chat store format it reads, so this device's data can't be verified against it.",
      confirmation:
        "v1.3.0 doesn't publish which chat store format it reads, so Traycer can't verify it can open this device's chats.",
    });
  });

  it("clears a failed survey when the target's format is strictly newer than this build's", () => {
    // Pins `>=` rather than `==`: a target that stamps NEWER than the running
    // build can read this build's own chats even less ambiguously than an
    // equal target can.
    expect(
      hostStoreFormatRestriction(
        offer({
          version: "1.3.0-rc.1",
          publishedFormats: { chatDb: 9 },
          storeFormats: {
            chatDb: {
              current: 8,
              onDiskMax: null,
              epicCount: 1,
              survey: "failed",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("withholds a downgrade from an install method that predates the store floor", () => {
    expect(
      hostStoreFormatRestriction(offer({ installSupportsStoreFloor: false })),
    ).toEqual({
      kind: "floor-unsupported",
      reason: "Update this host before installing an older version",
      detail:
        "This host is too old to check whether v1.2.0 can open this device's chats, so it can't be downgraded from here. Update the host first; older versions become available once it can check.",
      confirmation: null,
    });
  });

  it("withholds a downgrade from a store-floor-incapable install method even when storeFormats is null", () => {
    // The exact reported case: a status from before @1.4 supplies `null`,
    // which the old code treated as unrestricted.
    const restriction = hostStoreFormatRestriction(
      offer({ installSupportsStoreFloor: false, storeFormats: null }),
    );
    expect(restriction).toEqual({
      kind: "floor-unsupported",
      reason: "Update this host before installing an older version",
      detail:
        "This host is too old to check whether v1.2.0 can open this device's chats, so it can't be downgraded from here. Update the host first; older versions become available once it can check.",
      confirmation: null,
    });
  });

  it("withholds a downgrade from a store-floor-incapable install method even when storeFormats would otherwise clear it", () => {
    // The gate is the peer's capability, not the evidence: this storeFormats
    // shape alone would return null (see "allows an unknown target after a
    // completed empty survey" above).
    const restriction = hostStoreFormatRestriction(
      offer({
        installSupportsStoreFloor: false,
        version: "1.3.0",
        runningVersion: "1.3.1",
        publishedFormats: null,
        storeFormats: {
          chatDb: {
            current: 9,
            onDiskMax: null,
            epicCount: 0,
            survey: "complete",
          },
        },
      }),
    );
    expect(restriction).toEqual({
      kind: "floor-unsupported",
      reason: "Update this host before installing an older version",
      detail:
        "This host is too old to check whether v1.3.0 can open this device's chats, so it can't be downgraded from here. Update the host first; older versions become available once it can check.",
      confirmation: null,
    });
  });

  it("does not withhold an upgrade from a store-floor-incapable install method", () => {
    // Guard against over-blocking: the gate is downgrade-specific, so a
    // target NEWER than runningVersion is untouched.
    expect(
      hostStoreFormatRestriction(
        offer({
          installSupportsStoreFloor: false,
          version: "1.4.0",
          publishedFormats: { chatDb: 9 },
        }),
      ),
    ).toBeNull();
  });
});

function blockedRefusal(
  overrides: Partial<HostUpdateStoreFloorRefusal>,
): HostUpdateStoreFloorRefusal {
  return {
    kind: "blocked",
    reason: "newer-chat-stores",
    targetVersion: "1.2.0",
    targetChatDb: 8,
    onDiskMax: 9,
    epicCount: 2,
    epicIds: ["epic-a", "epic-b"],
    unreadableEpicCount: 0,
    unreadableEpicIds: [],
    ...overrides,
  };
}

describe("describeHostStoreFloorRpcRefusal", () => {
  it("says nothing about unreadable stores when none were unreadable", () => {
    const description = describeHostStoreFloorRpcRefusal(
      blockedRefusal({ unreadableEpicCount: 0, unreadableEpicIds: [] }),
    );
    expect(description).not.toContain("could not be read");
    expect(description).toBe(
      "Can't install 1.2.0: 2 epics (epic-a, epic-b) use a newer chat store (format 9; 1.2.0 reads 8). Update forward instead, or choose Install anyway for v1.2.0 to proceed and lose access to affected chats until the host is updated again.",
    );
  });

  it("names the proven-newer epics and the unreadable epics separately, with the override guidance last", () => {
    const description = describeHostStoreFloorRpcRefusal(
      blockedRefusal({
        epicCount: 2,
        epicIds: ["epic-a", "epic-b"],
        unreadableEpicCount: 2,
        unreadableEpicIds: ["epic-c", "epic-d"],
      }),
    );
    expect(description).toContain(
      "2 epics (epic-a, epic-b) use a newer chat store",
    );
    expect(description).toContain(
      "2 epics (epic-c, epic-d) could not be read.",
    );
    expect(description.indexOf("Update forward instead")).toBeGreaterThan(
      description.indexOf("could not be read."),
    );
  });

  it("truncates the unreadable group with an ellipsis when the count exceeds the id list", () => {
    const unreadableEpicIds = Array.from(
      { length: 10 },
      (_, index) => `epic-${index}`,
    );
    const description = describeHostStoreFloorRpcRefusal(
      blockedRefusal({
        unreadableEpicCount: 14,
        unreadableEpicIds,
      }),
    );
    expect(description).toContain(
      `14 epics (${unreadableEpicIds.join(", ")}, …) could not be read.`,
    );
  });

  it("uses the singular for exactly one unreadable epic", () => {
    const description = describeHostStoreFloorRpcRefusal(
      blockedRefusal({
        unreadableEpicCount: 1,
        unreadableEpicIds: ["epic-c"],
      }),
    );
    expect(description).toContain("1 epic (epic-c) could not be read.");
    expect(description).not.toContain("1 epics");
  });

  it("does not add a second unreadable clause on the indeterminate arm, whose epicIds already ARE the unreadable set", () => {
    const description = describeHostStoreFloorRpcRefusal({
      kind: "indeterminate",
      reason: "unreadable-stores",
      targetVersion: "1.2.0",
      targetChatDb: null,
      onDiskMax: null,
      epicCount: 2,
      epicIds: ["epic-a", "epic-b"],
      unreadableEpicCount: 2,
      unreadableEpicIds: ["epic-a", "epic-b"],
    });
    const occurrences = description.split("could not be read").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("hostStoreFormatRestrictionFromRpc", () => {
  it("includes the unreadable-stores sentence in the confirmation body when the refusal names unreadable epics", () => {
    const restriction = hostStoreFormatRestrictionFromRpc(
      blockedRefusal({
        unreadableEpicCount: 2,
        unreadableEpicIds: ["epic-c", "epic-d"],
      }),
    );
    expect(restriction.kind).toBe("blocked");
    expect(restriction.confirmation).toContain(
      "2 epics (epic-c, epic-d) couldn't be read, so Traycer can't verify v1.2.0 can open them.",
    );
    expect(restriction.confirmation).toMatch(
      /Nothing is deleted; updating forward restores access\.$/,
    );
  });

  it("omits the unreadable-stores sentence when the refusal has no unreadable epics", () => {
    const restriction = hostStoreFormatRestrictionFromRpc(
      blockedRefusal({ unreadableEpicCount: 0, unreadableEpicIds: [] }),
    );
    expect(restriction.confirmation).not.toContain("couldn't be read");
    expect(restriction.confirmation).toBe(
      "This device has chat stores written in format 9. v1.2.0 reads format 8, so it can't open those chats, and it may fail to start until you update the host again. Nothing is deleted; updating forward restores access.",
    );
  });
});

describe("hostStoreFormatRestriction confirmation (cached host.status path)", () => {
  it("never names unreadable epics, because the cached status has no per-epic list at all", () => {
    const restriction = hostStoreFormatRestriction(offer({}));
    expect(restriction).not.toBeNull();
    // `hostStoreFormatRestriction` always passes `null` for the unreadable
    // group to `newerStoresRestriction` - the cached `host.status` path can
    // only say whether the survey failed, never which epics.
    expect(restriction?.confirmation).not.toContain("couldn't be read, so");
  });
});
