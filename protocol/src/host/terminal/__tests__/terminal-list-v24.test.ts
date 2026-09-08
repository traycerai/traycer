/**
 * `terminal.list@2.4` schema + negotiation coverage (D19/D21, critique M14).
 *
 * Additive `spawnConfigRevision`/`restartRequired` on every session. A v2.3
 * host upgraded to v2.4 fills `spawnConfigRevision: null, restartRequired:
 * false` ("old host never had profile-bound spawn config").
 */
import { describe, expect, it } from "vitest";
import { upgradeResponseToVersion } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { terminalListUpgradeV23ToV24 } from "@traycer/protocol/host/terminal/contracts";
import {
  listTerminalsResponseSchemaV23,
  listTerminalsResponseSchemaV24,
  type CanonicalTerminalSessionInfoWithLifecycleOwner,
} from "@traycer/protocol/host/terminal/unary-schemas";

const V23 = { major: 2, minor: 3 } as const;
const V24 = { major: 2, minor: 4 } as const;
const listRegistry = hostRpcRegistry["terminal.list"];

function session(): CanonicalTerminalSessionInfoWithLifecycleOwner {
  return {
    sessionId: "term-1",
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "/work/launch",
    currentCwd: "/work/live",
    lifecycleOwner: "manager",
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

describe("terminal.list@2.4 spawnConfigRevision/restartRequired", () => {
  it("requires both fields", () => {
    const base = session();
    expect(
      listTerminalsResponseSchemaV24.safeParse({
        sessions: [
          { ...base, spawnConfigRevision: "rev-1", restartRequired: true },
        ],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(true);
    expect(
      listTerminalsResponseSchemaV24.safeParse({
        sessions: [
          { ...base, spawnConfigRevision: null, restartRequired: false },
        ],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(true);
    expect(
      listTerminalsResponseSchemaV24.safeParse({
        sessions: [base],
        homeCwd: "/Users/dev",
      }).success,
    ).toBe(false);
  });

  it("2.3 -> 2.4 upgrade fills spawnConfigRevision: null, restartRequired: false", () => {
    const base = session();
    const response = listTerminalsResponseSchemaV23.parse({
      sessions: [base],
      homeCwd: "/Users/dev",
    });
    expect(terminalListUpgradeV23ToV24.upgradeResponse(response)).toEqual({
      sessions: [
        { ...base, spawnConfigRevision: null, restartRequired: false },
      ],
      homeCwd: "/Users/dev",
    });
    expect(upgradeResponseToVersion(listRegistry, V23, V24, response)).toEqual({
      sessions: [
        { ...base, spawnConfigRevision: null, restartRequired: false },
      ],
      homeCwd: "/Users/dev",
    });
  });
});
