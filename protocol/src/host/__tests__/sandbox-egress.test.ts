import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  SANDBOX_EGRESS_REFUSAL_CODES,
  SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS,
  SANDBOX_SECRET_REQUEST_TOOL,
  sandboxEgressEventSchema,
  sandboxEgressSubscribeClientFrameSchemaV10,
  sandboxEgressSubscribeServerFrameSchemaV10,
  sandboxEgressSubscribeV10,
  sandboxRepairGuestConfigurationResponseSchema,
  sandboxRepairGuestConfigurationV10,
} from "@traycer/protocol/host/sandbox-egress";

const BASE = { id: "evt-1", at: 1_791_000_000_000, untrusted: false };

const REFUSED = {
  kind: "egress.refused",
  ...BASE,
  emitter: "gateway",
  code: "grant_missing",
  route: null,
  host: "db.example.com",
  protocol: "mysql",
  secret: "DB_PASSWORD",
  howToRequest: SANDBOX_SECRET_REQUEST_TOOL,
};

const TEARDOWN = {
  kind: "egress.teardown",
  ...BASE,
  emitter: "controller",
  route: "route-1",
  reason: "revoke",
};

const HELD = {
  kind: "egress.held",
  ...BASE,
  emitter: "gateway",
  route: "route-1",
  waitedMs: 1500,
};

const UNSUPPORTED_MODE = {
  kind: "egress.unsupported_mode",
  ...BASE,
  emitter: "reporter",
  untrusted: true,
  route: "route-2",
  mode: "ssh-keyboard-interactive",
  reason: "Use publickey authentication",
};

function makeEvents(count: number): ReadonlyArray<typeof HELD> {
  return Array.from({ length: count }, (_unused, index) => ({
    ...HELD,
    id: `evt-${index}`,
  }));
}

