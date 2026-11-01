import type { HostListItem } from "@traycer/protocol/host/host-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostLastReport } from "@/components/settings/host-scope/host-last-report";
import {
  abbreviateIdentifier,
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

/**
 * The source a personal host's page is given: its report is the account's own
 * stamp, read the way `hostLastReport` reads it.
 */
function aboutOf(host: HostListItem, nowMs: number): HostOverviewAboutSource {
  return {
    item: host,
    lastReport: hostLastReport(host, null),
    headerVersion: null,
    nowMs,
  };
}

describe("abbreviateIdentifier", () => {
  it("returns an identifier of 16 characters or fewer whole", () => {
    expect(abbreviateIdentifier("a".repeat(16))).toBe("a".repeat(16));
    expect(abbreviateIdentifier("")).toBe("");
  });

  it("keeps the head 8 and the tail 4 of anything longer", () => {
    expect(abbreviateIdentifier("0123456789abcdefg")).toBe("01234567…defg");
  });
});

describe("deriveAboutThisHost", () => {
  it("uses the Settings date for when the host was added to the account", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    const view = deriveAboutThisHost(
      aboutOf(
        item(null, {
          createdAt: new Date(2026, 9, 24, 8, 35).toISOString(),
        }),
        Date.now(),
      ),
    );

    expect(view.addedToAccount).toBe("24 Oct");
  });

  // The fixture's record is `connectable`, so this also pins that the cloud's
  // lease reading does not word the row: a lease read up to its TTL old is not
  // evidence of a check-in, and the row has one wording.
  it("words a stale lastSeenAt on the given clock, capitalised", () => {
    const view = deriveAboutThisHost(
      aboutOf(item("2026-09-24T09:00:00Z", {}), NOW_MS),
    );
    expect(view.lastSeen).toBe("3h ago");
  });

  it("says 'Just now' for a stamp inside the header's 45s window", () => {
    const view = deriveAboutThisHost(
      aboutOf(item("2026-09-24T11:59:30Z", {}), NOW_MS),
    );
    expect(view.lastSeen).toBe("Just now");
  });

  it("treats a stamp in the future as no time elapsed rather than a negative age", () => {
    const view = deriveAboutThisHost(
      aboutOf(item("2026-09-24T12:05:00Z", {}), NOW_MS),
    );
    expect(view.lastSeen).toBe("Just now");
  });

  it("says 'Not seen yet' when the host never checked in", () => {
    const view = deriveAboutThisHost(aboutOf(item(null, {}), NOW_MS));
    expect(view.lastSeen).toBe("Not seen yet");
  });

  it("says 'Unknown' for an unparsable lastSeenAt", () => {
    const view = deriveAboutThisHost(aboutOf(item("not-a-date", {}), NOW_MS));
    expect(view.lastSeen).toBe("Unknown");
  });

  it("shows an unparsable createdAt as it came", () => {
    const view = deriveAboutThisHost(
      aboutOf(item(null, { createdAt: "yesterday-ish" }), NOW_MS),
    );
    expect(view.addedToAccount).toBe("yesterday-ish");
  });

  it("says 'Not reported yet' for a missing version and platform", () => {
    const view = deriveAboutThisHost(
      aboutOf(
        item(null, {
          platform: null,
          status: { ...item(null, {}).status, appVersion: null },
        }),
        NOW_MS,
      ),
    );
    expect(view.lastReportedVersion).toBe("Not reported yet");
    expect(view.platform).toBe("Not reported yet");
  });

  it("prefixes a reported version with v and words the platform triple", () => {
    const view = deriveAboutThisHost(
      aboutOf(item(null, { platform: "darwin-arm64" }), NOW_MS),
    );
    expect(view.lastReportedVersion).toBe("v1.5.0");
    expect(view.platform).toBe("macOS · arm64");
    expect(view.hostId).toBe("host-a");
  });

  it("reads a personal host's version from its own record, whatever version the header shows", () => {
    const host = item(null, {});
    const view = deriveAboutThisHost({
      ...aboutOf(host, NOW_MS),
      headerVersion: "9.9.9",
    });
    expect(view.lastReportedVersion).toBe("v1.5.0");
  });

  it("reads a sandbox's version from the header, since its record never carries one", () => {
    const host = item(null, {
      kind: "sandbox",
      status: { ...item(null, {}).status, appVersion: null },
    });
    const view = deriveAboutThisHost({
      ...aboutOf(host, NOW_MS),
      headerVersion: "2.1.0",
    });
    expect(view.lastReportedVersion).toBe("v2.1.0");
  });
});
