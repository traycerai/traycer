import { describe, expect, it } from "vitest";
import type { SandboxEgressEvent } from "@traycer/protocol/host/sandbox-egress";
import {
  SANDBOX_CARD_EGRESS_EVENT_LIMIT,
  sandboxCardEgressEventLines,
  sandboxEgressEventLine,
} from "@/lib/sandboxes/sandbox-egress-event-line";

type RefusedEvent = Extract<SandboxEgressEvent, { kind: "egress.refused" }>;
type TeardownEvent = Extract<SandboxEgressEvent, { kind: "egress.teardown" }>;
type HeldEvent = Extract<SandboxEgressEvent, { kind: "egress.held" }>;
type UnsupportedModeEvent = Extract<
  SandboxEgressEvent,
  { kind: "egress.unsupported_mode" }
>;

function refused(
  code: string,
  host: string | null,
  untrusted: boolean,
): RefusedEvent {
  return {
    kind: "egress.refused",
    id: "ev-refused",
    at: 1_000,
    emitter: "gateway",
    untrusted,
    code,
    route: "route-1",
    host,
    protocol: "postgres",
    secret: "PROD_DB",
    howToRequest: null,
  };
}

function teardown(reason: TeardownEvent["reason"]): TeardownEvent {
  return {
    kind: "egress.teardown",
    id: `ev-teardown-${reason}`,
    at: 2_000,
    emitter: "gateway",
    untrusted: false,
    route: "route-2",
    reason,
  };
}

function held(waitedMs: number): HeldEvent {
  return {
    kind: "egress.held",
    id: `ev-held-${waitedMs}`,
    at: 3_000,
    emitter: "controller",
    untrusted: true,
    route: "route-3",
    waitedMs,
  };
}

function unsupportedMode(mode: string, reason: string): UnsupportedModeEvent {
  return {
    kind: "egress.unsupported_mode",
    id: "ev-mode",
    at: 4_000,
    emitter: "gateway",
    untrusted: false,
    route: "route-4",
    mode,
    reason,
  };
}

const LONG_TEXT = "x".repeat(300);

describe("sandboxEgressEventLine: egress.refused", () => {
  it("names a known code with the copy table's headline and the subject in the description", () => {
    const line = sandboxEgressEventLine(
      refused("grant_missing", "db.internal", true),
    );

    expect(line.tone).toBe("refused");
    expect(line.headline).toBe("No grant for this destination");
    expect(line.description).toContain("PROD_DB");
    expect(line.description).toContain("db.internal");
    expect(line.description).toContain("postgres");
    expect(line.route).toBe("route-1");
    expect(line.reportedBySandbox).toBe(true);
    expect(line.id).toBe("ev-refused");
    expect(line.at).toBe(1_000);
  });

  it("carries reportedBySandbox false for a trusted event", () => {
    const line = sandboxEgressEventLine(
      refused("grant_missing", "db.internal", false),
    );

    expect(line.reportedBySandbox).toBe(false);
  });

  it("shows an unknown code verbatim and names the host", () => {
    const line = sandboxEgressEventLine(
      refused("ssh_flow_unknown", "git.internal", false),
    );

    expect(line.tone).toBe("refused");
    expect(line.headline).toBe("Refused: ssh_flow_unknown");
    expect(line.description).toContain("git.internal");
  });

  it("says a destination when an unknown-code refusal has no host", () => {
    const line = sandboxEgressEventLine(
      refused("ssh_flow_unknown", null, false),
    );

    expect(line.description).toContain("a destination");
  });
});

describe("sandboxEgressEventLine: egress.teardown", () => {
  it("is a closed line with a fixed headline", () => {
    const line = sandboxEgressEventLine(teardown("revoke"));

    expect(line.tone).toBe("closed");
    expect(line.headline).toBe("Connections closed");
    expect(line.route).toBe("route-2");
    expect(line.reportedBySandbox).toBe(false);
  });

  it("gives each of the five reasons its own description", () => {
    const descriptions = (
      ["revoke", "stale", "resume", "drain", "secret_rotated"] as const
    ).map((reason) => sandboxEgressEventLine(teardown(reason)).description);

    expect(new Set(descriptions).size).toBe(5);
  });

  it("tells the person a rotated secret cut the old connections, and what that does not undo", () => {
    const line = sandboxEgressEventLine(teardown("secret_rotated"));

    expect(line.description).toBe(
      "This secret's value was replaced, so connections opened with the old value were cut. Anything the destination had already accepted is not undone. Reconnect.",
    );
  });

  it("says a revoke does not undo what the destination already accepted", () => {
    const line = sandboxEgressEventLine(teardown("revoke"));

    expect(line.description).toContain("not undone");
  });
});

