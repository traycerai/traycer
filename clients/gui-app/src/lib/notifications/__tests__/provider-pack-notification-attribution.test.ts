import { describe, expect, it } from "vitest";
import {
  classifyProviderPackNotificationLocality,
  compareProviderPackLocalFirst,
  hostLabelSurvivesBodyTruncation,
  isProviderPackNotificationRemote,
  parseProviderPackNotificationAttribution,
  presentProviderPackNotificationBody,
  providerPackNotificationAllowsLocalAction,
  providerPackViewingLocalityFromShell,
  PROVIDER_PACK_BODY_VISIBLE_PREFIX_CHARS,
  type ProviderPackNotificationAttribution,
  type ProviderPackNotificationPayloadKind,
  type ProviderPackViewingLocalityContext,
} from "@/lib/notifications/provider-pack-notification-attribution";

const LOCAL_HOST_ID = "host-local-macbook";
const REMOTE_HOST_ID = "host-remote-desktop";
const LOCAL_LABEL = "MacBook-Pro";
const REMOTE_LABEL = "Linux-Box";

const RESOLVED_LOCAL: ProviderPackViewingLocalityContext = {
  kind: "resolved",
  hostId: LOCAL_HOST_ID,
};

const NO_LOCAL_HOST: ProviderPackViewingLocalityContext = {
  kind: "no-local-host",
};

const PENDING: ProviderPackViewingLocalityContext = { kind: "pending" };

const PACK_KINDS: readonly ProviderPackNotificationPayloadKind[] = [
  "provider_pack_update_available",
  "provider_pack_security_floor",
  "provider_pack_pin_lifecycle",
];

function attribution(
  overrides: Partial<ProviderPackNotificationAttribution> | null,
): ProviderPackNotificationAttribution {
  const base: ProviderPackNotificationAttribution = {
    kind: "provider_pack_update_available",
    hostId: LOCAL_HOST_ID,
    hostLabel: LOCAL_LABEL,
  };
  if (overrides === null) return base;
  return { ...base, ...overrides };
}

/** Host-composed update-available copy (includes machine caption). */
function updateAvailableBody(hostLabel: string): string {
  return `Claude Code 2.1.0 is available on ${hostLabel}. Auto-download is paused; download it from provider settings when ready.`;
}

/** Security-floor / pin-lifecycle copy has no host caption by default. */
function securityFloorBody(): string {
  return "Claude Code 1.0.0 no longer meets the publisher's security minimum. The managed copy is disabled until you update.";
}

function pinLifecycleBody(): string {
  return "Claude Code was pinned to 1.0.0, which no longer meets the publisher's security minimum. The pin was cleared. Version selection is automatic again; download policy is unchanged.";
}

describe("parseProviderPackNotificationAttribution", () => {
  it.each(PACK_KINDS)("accepts %s with hostId + hostLabel", (kind) => {
    expect(
      parseProviderPackNotificationAttribution({
        kind,
        hostId: LOCAL_HOST_ID,
        hostLabel: LOCAL_LABEL,
        pack: "claude",
      }),
    ).toEqual({
      kind,
      hostId: LOCAL_HOST_ID,
      hostLabel: LOCAL_LABEL,
    });
  });

  it("rejects non-provider-pack payloads", () => {
    expect(parseProviderPackNotificationAttribution(null)).toBeNull();
    expect(parseProviderPackNotificationAttribution(undefined)).toBeNull();
    expect(parseProviderPackNotificationAttribution("string")).toBeNull();
    expect(parseProviderPackNotificationAttribution([])).toBeNull();
    expect(
      parseProviderPackNotificationAttribution({
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
      }),
    ).toBeNull();
  });

  it("rejects pack kinds missing hostId or hostLabel", () => {
    expect(
      parseProviderPackNotificationAttribution({
        kind: "provider_pack_update_available",
        hostLabel: LOCAL_LABEL,
      }),
    ).toBeNull();
    expect(
      parseProviderPackNotificationAttribution({
        kind: "provider_pack_update_available",
        hostId: LOCAL_HOST_ID,
      }),
    ).toBeNull();
  });
});

