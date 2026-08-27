/**
 * `terminal.list@2.3` schema + negotiation coverage.
 *
 * Additive `lifecycleOwner` on every session. A v2.2 host fills `registry`
 * so a capable client fail-closes missing origin. Major downgrade strips the
 * field with `currentCwd`.
 */
import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  terminalListDowngradeV23ToV10,
  terminalListUpgradeV22ToV23,
} from "@traycer/protocol/host/terminal/contracts";
import {
  listTerminalsResponseSchema,
  listTerminalsResponseSchemaV22,
  listTerminalsResponseSchemaV23,
  type CanonicalTerminalSessionInfoWithCurrentCwd,
} from "@traycer/protocol/host/terminal/unary-schemas";

const V22 = { major: 2, minor: 2 } as const;
const V23 = { major: 2, minor: 3 } as const;
const listRegistry = hostRpcRegistry["terminal.list"];

function session(): CanonicalTerminalSessionInfoWithCurrentCwd {
  return {
    sessionId: "term-1",
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "/work/launch",
    currentCwd: "/work/live",
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

describe("terminal.list@2.3 lifecycleOwner", () => {
  it("requires an exhaustive lifetime-owner discriminator", () => {
    const base = session();
    expect(
      listTerminalsResponseSchemaV23.safeParse({
        sessions: [{ ...base, lifecycleOwner: "manager" }],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(true);
    expect(
      listTerminalsResponseSchemaV23.safeParse({
        sessions: [{ ...base, lifecycleOwner: "registry" }],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(true);
    expect(
      listTerminalsResponseSchemaV23.safeParse({
        sessions: [base],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(false);
    expect(
      listTerminalsResponseSchemaV23.safeParse({
        sessions: [{ ...base, lifecycleOwner: "setup" }],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(false);
  });

  it("fail-closes a v2.2 host as registry-owned", () => {
    const base = session();
    const response = listTerminalsResponseSchemaV22.parse({
      sessions: [base],
      homeCwd: "/Users/dev",
    });
    expect(terminalListUpgradeV22ToV23.upgradeResponse(response)).toEqual({
      sessions: [{ ...base, lifecycleOwner: "registry" }],
      homeCwd: "/Users/dev",
    });
    expect(upgradeResponseToVersion(listRegistry, V22, V23, response)).toEqual({
      sessions: [{ ...base, lifecycleOwner: "registry" }],
      homeCwd: "/Users/dev",
    });
  });

  it("strips lifecycleOwner when downgrading to v1.0", () => {
    const base = session();
    const response = listTerminalsResponseSchemaV23.parse({
      sessions: [{ ...base, lifecycleOwner: "manager" }],
      homeCwd: "/Users/dev",
    });
    const direct = terminalListDowngradeV23ToV10.downgradeResponse(response);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value.sessions[0]).not.toHaveProperty("lifecycleOwner");
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
    expect(acrossMajors.value.sessions[0]).not.toHaveProperty("lifecycleOwner");
  });
});
