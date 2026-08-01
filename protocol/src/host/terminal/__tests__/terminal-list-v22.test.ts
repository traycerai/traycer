import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  terminalListDowngradeV22ToV10,
  terminalListUpgradeV21ToV22,
} from "@traycer/protocol/host/terminal/contracts";
import {
  listTerminalsResponseSchema,
  listTerminalsResponseSchemaV21,
  listTerminalsResponseSchemaV22,
  type CanonicalTerminalSessionInfo,
} from "@traycer/protocol/host/terminal/unary-schemas";

const V21 = { major: 2, minor: 1 } as const;
const V22 = { major: 2, minor: 2 } as const;
const listRegistry = hostRpcRegistry["terminal.list"];

function session(): CanonicalTerminalSessionInfo {
  return {
    sessionId: "term-1",
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "/work/launch",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: null,
    activeProcessName: null,
  };
}

describe("terminal.list@2.2 currentCwd", () => {
  it("requires the current directory field", () => {
    const base = session();
    expect(
      listTerminalsResponseSchemaV22.safeParse({
        sessions: [{ ...base, currentCwd: "/work/live" }],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(true);
    expect(
      listTerminalsResponseSchemaV22.safeParse({
        sessions: [{ ...base, currentCwd: "" }],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(true);
    expect(
      listTerminalsResponseSchemaV22.safeParse({
        sessions: [base],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(false);
  });

  it("uses launch cwd when upgrading a v2.1 host", () => {
    const base = session();
    const response = listTerminalsResponseSchemaV21.parse({
      sessions: [base],
      homeCwd: "/Users/dev",
    });
    expect(terminalListUpgradeV21ToV22.upgradeResponse(response)).toEqual({
      sessions: [{ ...base, currentCwd: base.cwd }],
      homeCwd: "/Users/dev",
    });
    expect(
      upgradeResponseToVersion(listRegistry, V21, V22, response),
    ).toEqual({
      sessions: [{ ...base, currentCwd: base.cwd }],
      homeCwd: "/Users/dev",
    });
  });

  it("preserves an empty launch cwd from a legacy v2.1 host", () => {
    const base = { ...session(), cwd: "" };
    const response = listTerminalsResponseSchemaV21.parse({
      sessions: [base],
      homeCwd: "/Users/dev",
    });

    const upgraded = upgradeResponseToVersion(listRegistry, V21, V22, response);

    expect(upgraded).toEqual({
      sessions: [{ ...base, currentCwd: "" }],
      homeCwd: "/Users/dev",
    });
    expect(() => listTerminalsResponseSchemaV22.parse(upgraded)).not.toThrow();
  });

  it("strips currentCwd when downgrading to v1.0", () => {
    const base = session();
    const response = listTerminalsResponseSchemaV22.parse({
      sessions: [{ ...base, currentCwd: "/work/live" }],
      homeCwd: "/Users/dev",
    });
    const direct = terminalListDowngradeV22ToV10.downgradeResponse(response);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value.sessions[0]).not.toHaveProperty("currentCwd");
    expect(() => listTerminalsResponseSchema.parse(direct.value)).not.toThrow();

    const acrossMajors = downgradeResponseAcrossMajors(
      listRegistry,
      2,
      1,
      response,
    );
    expect(acrossMajors.ok).toBe(true);
    if (!acrossMajors.ok) return;
    expect(acrossMajors.value.sessions[0]).not.toHaveProperty("currentCwd");
  });
});