describe("providerPackViewingLocalityFromShell", () => {
  it("maps hasLocalHost false to no-local-host (browser/mobile)", () => {
    expect(
      providerPackViewingLocalityFromShell({
        hasLocalHost: false,
        localHostId: null,
      }),
    ).toEqual({ kind: "no-local-host" });
  });

  it("maps hasLocalHost true without entry to pending", () => {
    expect(
      providerPackViewingLocalityFromShell({
        hasLocalHost: true,
        localHostId: null,
      }),
    ).toEqual({ kind: "pending" });
  });

  it("maps a known local host id to resolved", () => {
    expect(
      providerPackViewingLocalityFromShell({
        hasLocalHost: true,
        localHostId: LOCAL_HOST_ID,
      }),
    ).toEqual({ kind: "resolved", hostId: LOCAL_HOST_ID });
  });
});

describe("classifyProviderPackNotificationLocality / isRemote", () => {
  it("is local when resolved viewing host matches attribution", () => {
    expect(
      classifyProviderPackNotificationLocality({
        attribution: attribution({ hostId: LOCAL_HOST_ID }),
        viewing: RESOLVED_LOCAL,
      }),
    ).toBe("local");
    expect(
      isProviderPackNotificationRemote({
        attribution: attribution({ hostId: LOCAL_HOST_ID }),
        viewing: RESOLVED_LOCAL,
      }),
    ).toBe(false);
  });

  it("is remote when resolved viewing host is a different machine", () => {
    expect(
      classifyProviderPackNotificationLocality({
        attribution: attribution({
          hostId: REMOTE_HOST_ID,
          hostLabel: REMOTE_LABEL,
        }),
        viewing: RESOLVED_LOCAL,
      }),
    ).toBe("remote");
  });

  it("treats attributed pack events as remote on shells with no local host (finding 3)", () => {
    // Browser/mobile: permanent null local entry must NOT fail open as local.
    expect(
      classifyProviderPackNotificationLocality({
        attribution: attribution({ hostId: REMOTE_HOST_ID }),
        viewing: NO_LOCAL_HOST,
      }),
    ).toBe("remote");
    expect(
      isProviderPackNotificationRemote({
        attribution: attribution({ hostId: REMOTE_HOST_ID }),
        viewing: NO_LOCAL_HOST,
      }),
    ).toBe(true);
    expect(providerPackNotificationAllowsLocalAction("remote")).toBe(false);
  });

  it("is unknown (neither local nor remote) while desktop local host is pending", () => {
    expect(
      classifyProviderPackNotificationLocality({
        attribution: attribution({ hostId: REMOTE_HOST_ID }),
        viewing: PENDING,
      }),
    ).toBe("unknown");
    expect(
      isProviderPackNotificationRemote({
        attribution: attribution({ hostId: REMOTE_HOST_ID }),
        viewing: PENDING,
      }),
    ).toBe(false);
    // Unknown must not look locally actionable either.
    expect(providerPackNotificationAllowsLocalAction("unknown")).toBe(false);
  });

  it("is not remote when attribution is null", () => {
    expect(
      isProviderPackNotificationRemote({
        attribution: null,
        viewing: RESOLVED_LOCAL,
      }),
    ).toBe(false);
  });
});