describe("sandbox egress events", () => {
  it.each([
    ["egress.refused", REFUSED],
    ["egress.teardown", TEARDOWN],
    ["egress.held", HELD],
    ["egress.unsupported_mode", UNSUPPORTED_MODE],
  ])("parses a %s event", (kind, fixture) => {
    expect(sandboxEgressEventSchema.parse(fixture).kind).toBe(kind);
  });

  it.each(["controller", "reporter", "gateway"])(
    "accepts the %s emitter",
    (emitter) => {
      expect(
        sandboxEgressEventSchema.safeParse({ ...HELD, emitter }).success,
      ).toBe(true);
    },
  );

  it("rejects an unknown emitter", () => {
    expect(
      sandboxEgressEventSchema.safeParse({ ...HELD, emitter: "guest" }).success,
    ).toBe(false);
  });

  it("accepts a refusal code outside the known list", () => {
    expect(SANDBOX_EGRESS_REFUSAL_CODES).not.toContain("ssh_flow_unknown");
    expect(
      sandboxEgressEventSchema.safeParse({
        ...REFUSED,
        code: "ssh_flow_unknown",
      }).success,
    ).toBe(true);
  });

  it("accepts null for every nullable refusal field", () => {
    const parsed = sandboxEgressEventSchema.safeParse({
      ...REFUSED,
      route: null,
      host: null,
      protocol: null,
      secret: null,
      howToRequest: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty refusal code", () => {
    expect(
      sandboxEgressEventSchema.safeParse({ ...REFUSED, code: "" }).success,
    ).toBe(false);
  });

  it.each(["revoke", "stale", "resume", "drain", "secret_rotated"])(
    "accepts the %s teardown reason",
    (reason) => {
      expect(
        sandboxEgressEventSchema.safeParse({ ...TEARDOWN, reason }).success,
      ).toBe(true);
    },
  );

  it("rejects another teardown reason", () => {
    expect(
      sandboxEgressEventSchema.safeParse({ ...TEARDOWN, reason: "expired" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown event kind", () => {
    expect(
      sandboxEgressEventSchema.safeParse({ ...HELD, kind: "egress.future" })
        .success,
    ).toBe(false);
  });
});

describe("sandbox egress constants", () => {
  it.each([
    "grant_missing",
    "sandbox_not_awake",
    "sandbox_resuming",
    "authorization_stale",
    "protocol_not_brokered",
    "signing_shape_unsupported",
    "leaf_unavailable",
    "connector_offline",
    "connector_not_enrolled",
    "socks_command_unsupported",
    "port_not_supported",
    "endpoint_unavailable",
    "h3_only_destination",
    "SANDBOX_GUEST_NOT_CONFIGURED",
  ])("lists the %s refusal code", (code) => {
    expect(SANDBOX_EGRESS_REFUSAL_CODES).toContain(code);
  });

  it("names the secret request tool", () => {
    expect(SANDBOX_SECRET_REQUEST_TOOL).toBe("traycer_secret_request");
  });
});

describe("sandbox egress stream frames", () => {
  it("parses a snapshot frame with events", () => {
    const parsed = sandboxEgressSubscribeServerFrameSchemaV10.safeParse({
      kind: "snapshot",
      hasBinaryPayload: false,
      events: [REFUSED, TEARDOWN, HELD, UNSUPPORTED_MODE],
    });
    expect(parsed.success).toBe(true);
  });

  it("parses an event frame", () => {
    expect(
      sandboxEgressSubscribeServerFrameSchemaV10.safeParse({
        kind: "event",
        hasBinaryPayload: false,
        event: HELD,
      }).success,
    ).toBe(true);
  });

  it("parses a pong frame", () => {
    expect(
      sandboxEgressSubscribeServerFrameSchemaV10.safeParse({
        kind: "pong",
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
  });

  it("accepts a snapshot at the cap and rejects one event over it", () => {
    expect(
      sandboxEgressSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        events: makeEvents(SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS),
      }).success,
    ).toBe(true);
    expect(
      sandboxEgressSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        events: makeEvents(SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS + 1),
      }).success,
    ).toBe(false);
  });

  it("parses a ping client frame", () => {
    expect(
      sandboxEgressSubscribeClientFrameSchemaV10.safeParse({
        kind: "ping",
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
  });
});

describe("sandbox egress contracts", () => {
  it("declares the subscribe stream at 1.0", () => {
    expect(sandboxEgressSubscribeV10.method).toBe(
      "host.sandbox.egress.subscribe",
    );
    expect(sandboxEgressSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("declares the repair unary at 1.0", () => {
    expect(sandboxRepairGuestConfigurationV10.method).toBe(
      "host.sandbox.repairGuestConfiguration",
    );
    expect(sandboxRepairGuestConfigurationV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("parses a configured and a failed repair response", () => {
    expect(
      sandboxRepairGuestConfigurationResponseSchema.parse({
        guestConfigured: true,
        guestConfigFailureReason: null,
      }),
    ).toEqual({ guestConfigured: true, guestConfigFailureReason: null });
    expect(
      sandboxRepairGuestConfigurationResponseSchema.parse({
        guestConfigured: false,
        guestConfigFailureReason: "trust files",
      }),
    ).toEqual({
      guestConfigured: false,
      guestConfigFailureReason: "trust files",
    });
  });
});

describe("sandbox egress registry facts", () => {
  it("registers the repair verb in the unary registry off the released floor", () => {
    const entry = hostRpcRegistry["host.sandbox.repairGuestConfiguration"];
    expect(entry[1].versions[0].contract).toBe(
      sandboxRepairGuestConfigurationV10,
    );
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "host.sandbox.repairGuestConfiguration",
    );
  });

  it("registers the egress stream at a 1.0 line", () => {
    const line = hostStreamRpcRegistry["host.sandbox.egress.subscribe"][1];
    expect(line.latestMinor).toBe(0);
    expect(line.versions[0].contract).toBe(sandboxEgressSubscribeV10);
  });
});
