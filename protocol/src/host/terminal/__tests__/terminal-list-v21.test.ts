/**
 * `terminal.list@2.1` schema + negotiation coverage.
 *
 * Additive `homeCwd` on the major-2 response: non-empty string from a current
 * host, `null` only as the v2.0 → v2.1 upgrade fill (older hosts have no
 * authoritative home path). Request shape is identical to `@2.0`. The major
 * downgrade projects sessions only (strips `homeCwd`) and keeps the
 * independent-scope failure gate from v2.0.
 */
import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  terminalListDowngradeV21ToV10,
  terminalListUpgradeV20ToV21,
} from "@traycer/protocol/host/terminal/contracts";
import {
  listTerminalsResponseSchema,
  listTerminalsResponseSchemaV20,
  listTerminalsResponseSchemaV21,
  type CanonicalTerminalSessionInfo,
} from "@traycer/protocol/host/terminal/unary-schemas";

const V20 = { major: 2, minor: 0 } as const;
const V21 = { major: 2, minor: 1 } as const;

const listRegistry = hostRpcRegistry["terminal.list"];

function epicSession(
  overrides: Partial<CanonicalTerminalSessionInfo>,
): CanonicalTerminalSessionInfo {
  return {
    sessionId: "term-1",
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "/work/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: "Setup: repo",
    activeProcessName: null,
    ...overrides,
  };
}

function independentSession(
  overrides: Partial<CanonicalTerminalSessionInfo>,
): CanonicalTerminalSessionInfo {
  return epicSession({
    sessionId: "term-independent",
    scope: { kind: "independent" },
    ...overrides,
  });
}

describe("listTerminalsResponseSchemaV21", () => {
  it("parses a response with a non-empty home path", () => {
    const fixture = {
      sessions: [epicSession({})],
      homeCwd: "/Users/dev",
    };
    expect(listTerminalsResponseSchemaV21.parse(fixture)).toEqual(fixture);
  });

  it("parses a response with homeCwd: null", () => {
    const fixture = {
      sessions: [epicSession({})],
      homeCwd: null,
    };
    expect(listTerminalsResponseSchemaV21.parse(fixture)).toEqual(fixture);
  });

  it("rejects an empty-string homeCwd", () => {
    expect(
      listTerminalsResponseSchemaV21.safeParse({
        sessions: [epicSession({})],
        homeCwd: "",
      }).success,
    ).toBe(false);
  });

  it("rejects a response missing homeCwd", () => {
    expect(
      listTerminalsResponseSchemaV21.safeParse({
        sessions: [epicSession({})],
      }).success,
    ).toBe(false);
  });
});

describe("terminal.list v2.0 → v2.1 upgrade", () => {
  it("preserves sessions and fills homeCwd: null", () => {
    const sessions = [
      epicSession({ sessionId: "a" }),
      epicSession({ sessionId: "b", title: "other" }),
    ];
    const v20 = listTerminalsResponseSchemaV20.parse({ sessions });
    expect(terminalListUpgradeV20ToV21.upgradeResponse(v20)).toEqual({
      sessions,
      homeCwd: null,
    });
  });

  it("leaves the request identity-mapped", () => {
    const request = { scope: { kind: "epic" as const, epicId: "epic-1" } };
    expect(terminalListUpgradeV20ToV21.upgradeRequest(request)).toEqual(
      request,
    );
  });

  it("upgrades through the host registry minor chain", () => {
    expect(listRegistry[2]?.latestMinor).toBe(1);
    const sessions = [epicSession({})];
    const upgraded = upgradeResponseToVersion(
      listRegistry,
      V20,
      V21,
      listTerminalsResponseSchemaV20.parse({ sessions }),
    );
    expect(upgraded).toEqual({ sessions, homeCwd: null });

    const upgradedRequest = upgradeRequestToVersion(listRegistry, V20, V21, {
      scope: { kind: "independent" as const },
    });
    expect(upgradedRequest).toEqual({ scope: { kind: "independent" } });
  });
});

describe("terminal.list v2.1 → v1.0 downgrade", () => {
  it("strips homeCwd and projects epic-scoped sessions only", () => {
    const sessions = [
      epicSession({ sessionId: "a" }),
      epicSession({ sessionId: "b", title: "other" }),
    ];
    const result = terminalListDowngradeV21ToV10.downgradeResponse({
      sessions,
      homeCwd: "/Users/dev",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        sessions: sessions.map((session) => {
          const { scope, ...rest } = session;
          if (scope.kind !== "epic") {
            throw new Error("expected epic scope in this fixture");
          }
          return { ...rest, epicId: scope.epicId };
        }),
      },
    });
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("homeCwd");
    expect(() => listTerminalsResponseSchema.parse(result.value)).not.toThrow();
  });

  it("fails the whole response when any session is independent-scoped", () => {
    const result = terminalListDowngradeV21ToV10.downgradeResponse({
      sessions: [
        epicSession({ sessionId: "epic-session" }),
        independentSession({}),
      ],
      homeCwd: "/Users/dev",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });

  it("fails independent-scope list requests", () => {
    const result = terminalListDowngradeV21ToV10.downgradeRequest({
      scope: { kind: "independent" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });

  it("downgrades through the host registry major path", () => {
    const sessions = [epicSession({})];
    const downgraded = downgradeResponseAcrossMajors(
      listRegistry,
      2,
      1,
      listTerminalsResponseSchemaV21.parse({
        sessions,
        homeCwd: "/Users/dev",
      }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value).not.toHaveProperty("homeCwd");
    expect(downgraded.value.sessions).toHaveLength(1);
    expect(downgraded.value.sessions[0]).toMatchObject({
      sessionId: "term-1",
      epicId: "epic-1",
    });
  });
});
