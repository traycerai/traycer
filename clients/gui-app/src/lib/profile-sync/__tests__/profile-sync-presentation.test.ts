import { describe, expect, it } from "vitest";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProfileSyncDevice,
  ProfileSyncItem,
  ProfileSyncProvider,
  ProfileSyncReason,
  ProfileSyncStatus,
} from "@traycer/protocol/host/profile-sync-link-schemas";
import {
  groupProfileSyncItems,
  profileSyncDeviceSummary,
  profileSyncItemAction,
  profileSyncItemDetail,
  profileSyncItemNeedsUser,
  profileSyncReasonSentence,
  profileSyncWireProvider,
  type ProfileSyncNames,
  type ProfileSyncSummaryPart,
} from "@/lib/profile-sync/profile-sync-presentation";

const NAMES: ProfileSyncNames = {
  source: "MacBook",
  device: "Office Linux",
};

const REASON_SENTENCES: ReadonlyArray<{
  readonly reason: ProfileSyncReason;
  readonly provider: ProfileSyncProvider;
  readonly sentence: string;
}> = [
  {
    reason: "provider-not-installed",
    provider: "claude",
    sentence: "Claude Code isn't installed on Office Linux",
  },
  {
    reason: "provider-disabled",
    provider: "codex",
    sentence: "Codex is turned off on Office Linux",
  },
  {
    reason: "unsupported-sign-in",
    provider: "grok",
    sentence: "This sign-in type can't be synced",
  },
  {
    reason: "keychain-store",
    provider: "antigravity",
    sentence: "Antigravity keeps this sign-in in the system keychain",
  },
  {
    reason: "keychain-locked",
    provider: "claude",
    sentence: "The keychain on MacBook is locked",
  },
  {
    reason: "account-changed",
    provider: "codex",
    sentence: "MacBook is now signed in to a different account",
  },
  {
    reason: "account-unknown",
    provider: "grok",
    sentence: "The account isn't identified yet",
  },
  {
    reason: "destination-refused",
    provider: "antigravity",
    sentence: "Office Linux refused this profile",
  },
  {
    reason: "transfer-failed",
    provider: "claude",
    sentence: "Couldn't reach Office Linux, retrying",
  },
  {
    reason: "removed-on-device",
    provider: "codex",
    sentence: "Removed on Office Linux",
  },
];

function item(input: {
  readonly providerId: ProfileSyncProvider;
  readonly sourceProfileId: string;
  readonly name: string;
  readonly status: ProfileSyncStatus;
  readonly reason: ProfileSyncReason | null;
}): ProfileSyncItem {
  return {
    providerId: input.providerId,
    sourceProfileId: input.sourceProfileId,
    name: input.name,
    status: input.status,
    reason: input.reason,
  };
}

function device(items: readonly ProfileSyncItem[]): ProfileSyncDevice {
  return {
    hostId: "host-office",
    keepInSync: false,
    items: [...items],
  };
}

function summaryText(parts: readonly ProfileSyncSummaryPart[]): string {
  return parts.map((part) => part.text).join(" · ");
}

describe("profileSyncReasonSentence", () => {
  it.each(REASON_SENTENCES)(
    "renders $reason as its exact sentence",
    ({ reason, provider, sentence }) => {
      expect(profileSyncReasonSentence(reason, provider, NAMES)).toBe(sentence);
    },
  );
});

describe("profileSyncItemDetail", () => {
  it("tells the user to update Traycer on the device for update-needed", () => {
    expect(
      profileSyncItemDetail(
        item({
          providerId: "claude",
          sourceProfileId: "ambient",
          name: "Work",
          status: "update-needed",
          reason: null,
        }),
        NAMES,
      ),
    ).toBe("Update Traycer on Office Linux");
  });

  it("falls back when cannot-sync arrives with no reason", () => {
    expect(
      profileSyncItemDetail(
        item({
          providerId: "grok",
          sourceProfileId: "ambient",
          name: "Work",
          status: "cannot-sync",
          reason: null,
        }),
        NAMES,
      ),
    ).toBe("This profile can't be synced");
  });

  it("has no detail for a plain synced row", () => {
    expect(
      profileSyncItemDetail(
        item({
          providerId: "codex",
          sourceProfileId: "ambient",
          name: "Work",
          status: "synced",
          reason: null,
        }),
        NAMES,
      ),
    ).toBeNull();
  });
});

