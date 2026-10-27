import { describe, expect, it } from "vitest";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  V23_HOST_NOTIFICATION_KINDS,
  V24_HOST_NOTIFICATION_KINDS,
  formatHostNotificationPresentation,
  hiddenHostNotificationKinds,
  hostNotificationEntrySchemaV23,
  hostNotificationEntrySchemaV24,
  hostNotificationsListResponseSchemaV23,
  hostNotificationsListResponseSchemaV24,
  parseKnownHostNotificationPayloadForKind,
  visibleHostNotificationKinds,
  type HostNotificationKind,
  type HostNotificationsSurface,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * The environments redesign's five kinds - `environment.move.stalled`,
 * `environment.apply.failed`, `team.role.changed`, `team.host.returned` and
 * `secret.removed` - ride list `@2.4` / feed `@1.6` / cloudFeed `@1.4`: absent
 * from every older minor, present from these up.
 */

const NEW_KINDS = [
  "environment.move.stalled",
  "environment.apply.failed",
  "team.role.changed",
  "team.host.returned",
  "secret.removed",
] as const satisfies readonly HostNotificationKind[];

type NewKind = (typeof NEW_KINDS)[number];

const LIST: HostNotificationsSurface = { method: "host.notifications.list" };
const FEED: HostNotificationsSurface = {
  method: "host.notifications.feed.subscribe",
};
const CLOUD_FEED: HostNotificationsSurface = {
  method: "host.notifications.cloudFeed.subscribe",
};

const ENTRY_BASE = {
  id: "entry-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  sourceRef: "source-1",
  epicId: null,
  chatId: null,
};

const PAYLOADS: Readonly<Record<NewKind, Record<string, unknown>>> = {
  "environment.move.stalled": {
    kind: "environment_move_stalled",
    environmentId: "env-1",
    hostId: "host-1",
    hostName: "studio",
    remaining: 3,
    reason: "offline",
  },
  "environment.apply.failed": {
    kind: "environment_apply_failed",
    environmentId: "env-1",
    hostId: "host-1",
    hostName: "studio",
    itemKey: "variable:API_BASE",
    reason: "permission_denied",
  },
  "team.role.changed": {
    kind: "team_role_changed",
    environmentId: "env-1",
    teamName: "Acme",
    from: "viewer",
    to: "admin",
  },
  "team.host.returned": {
    kind: "team_host_returned",
    environmentId: "env-1",
    teamName: "Acme",
    hostName: "studio",
  },
  "secret.removed": {
    kind: "secret_removed",
    environmentId: "env-1",
    secretName: "DB_PASSWORD",
    outcome: "cleanup_requested",
  },
};

/** The arm's own outcome: the two failures errored, the rest completed. */
const OUTCOMES: Readonly<Record<NewKind, "errored" | "completed">> = {
  "environment.move.stalled": "errored",
  "environment.apply.failed": "errored",
  "team.role.changed": "completed",
  "team.host.returned": "completed",
  "secret.removed": "completed",
};

function fullEntry(
  kind: NewKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...ENTRY_BASE,
    kind,
    severity: OUTCOMES[kind] === "errored" ? "failure" : "info",
    outcome: OUTCOMES[kind],
    payload,
  };
}

function presentationOf(kind: NewKind, payload: Record<string, unknown>) {
  return formatHostNotificationPresentation(
    hostNotificationEntrySchemaV24.parse(fullEntry(kind, payload)),
  );
}

