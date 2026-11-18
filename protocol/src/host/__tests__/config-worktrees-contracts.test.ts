import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  configWorktreesGetV10,
  configWorktreesSetV10,
} from "@traycer/protocol/host/config/contracts";

/**
 * `config.worktrees.*` is the machine-user-global policy for worktrees agents
 * create (`allow` | `ask` | `never`). It is registered exactly like
 * `config.browser.*` - one v1.0 line, no upgrade paths, and
 * `degrade: { kind: "unsupported" }` so a host that predates the policy reports
 * the method as missing rather than answering for it.
 */
describe("config.worktrees contracts", () => {
  it("registers get and set at v1.0 with the unsupported degrade", () => {
    for (const method of [
      "config.worktrees.get",
      "config.worktrees.set",
    ] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
    expect(
      hostRpcRegistry["config.worktrees.get"][1].versions[0].contract,
    ).toBe(configWorktreesGetV10);
    expect(
      hostRpcRegistry["config.worktrees.set"][1].versions[0].contract,
    ).toBe(configWorktreesSetV10);
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
});