describe("profileSyncItemAction", () => {
  it("offers sign-in for sign-in-needed", () => {
    const row = item({
      providerId: "claude",
      sourceProfileId: "ambient",
      name: "Work",
      status: "sign-in-needed",
      reason: null,
    });
    expect(profileSyncItemAction(row)).toBe("sign-in");
    expect(profileSyncItemNeedsUser(row)).toBe(true);
  });

  it("offers accept-account for cannot-sync with account-changed", () => {
    const row = item({
      providerId: "codex",
      sourceProfileId: "ambient",
      name: "Work",
      status: "cannot-sync",
      reason: "account-changed",
    });
    expect(profileSyncItemAction(row)).toBe("accept-account");
    expect(profileSyncItemNeedsUser(row)).toBe(true);
  });

  it("offers no action for cannot-sync with removed-on-device", () => {
    const row = item({
      providerId: "grok",
      sourceProfileId: "ambient",
      name: "Work",
      status: "cannot-sync",
      reason: "removed-on-device",
    });
    expect(profileSyncItemAction(row)).toBeNull();
    expect(profileSyncItemNeedsUser(row)).toBe(false);
  });

  it("offers no action for every other status", () => {
    const rows: readonly ProfileSyncItem[] = [
      item({
        providerId: "claude",
        sourceProfileId: "ambient",
        name: "Work",
        status: "synced",
        reason: null,
      }),
      item({
        providerId: "claude",
        sourceProfileId: "ambient",
        name: "Work",
        status: "syncing",
        reason: null,
      }),
      item({
        providerId: "claude",
        sourceProfileId: "ambient",
        name: "Work",
        status: "device-offline",
        reason: null,
      }),
      item({
        providerId: "claude",
        sourceProfileId: "ambient",
        name: "Work",
        status: "update-needed",
        reason: null,
      }),
      item({
        providerId: "claude",
        sourceProfileId: "ambient",
        name: "Work",
        status: "cannot-sync",
        reason: "provider-disabled",
      }),
    ];
    for (const row of rows) {
      expect(profileSyncItemAction(row)).toBeNull();
      expect(profileSyncItemNeedsUser(row)).toBe(false);
    }
  });
});

describe("groupProfileSyncItems", () => {
  it("keeps needs-you rows in host order and sorts the rest problems → syncing → synced", () => {
    const signInFirst = item({
      providerId: "claude",
      sourceProfileId: "11111111-1111-4111-8111-111111111111",
      name: "First sign-in",
      status: "sign-in-needed",
      reason: null,
    });
    const synced = item({
      providerId: "codex",
      sourceProfileId: "22222222-2222-4222-8222-222222222222",
      name: "Synced",
      status: "synced",
      reason: null,
    });
    const accountChanged = item({
      providerId: "grok",
      sourceProfileId: "33333333-3333-4333-8333-333333333333",
      name: "Account changed",
      status: "cannot-sync",
      reason: "account-changed",
    });
    const removed = item({
      providerId: "antigravity",
      sourceProfileId: "44444444-4444-4444-8444-444444444444",
      name: "Removed",
      status: "cannot-sync",
      reason: "removed-on-device",
    });
    const updateNeeded = item({
      providerId: "claude",
      sourceProfileId: "55555555-5555-4555-8555-555555555555",
      name: "Update",
      status: "update-needed",
      reason: null,
    });
    const signInSecond = item({
      providerId: "codex",
      sourceProfileId: "66666666-6666-4666-8666-666666666666",
      name: "Second sign-in",
      status: "sign-in-needed",
      reason: null,
    });
    const syncing = item({
      providerId: "grok",
      sourceProfileId: "77777777-7777-4777-8777-777777777777",
      name: "Syncing",
      status: "syncing",
      reason: null,
    });
    const offline = item({
      providerId: "antigravity",
      sourceProfileId: "88888888-8888-4888-8888-888888888888",
      name: "Offline",
      status: "device-offline",
      reason: null,
    });

    const grouped = groupProfileSyncItems([
      synced,
      signInFirst,
      removed,
      accountChanged,
      updateNeeded,
      signInSecond,
      syncing,
      offline,
    ]);

    expect(grouped.needsUser).toEqual([
      signInFirst,
      accountChanged,
      signInSecond,
    ]);
    expect(grouped.rest).toEqual([
      removed,
      updateNeeded,
      offline,
      syncing,
      synced,
    ]);
  });
});