describe("visibility of the five environments-redesign kinds", () => {
  it.each([
    ["list 2.0", LIST, { major: 2, minor: 0 }],
    ["list 2.3", LIST, { major: 2, minor: 3 }],
    ["feed 1.0", FEED, { major: 1, minor: 0 }],
    ["feed 1.4", FEED, { major: 1, minor: 4 }],
    ["feed 1.5", FEED, { major: 1, minor: 5 }],
    ["cloudFeed 1.0", CLOUD_FEED, { major: 1, minor: 0 }],
    ["cloudFeed 1.3", CLOUD_FEED, { major: 1, minor: 3 }],
  ])("hides all five at %s", (_label, surface, version) => {
    const visible = visibleHostNotificationKinds(surface, version);
    const hidden = hiddenHostNotificationKinds(surface, version);
    for (const kind of NEW_KINDS) {
      expect(visible).not.toContain(kind);
      expect(hidden).toContain(kind);
    }
  });

  it.each([
    ["list 2.4", LIST, { major: 2, minor: 4 }],
    ["list 2.5", LIST, { major: 2, minor: 5 }],
    ["feed 1.6", FEED, { major: 1, minor: 6 }],
    ["feed 1.7", FEED, { major: 1, minor: 7 }],
    ["cloudFeed 1.4", CLOUD_FEED, { major: 1, minor: 4 }],
    ["cloudFeed 1.5", CLOUD_FEED, { major: 1, minor: 5 }],
  ])("shows all five at %s", (_label, surface, version) => {
    const visible = visibleHostNotificationKinds(surface, version);
    const hidden = hiddenHostNotificationKinds(surface, version);
    for (const kind of NEW_KINDS) {
      expect(visible).toContain(kind);
      expect(hidden).not.toContain(kind);
    }
    // `sandbox.notice` is cloud-feed @1.5 only; the five are not what it hides.
    expect(hidden.filter((kind) => kind !== "sandbox.notice")).toEqual([]);
  });

  it("freezes V23_HOST_NOTIFICATION_KINDS as what list 2.3, feed 1.4-1.5 and cloudFeed 1.3 carry", () => {
    for (const [surface, version] of [
      [LIST, { major: 2, minor: 3 }],
      [FEED, { major: 1, minor: 4 }],
      [FEED, { major: 1, minor: 5 }],
      [CLOUD_FEED, { major: 1, minor: 3 }],
    ] as const) {
      expect(visibleHostNotificationKinds(surface, version)).toBe(
        V23_HOST_NOTIFICATION_KINDS,
      );
    }
    for (const kind of NEW_KINDS) {
      expect(V23_HOST_NOTIFICATION_KINDS).not.toContain(kind);
    }
    expect([...V23_HOST_NOTIFICATION_KINDS, ...NEW_KINDS]).toEqual(
      V24_HOST_NOTIFICATION_KINDS,
    );
  });

  it("keeps every kind of the V23 union visible at the new minors", () => {
    for (const [surface, version] of [
      [LIST, { major: 2, minor: 4 }],
      [FEED, { major: 1, minor: 6 }],
      [CLOUD_FEED, { major: 1, minor: 4 }],
    ] as const) {
      const visible = visibleHostNotificationKinds(surface, version);
      for (const kind of V23_HOST_NOTIFICATION_KINDS) {
        expect(visible).toContain(kind);
      }
    }
  });
});

