import type { HostListItem } from "@traycer/protocol/host/host-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveAboutThisHost,
  type HostOverviewAboutSource,
} from "@/components/settings/panels/host-overview-installation-model";

const NOW_MS = Date.parse("2026-09-24T12:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

function item(
  lastSeenAt: string | null,
  overrides: Partial<HostListItem>,
): HostListItem {
  return {
    hostId: "host-a",
    displayName: null,
    platform: "linux-x64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-03-03T12:00:00Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt,
    },
    updatePolicy: "manual",
    ...overrides,
  };
}

function about(
  lastSeenAt: string | null,
  overrides: Partial<HostListItem>,
): HostOverviewAboutSource {
  return { item: item(lastSeenAt, overrides), nowMs: NOW_MS };
}

function withAppVersion(
  lastSeenAt: string | null,
  appVersion: string | null,
): HostOverviewAboutSource {
  return about(lastSeenAt, {
    status: { ...item(lastSeenAt, {}).status, appVersion, lastSeenAt },
  });
}

describe("deriveAboutThisHost", () => {
  it("uses the Settings date for when the host was added to the account", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    const view = deriveAboutThisHost({
      item: item(null, {
        createdAt: new Date(2026, 9, 24, 8, 35).toISOString(),
      }),
      nowMs: Date.now(),
    });

    expect(view.addedToAccount).toBe("24 Oct");
  });

  it("says a host that never checked in has not been seen, and reports its version and platform", () => {
    const view = deriveAboutThisHost(about(null, {}));
    expect(view.lastSeen).toBe("Not seen yet");
    expect(view.lastReportedVersion).toBe("v1.5.0");
    expect(view.platform).toBe("Linux · x64");
    expect(view).not.toHaveProperty("unseenLine");
  });

  it("shows an unparsable createdAt as it came", () => {
    const view = deriveAboutThisHost(
      about(null, { createdAt: "yesterday-ish" }),
    );
    expect(view.addedToAccount).toBe("yesterday-ish");
    expect(view.lastSeen).toBe("Not seen yet");
  });

  it("says Unknown for an unparsable last seen, and capitalizes an elapsed stamp", () => {
    expect(deriveAboutThisHost(about("not-a-date", {})).lastSeen).toBe(
      "Unknown",
    );
    expect(
      deriveAboutThisHost(about("2026-09-24T09:00:00Z", {})).lastSeen,
    ).toBe("3h ago");
    expect(
      deriveAboutThisHost(about("2026-09-24T12:00:00Z", {})).lastSeen,
    ).toBe("Just now");
  });

  it("says the version was not reported when the account has none", () => {
    expect(
      deriveAboutThisHost(withAppVersion(null, null)).lastReportedVersion,
    ).toBe("Not reported yet");
    expect(deriveAboutThisHost(about(null, { platform: null })).platform).toBe(
      "Not reported yet",
    );
  });
});