describe("sandboxEgressEventLine: egress.held", () => {
  it("is a notice", () => {
    const line = sandboxEgressEventLine(held(400));

    expect(line.tone).toBe("notice");
    expect(line.headline).toBe("Connection held while waking");
    expect(line.route).toBe("route-3");
    expect(line.reportedBySandbox).toBe(true);
  });

  it("renders sub-second waits in tenths of a second", () => {
    expect(sandboxEgressEventLine(held(400)).description).toContain("0.4 s");
  });

  it("renders waits under two minutes in whole seconds", () => {
    expect(sandboxEgressEventLine(held(12_000)).description).toContain("12 s");
  });

  it("renders waits of two minutes and over in minutes", () => {
    expect(sandboxEgressEventLine(held(180_000)).description).toContain(
      "3 min",
    );
  });
});

describe("sandboxEgressEventLine: egress.unsupported_mode", () => {
  it("names the mode and appends the reason after a colon", () => {
    const line = sandboxEgressEventLine(
      unsupportedMode("password", "use a key instead"),
    );

    expect(line.tone).toBe("refused");
    expect(line.headline).toBe("Mode not supported");
    expect(line.description).toContain("password");
    expect(line.description).toContain(": use a key instead");
    expect(line.route).toBe("route-4");
  });

  it("ends with a full stop when the reason is empty", () => {
    const line = sandboxEgressEventLine(unsupportedMode("password", ""));

    expect(line.description).toContain("password");
    expect(line.description.endsWith(".")).toBe(true);
    expect(line.description).not.toContain(":");
  });

  it("ends with a full stop when the reason is only whitespace", () => {
    const line = sandboxEgressEventLine(unsupportedMode("password", "   "));

    expect(line.description.endsWith(".")).toBe(true);
    expect(line.description).not.toContain(":");
  });
});

describe("sandboxEgressEventLine: emitter-authored text is bounded", () => {
  it("cuts a 300-character host", () => {
    const line = sandboxEgressEventLine(
      refused("grant_missing", LONG_TEXT, false),
    );

    expect(line.description).not.toContain(LONG_TEXT);
    expect(line.description).toContain("…");
  });

  it("cuts a 300-character host on an unknown-code refusal", () => {
    const line = sandboxEgressEventLine(
      refused("ssh_flow_unknown", LONG_TEXT, false),
    );

    expect(line.description).not.toContain(LONG_TEXT);
    expect(line.description).toContain("…");
  });

  it("cuts a 300-character mode", () => {
    const line = sandboxEgressEventLine(unsupportedMode(LONG_TEXT, "reason"));

    expect(line.description).not.toContain(LONG_TEXT);
    expect(line.description).toContain("…");
  });

  it("cuts a 300-character reason", () => {
    const line = sandboxEgressEventLine(unsupportedMode("mode", LONG_TEXT));

    expect(line.description).not.toContain(LONG_TEXT);
    expect(line.description).toContain("…");
  });
});

describe("sandboxCardEgressEventLines", () => {
  it("returns no lines for no events", () => {
    expect(sandboxCardEgressEventLines([])).toEqual([]);
  });

  it("keeps the newest events, newest first, up to the limit", () => {
    const events: SandboxEgressEvent[] = [1, 2, 3, 4, 5, 6, 7, 8].map(
      (n): SandboxEgressEvent => ({ ...teardown("drain"), id: `e${n}` }),
    );

    const lines = sandboxCardEgressEventLines(events);

    expect(lines.length).toBeLessThanOrEqual(SANDBOX_CARD_EGRESS_EVENT_LIMIT);
    expect(lines.map((line) => line.id)).toEqual([
      "e8",
      "e7",
      "e6",
      "e5",
      "e4",
    ]);
  });

  it("returns every event, newest first, when there are fewer than the limit", () => {
    const events: SandboxEgressEvent[] = [
      { ...teardown("drain"), id: "e1" },
      { ...teardown("drain"), id: "e2" },
    ];

    expect(sandboxCardEgressEventLines(events).map((line) => line.id)).toEqual([
      "e2",
      "e1",
    ]);
  });
});