describe("the V24 entry union", () => {
  it.each(NEW_KINDS)("parses a full %s entry, which V23 rejects", (kind) => {
    const entry = fullEntry(kind, PAYLOADS[kind]);
    const parsed = hostNotificationEntrySchemaV24.safeParse(entry);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.kind).toBe(kind);
    expect(hostNotificationEntrySchemaV23.safeParse(entry).success).toBe(false);
  });

  it.each(NEW_KINDS)("refuses %s with the other outcome", (kind) => {
    const other = OUTCOMES[kind] === "errored" ? "completed" : "errored";
    expect(
      hostNotificationEntrySchemaV24.safeParse({
        ...fullEntry(kind, PAYLOADS[kind]),
        outcome: other,
      }).success,
    ).toBe(false);
  });

  it.each(NEW_KINDS)("accepts an older %s entry without resolvedAt", (kind) => {
    const parsed = hostNotificationEntrySchemaV24.parse(
      fullEntry(kind, PAYLOADS[kind]),
    );
    expect("resolvedAt" in parsed).toBe(false);
  });

  it("covers every kind V23 covers, so no earlier arm was dropped", () => {
    for (const kind of V23_HOST_NOTIFICATION_KINDS) {
      expect(
        hostNotificationEntrySchemaV24.options.map(
          (option) => option.shape.kind.value,
        ),
      ).toContain(kind);
    }
  });

  it("serves list@2.4 pages with the new kinds and refuses them on @2.3", () => {
    const page = {
      entries: NEW_KINDS.map((kind) => fullEntry(kind, PAYLOADS[kind])),
      nextCursor: null,
    };
    expect(
      hostNotificationsListResponseSchemaV24.parse(page).entries,
    ).toHaveLength(NEW_KINDS.length);
    expect(hostNotificationsListResponseSchemaV23.safeParse(page).success).toBe(
      false,
    );
  });

  it("downgrades a list page to the released union without the new kinds", () => {
    const released = {
      ...ENTRY_BASE,
      id: "entry-0",
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: { outcome: "completed" },
    };
    const page = hostNotificationsListResponseSchemaV24.parse({
      entries: [released, ...NEW_KINDS.map((k) => fullEntry(k, PAYLOADS[k]))],
      nextCursor: null,
    });
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["host.notifications.list"],
      2,
      1,
      page,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.entries.map((entry) => entry.kind)).toEqual([
      "agent.stopped",
    ]);
  });
});

describe("the five payloads", () => {
  it.each(NEW_KINDS)(
    "%s parses under its own kind with its fields, and tolerates extra keys",
    (kind) => {
      const payload = PAYLOADS[kind];
      const parsed = parseKnownHostNotificationPayloadForKind(kind, payload);
      expect(parsed).toMatchObject(payload);
      expect(
        parseKnownHostNotificationPayloadForKind(kind, {
          ...payload,
          addedByANewerHost: { anything: true },
        }),
      ).toMatchObject(payload);
    },
  );

  it.each(NEW_KINDS)(
    "%s needs an environmentId, and every other field it names",
    (kind) => {
      for (const key of Object.keys(PAYLOADS[kind])) {
        const { [key]: _dropped, ...partial } = PAYLOADS[kind];
        expect(
          parseKnownHostNotificationPayloadForKind(kind, partial),
        ).toBeNull();
      }
      expect(
        parseKnownHostNotificationPayloadForKind(kind, {
          ...PAYLOADS[kind],
          environmentId: "",
        }),
      ).toBeNull();
    },
  );

  it("returns null when a payload kind does not match the notification kind", () => {
    expect(
      parseKnownHostNotificationPayloadForKind(
        "team.role.changed",
        PAYLOADS["team.host.returned"],
      ),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind(
        "secret.removed",
        PAYLOADS["environment.apply.failed"],
      ),
    ).toBeNull();
  });

  it("refuses a negative remaining count and an outcome secret.removed does not know", () => {
    expect(
      parseKnownHostNotificationPayloadForKind("environment.move.stalled", {
        ...PAYLOADS["environment.move.stalled"],
        remaining: -1,
      }),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind("secret.removed", {
        ...PAYLOADS["secret.removed"],
        outcome: "vaporized",
      }),
    ).toBeNull();
  });
});

