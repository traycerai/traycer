import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  configWorktreesGetUpgradeV10ToV11,
  configWorktreesGetV10,
  configWorktreesGetV11,
  configWorktreesSetUpgradeV10ToV11,
  configWorktreesSetV10,
  configWorktreesSetV11,
} from "@traycer/protocol/host/config/contracts";

/**
 * `config.worktrees.*` is the machine-user-global worktree settings: the policy
 * for worktrees agents create (`allow` | `ask` | `never`), and from v1.1
 * `recoverMissing`. v1.0 carries the policy alone; v1.1 adds the second setting
 * with an upgrade path per method. `degrade: { kind: "unsupported" }` so a host
 * that predates the methods reports them as missing rather than answering.
 */
describe("config.worktrees contracts", () => {
  it("registers get and set at v1.0 and v1.1 with the unsupported degrade", () => {
    for (const method of [
      "config.worktrees.get",
      "config.worktrees.set",
    ] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(1);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
    const get = hostRpcRegistry["config.worktrees.get"][1].versions;
    expect(get[0].contract).toBe(configWorktreesGetV10);
    expect(get[1].contract).toBe(configWorktreesGetV11);
    expect(get[1].upgradeFromPreviousVersion).toBe(
      configWorktreesGetUpgradeV10ToV11,
    );
    const set = hostRpcRegistry["config.worktrees.set"][1].versions;
    expect(set[0].contract).toBe(configWorktreesSetV10);
    expect(set[1].contract).toBe(configWorktreesSetV11);
    expect(set[1].upgradeFromPreviousVersion).toBe(
      configWorktreesSetUpgradeV10ToV11,
    );
  });

  it("names the methods and versions on the contracts themselves", () => {
    expect(configWorktreesGetV10.method).toBe("config.worktrees.get");
    expect(configWorktreesSetV10.method).toBe("config.worktrees.set");
    expect(configWorktreesGetV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(configWorktreesSetV10.schemaVersion).toEqual({ major: 1, minor: 0 });
  });

  it("carries an empty get request", () => {
    expect(configWorktreesGetV10.requestSchema.parse({})).toEqual({});
  });

  it("accepts each of the three policy values in every payload", () => {
    for (const agentCreate of ["allow", "ask", "never"] as const) {
      expect(
        configWorktreesGetV10.responseSchema.parse({ agentCreate }),
      ).toEqual({ agentCreate });
      expect(
        configWorktreesSetV10.requestSchema.parse({ agentCreate }),
      ).toEqual({ agentCreate });
      expect(
        configWorktreesSetV10.responseSchema.parse({ agentCreate }),
      ).toEqual({ agentCreate });
    }
  });

  it("rejects any other policy value", () => {
    for (const agentCreate of [
      "sometimes",
      "",
      "Allow",
      "NEVER",
      1,
      null,
      true,
    ]) {
      expect(() =>
        configWorktreesSetV10.requestSchema.parse({ agentCreate }),
      ).toThrow();
      expect(() =>
        configWorktreesGetV10.responseSchema.parse({ agentCreate }),
      ).toThrow();
      expect(() =>
        configWorktreesSetV10.responseSchema.parse({ agentCreate }),
      ).toThrow();
    }
  });

  it("carries no implicit default on the wire", () => {
    // The host always states the value it resolved, so a missing key is a
    // malformed peer, not "use the default".
    expect(() => configWorktreesSetV10.requestSchema.parse({})).toThrow();
    expect(() => configWorktreesGetV10.responseSchema.parse({})).toThrow();
    expect(() => configWorktreesSetV10.responseSchema.parse({})).toThrow();
  });

  it("upgrades a 1.0 get response to a host that does not recover", () => {
    expect(
      configWorktreesGetUpgradeV10ToV11.upgradeResponse({
        agentCreate: "ask",
      }),
    ).toEqual({ agentCreate: "ask", recoverMissing: false });
  });

  it("upgrades a 1.0 set body to one that leaves recoverMissing alone", () => {
    expect(
      configWorktreesSetUpgradeV10ToV11.upgradeRequest({
        agentCreate: "never",
      }),
    ).toEqual({ agentCreate: "never", recoverMissing: null });
    expect(
      configWorktreesSetUpgradeV10ToV11.upgradeResponse({
        agentCreate: "never",
      }),
    ).toEqual({ agentCreate: "never", recoverMissing: false });
  });

  it("accepts a 1.1 set that writes one setting and leaves the other null", () => {
    expect(
      configWorktreesSetV11.requestSchema.parse({
        agentCreate: null,
        recoverMissing: true,
      }),
    ).toEqual({ agentCreate: null, recoverMissing: true });
    expect(
      configWorktreesSetV11.requestSchema.parse({
        agentCreate: "ask",
        recoverMissing: null,
      }),
    ).toEqual({ agentCreate: "ask", recoverMissing: null });
  });

  it("rejects a 1.1 set with a non-boolean recoverMissing or a missing key", () => {
    for (const recoverMissing of ["true", 1, undefined]) {
      expect(() =>
        configWorktreesSetV11.requestSchema.parse({
          agentCreate: null,
          recoverMissing,
        }),
      ).toThrow();
    }
    expect(() =>
      configWorktreesSetV11.requestSchema.parse({ agentCreate: "allow" }),
    ).toThrow();
  });

  it("requires recoverMissing in a 1.1 response and drops it for a 1.0 reader", () => {
    const body = { agentCreate: "allow", recoverMissing: true };
    expect(configWorktreesGetV11.responseSchema.parse(body)).toEqual(body);
    expect(() =>
      configWorktreesGetV11.responseSchema.parse({ agentCreate: "allow" }),
    ).toThrow();
    expect(configWorktreesGetV10.responseSchema.parse(body)).toEqual({
      agentCreate: "allow",
    });
    expect(configWorktreesSetV10.responseSchema.parse(body)).toEqual({
      agentCreate: "allow",
    });
  });
});