describe("presentProviderPackNotificationBody", () => {
  describe("local", () => {
    it('strips machine attribution ("on MacBook-Pro") from update-available body', () => {
      const body = updateAvailableBody(LOCAL_LABEL);
      const presented = presentProviderPackNotificationBody({
        body,
        attribution: attribution({
          hostId: LOCAL_HOST_ID,
          hostLabel: LOCAL_LABEL,
        }),
        locality: "local",
      });

      expect(presented).not.toContain(`on ${LOCAL_LABEL}`);
      expect(presented).toBe(
        "Claude Code 2.1.0 is available. Auto-download is paused; download it from provider settings when ready.",
      );
    });
  });

  describe("remote", () => {
    it("places the host label at the start so truncation keeps the machine name (finding 6)", () => {
      const body = securityFloorBody();
      const presented = presentProviderPackNotificationBody({
        body,
        attribution: attribution({
          kind: "provider_pack_security_floor",
          hostId: REMOTE_HOST_ID,
          hostLabel: REMOTE_LABEL,
        }),
        locality: "remote",
      });

      expect(presented.startsWith(`On ${REMOTE_LABEL}:`)).toBe(true);
      expect(
        hostLabelSurvivesBodyTruncation(
          presented,
          REMOTE_LABEL,
          PROVIDER_PACK_BODY_VISIBLE_PREFIX_CHARS,
        ),
      ).toBe(true);
      // Visible prefix must not be only the generic fallback phrase.
      const visible = presented.slice(
        0,
        PROVIDER_PACK_BODY_VISIBLE_PREFIX_CHARS,
      );
      expect(visible).toContain(REMOTE_LABEL);
      expect(visible.toLowerCase()).not.toBe(
        "act on this from that machine".slice(0, visible.length),
      );
    });

    it("rewrites mid-body captions into the leading form", () => {
      const body = updateAvailableBody(REMOTE_LABEL);
      const presented = presentProviderPackNotificationBody({
        body,
        attribution: attribution({
          hostId: REMOTE_HOST_ID,
          hostLabel: REMOTE_LABEL,
        }),
        locality: "remote",
      });

      expect(presented.startsWith(`On ${REMOTE_LABEL}:`)).toBe(true);
      expect(presented.match(new RegExp(REMOTE_LABEL, "g"))?.length).toBe(1);
    });
  });

  describe("needs_action kinds are never dropped", () => {
    it.each([
      {
        kind: "provider_pack_update_available" as const,
        body: updateAvailableBody(REMOTE_LABEL),
      },
      {
        kind: "provider_pack_security_floor" as const,
        body: securityFloorBody(),
      },
      {
        kind: "provider_pack_pin_lifecycle" as const,
        body: pinLifecycleBody(),
      },
    ])(
      "remote $kind still returns a non-empty body with host label in the visible prefix",
      ({ kind, body }) => {
        const presented = presentProviderPackNotificationBody({
          body,
          attribution: attribution({
            kind,
            hostId: REMOTE_HOST_ID,
            hostLabel: REMOTE_LABEL,
          }),
          locality: "remote",
        });

        expect(presented.length).toBeGreaterThan(0);
        expect(
          hostLabelSurvivesBodyTruncation(
            presented,
            REMOTE_LABEL,
            PROVIDER_PACK_BODY_VISIBLE_PREFIX_CHARS,
          ),
        ).toBe(true);
      },
    );
  });

  it("returns the original body when attribution is null", () => {
    const body = updateAvailableBody(LOCAL_LABEL);
    expect(
      presentProviderPackNotificationBody({
        body,
        attribution: null,
        locality: "local",
      }),
    ).toBe(body);
  });
});

describe("providerPackNotificationAllowsLocalAction", () => {
  it("allows local action only for locality local", () => {
    expect(providerPackNotificationAllowsLocalAction("local")).toBe(true);
    expect(providerPackNotificationAllowsLocalAction("remote")).toBe(false);
    expect(providerPackNotificationAllowsLocalAction("unknown")).toBe(false);
  });
});

describe("compareProviderPackLocalFirst", () => {
  it("orders local-machine pack notifications before remote ones", () => {
    const local = {
      attribution: attribution({ hostId: LOCAL_HOST_ID }),
      createdAt: 100,
      feedId: "host:a",
    };
    const remote = {
      attribution: attribution({
        hostId: REMOTE_HOST_ID,
        hostLabel: REMOTE_LABEL,
      }),
      createdAt: 200,
      feedId: "host:b",
    };

    expect(
      compareProviderPackLocalFirst(local, remote, RESOLVED_LOCAL),
    ).toBeLessThan(0);
    expect(
      compareProviderPackLocalFirst(remote, local, RESOLVED_LOCAL),
    ).toBeGreaterThan(0);
  });

  it("falls back to recency then feedId when locality matches", () => {
    const newer = {
      attribution: attribution(null),
      createdAt: 200,
      feedId: "host:z",
    };
    const older = {
      attribution: attribution(null),
      createdAt: 100,
      feedId: "host:a",
    };

    expect(
      compareProviderPackLocalFirst(newer, older, RESOLVED_LOCAL),
    ).toBeLessThan(0);
  });
});