describe("the five kinds' copy", () => {
  it("words a stalled move from its host and what is left", () => {
    expect(
      presentationOf(
        "environment.move.stalled",
        PAYLOADS["environment.move.stalled"],
      ),
    ).toEqual({
      title: "Move to Personal stalled",
      body: "studio • 3 items not in Personal yet",
    });
    expect(
      presentationOf("environment.move.stalled", {
        ...PAYLOADS["environment.move.stalled"],
        remaining: 1,
      }).body,
    ).toBe("studio • 1 item not in Personal yet");
  });

  it("words a setting that was not applied from its host and key", () => {
    expect(
      presentationOf(
        "environment.apply.failed",
        PAYLOADS["environment.apply.failed"],
      ),
    ).toEqual({
      title: "Setting not applied",
      body: "studio • A setting could not be applied",
    });
  });

  it("words a role change from the team and both roles, passing an unknown role through", () => {
    expect(
      presentationOf("team.role.changed", PAYLOADS["team.role.changed"]),
    ).toEqual({
      title: "Your role changed",
      body: "Acme • You're now an admin (you were a viewer).",
    });
    expect(
      presentationOf("team.role.changed", {
        ...PAYLOADS["team.role.changed"],
        from: "owner",
        to: "editor",
      }).body,
    ).toBe("Acme • You're now an editor (you were an owner).");
    expect(
      presentationOf("team.role.changed", {
        ...PAYLOADS["team.role.changed"],
        to: "billing",
      }).body,
    ).toBe("Acme • You're now billing (you were a viewer).");
  });

  it("words a computer back on its own settings", () => {
    expect(
      presentationOf("team.host.returned", PAYLOADS["team.host.returned"]),
    ).toEqual({
      title: "Computer back on your own settings",
      body: "studio • No longer runs Acme",
    });
  });

  it("words a removed secret by what became of it", () => {
    const body = (outcome: string): string =>
      presentationOf("secret.removed", {
        ...PAYLOADS["secret.removed"],
        outcome,
      }).body;
    expect(
      presentationOf("secret.removed", PAYLOADS["secret.removed"]).title,
    ).toBe("Secret removed");
    expect(body("revoked")).toBe("DB_PASSWORD • Revoked");
    expect(body("cleanup_requested")).toBe(
      "DB_PASSWORD • Revoked; removing it from its hosts",
    );
    expect(body("destroyed")).toBe("DB_PASSWORD • Destroyed");
  });

  it.each([
    [
      "environment.move.stalled",
      "Move to Personal stalled",
      "A computer's move to Personal stopped before it finished",
    ],
    [
      "environment.apply.failed",
      "Setting not applied",
      "A host could not apply a setting",
    ],
    ["team.role.changed", "Your role changed", "Your role in a team changed"],
    [
      "team.host.returned",
      "Computer back on your own settings",
      "A computer no longer runs a team's settings",
    ],
    ["secret.removed", "Secret removed", "A secret was removed"],
  ] as const)(
    "%s falls back to its generic copy for a malformed payload",
    (kind, title, body) => {
      expect(presentationOf(kind, { kind: PAYLOADS[kind].kind })).toEqual({
        title,
        body,
      });
    },
  );
});

describe("a sandbox's settings notice", () => {
  const SANDBOX = {
    name: "Build box",
    configurationName: "Acme",
    attemptId: "attempt-1",
    applied: ["Secrets"],
    notApplied: ["Providers"],
  };
  const withSandbox = {
    ...PAYLOADS["environment.apply.failed"],
    itemKey: "claude:ANTHROPIC_API_KEY",
    sandbox: SANDBOX,
  };

  it("carries the sandbox context, absent on a legacy payload", () => {
    expect(
      parseKnownHostNotificationPayloadForKind(
        "environment.apply.failed",
        withSandbox,
      ),
    ).toMatchObject({ sandbox: SANDBOX });
    const legacy = parseKnownHostNotificationPayloadForKind(
      "environment.apply.failed",
      PAYLOADS["environment.apply.failed"],
    );
    expect(legacy).toMatchObject(PAYLOADS["environment.apply.failed"]);
    expect(legacy).not.toBeNull();
    expect(
      legacy !== null && "sandbox" in legacy ? legacy.sandbox : undefined,
    ).toBeUndefined();
  });

  it("titles with the shared line and says the steps in the body, never a raw key or code", () => {
    const presentation = presentationOf(
      "environment.apply.failed",
      withSandbox,
    );

    expect(presentation.title).toMatch(
      /^Build box is awake, but Acme's settings didn't apply · SBX-\d{4}$/,
    );
    expect(presentation.body).toContain("Providers");
    expect(presentation.body).not.toMatch(
      /permission_denied|ANTHROPIC_API_KEY/,
    );
  });
});