describe("profileSyncDeviceSummary", () => {
  it("reads Not synced yet when the device has never been synced", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: null,
          reach: "reachable",
          deviceName: "Office Linux",
          profileCount: 3,
        }),
      ),
    ).toBe("Not synced yet");
  });

  it("counts synced and need-you rows, with singular 1 needs you", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: device([
            item({
              providerId: "claude",
              sourceProfileId: "ambient",
              name: "A",
              status: "synced",
              reason: null,
            }),
            item({
              providerId: "codex",
              sourceProfileId: "11111111-1111-4111-8111-111111111111",
              name: "B",
              status: "synced",
              reason: null,
            }),
            item({
              providerId: "grok",
              sourceProfileId: "22222222-2222-4222-8222-222222222222",
              name: "C",
              status: "sign-in-needed",
              reason: null,
            }),
          ]),
          reach: "reachable",
          deviceName: "Office Linux",
          profileCount: 3,
        }),
      ),
    ).toBe("2 synced · 1 needs you");
  });

  it("counts need you as sign-in-needed and account-changed only, and other cannot-sync as can't sync", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: device([
            item({
              providerId: "claude",
              sourceProfileId: "ambient",
              name: "A",
              status: "sign-in-needed",
              reason: null,
            }),
            item({
              providerId: "codex",
              sourceProfileId: "11111111-1111-4111-8111-111111111111",
              name: "B",
              status: "cannot-sync",
              reason: "account-changed",
            }),
            item({
              providerId: "grok",
              sourceProfileId: "22222222-2222-4222-8222-222222222222",
              name: "C",
              status: "cannot-sync",
              reason: "removed-on-device",
            }),
            item({
              providerId: "antigravity",
              sourceProfileId: "33333333-3333-4333-8333-333333333333",
              name: "D",
              status: "cannot-sync",
              reason: "provider-disabled",
            }),
          ]),
          reach: "reachable",
          deviceName: "Office Linux",
          profileCount: 4,
        }),
      ),
    ).toBe("2 need you · 2 can't sync");
  });

  it("leads with Device offline when the directory says the machine is offline", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: device([
            item({
              providerId: "claude",
              sourceProfileId: "ambient",
              name: "A",
              status: "synced",
              reason: null,
            }),
          ]),
          reach: "offline",
          deviceName: "Office Linux",
          profileCount: 1,
        }),
      ),
    ).toBe("Device offline · syncs when it connects");
  });

  it("leads with Device offline when every item is device-offline", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: device([
            item({
              providerId: "claude",
              sourceProfileId: "ambient",
              name: "A",
              status: "device-offline",
              reason: null,
            }),
            item({
              providerId: "codex",
              sourceProfileId: "11111111-1111-4111-8111-111111111111",
              name: "B",
              status: "device-offline",
              reason: null,
            }),
          ]),
          reach: "reachable",
          deviceName: "Office Linux",
          profileCount: 2,
        }),
      ),
    ).toBe("Device offline · syncs when it connects");
  });

  it("tells the user to update Traycer when reach is update-required", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: null,
          reach: "update-required",
          deviceName: "Office Linux",
          profileCount: 2,
        }),
      ),
    ).toBe("Update Traycer on Office Linux");
  });

  it("says No profiles to sync when the device has no items and the source has none", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: device([]),
          reach: "reachable",
          deviceName: "Office Linux",
          profileCount: 0,
        }),
      ),
    ).toBe("No profiles to sync");
  });

  it("says Syncing when the device has no items yet and the source has profiles", () => {
    expect(
      summaryText(
        profileSyncDeviceSummary({
          device: device([]),
          reach: "reachable",
          deviceName: "Office Linux",
          profileCount: 3,
        }),
      ),
    ).toBe("Syncing");
  });
});

describe("profileSyncWireProvider", () => {
  it("maps the four covered providers and returns null outside them", () => {
    expect(profileSyncWireProvider("claude-code")).toBe("claude");
    expect(profileSyncWireProvider("codex")).toBe("codex");
    expect(profileSyncWireProvider("grok")).toBe("grok");
    expect(profileSyncWireProvider("antigravity")).toBe("antigravity");
    const outside: readonly ProviderId[] = ["cursor", "opencode", "traycer"];
    for (const providerId of outside) {
      expect(profileSyncWireProvider(providerId)).toBeNull();
    }
  });
});
