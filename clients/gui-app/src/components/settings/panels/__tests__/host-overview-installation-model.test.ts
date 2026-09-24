import type { HostListItem } from "@traycer/protocol/host/host-status";
import { describe, expect, it } from "vitest";
import {
  abbreviateIdentifier,
  deriveAboutThisHost,
} from "@/components/settings/panels/host-overview-installation-model";

const NOW_MS = Date.parse("2026-09-24T12:00:00Z");

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
  it("lets live override lastSeenAt", () => {
    const view = deriveAboutThisHost({
      item: item("2026-09-24T09:00:00Z", {}),
      live: true,
      nowMs: NOW_MS,
    });
    expect(view.lastSeen).toBe("Online now");
    expect(view.online).toBe(true);
  });

  it("words a stale lastSeenAt on the given clock, capitalised", () => {
    const view = deriveAboutThisHost({
      item: item("2026-09-24T09:00:00Z", {}),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.lastSeen).toBe("3h ago");
    expect(view.online).toBe(false);
  });

  it("says 'Just now' for a stamp inside the header's 45s window", () => {
    const view = deriveAboutThisHost({
      item: item("2026-09-24T11:59:30Z", {}),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.lastSeen).toBe("Just now");
  });

  it("treats a stamp in the future as no time elapsed rather than a negative age", () => {
    const view = deriveAboutThisHost({
      item: item("2026-09-24T12:05:00Z", {}),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.lastSeen).toBe("Just now");
  });

  it("says 'Not seen yet' when the host never checked in", () => {
    const view = deriveAboutThisHost({
      item: item(null, {}),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.lastSeen).toBe("Not seen yet");
  });

  it("says 'Unknown' for an unparsable lastSeenAt", () => {
    const view = deriveAboutThisHost({
      item: item("not-a-date", {}),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.lastSeen).toBe("Unknown");
  });

  it("shows an unparsable createdAt as it came", () => {
    const view = deriveAboutThisHost({
      item: item(null, { createdAt: "yesterday-ish" }),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.addedToAccount).toBe("yesterday-ish");
  });

  it("says 'Not reported yet' for a missing version and platform", () => {
    const view = deriveAboutThisHost({
      item: item(null, {
        platform: null,
        status: { ...item(null, {}).status, appVersion: null },
      }),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.lastReportedVersion).toBe("Not reported yet");
    expect(view.platform).toBe("Not reported yet");
  });

  it("prefixes a reported version with v and words the platform triple", () => {
    const view = deriveAboutThisHost({
      item: item(null, { platform: "darwin-arm64" }),
      live: false,
      nowMs: NOW_MS,
    });
    expect(view.lastReportedVersion).toBe("v1.5.0");
    expect(view.platform).toBe("macOS · arm64");
    expect(view.hostId).toBe("host-a");
  });
});
