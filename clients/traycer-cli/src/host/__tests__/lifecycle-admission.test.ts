import { describe, expect, it } from "vitest";
import type { DesktopPresence } from "@traycer/protocol/config/desktop-presence";
import {
  HOST_LIFECYCLE_MODES,
  type HostLifecycleMode,
  type HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import {
  admitSupervisorLifecycle,
  decideUnattendedStart,
  type SupervisorLifecycleGateDeps,
  type SupervisorLifecycleGateInput,
} from "../lifecycle-admission";
import type {
  DesktopPresenceLiveness,
  LifecycleRecordRead,
} from "../lifecycle-files";
import type { HostStartAdoptionConsumeResult } from "../host-start-adoption";

const ENVIRONMENT = "test-env";
const FIXED_NOW = "FIXED_TS";

const NON_BACKGROUND_MODES: readonly HostLifecycleMode[] =
  HOST_LIFECYCLE_MODES.filter((mode) => mode !== "background");

function validPolicy(
  mode: HostLifecycleMode,
): LifecycleRecordRead<HostLifecyclePolicy> {
  return {
    kind: "valid",
    record: {
      v: 1,
      rev: 1,
      mode,
      updatedAt: "2024-01-01T00:00:00.000Z",
      updatedBy: "cli",
    },
  };
}

function desktopPresenceRecord(): DesktopPresence {
  return {
    v: 1,
    pid: 4242,
    processStartIdentity: "some-start-identity",
    onExit: "keep",
    policyRev: 1,
    writtenAt: "2024-01-01T00:00:00.000Z",
  };
}

/**
 * A deps double that records which functions were called, in order, into
 * `calls`, and returns whatever the test configures.
 */
function makeDeps(options: {
  readonly calls: string[];
  readonly policy: LifecycleRecordRead<HostLifecyclePolicy>;
  readonly presence: LifecycleRecordRead<DesktopPresence>;
  readonly liveness: DesktopPresenceLiveness;
  readonly consumeResult: HostStartAdoptionConsumeResult;
}): SupervisorLifecycleGateDeps {
  const { calls, policy, presence, liveness, consumeResult } = options;
  return {
    readPolicy: () => {
      calls.push("readPolicy");
      return Promise.resolve(policy);
    },
    readPresence: () => {
      calls.push("readPresence");
      return Promise.resolve(presence);
    },
    probePresence: () => {
      calls.push("probePresence");
      return Promise.resolve(liveness);
    },
    consumeAdoption: () => {
      calls.push("consumeAdoption");
      return Promise.resolve(consumeResult);
    },
    now: () => {
      calls.push("now");
      return FIXED_NOW;
    },
  };
}

function serviceLaunchInput(environment: string): SupervisorLifecycleGateInput {
  return {
    environment,
    serviceLaunch: { serviceLabel: "ai.traycer.host", adoptionNonce: "nonce" },
  };
}

describe("decideUnattendedStart", () => {
  it("always runs under background, for every presence value", () => {
    const presences: ReadonlyArray<DesktopPresenceLiveness | null> = [
      null,
      "dead",
      "alive",
      "indeterminate",
    ];
    for (const presence of presences) {
      expect(decideUnattendedStart("background", presence)).toBe("run");
    }
  });

  for (const mode of NON_BACKGROUND_MODES) {
    it(`parks under ${mode} when presence is null`, () => {
      expect(decideUnattendedStart(mode, null)).toBe("park");
    });

    it(`parks under ${mode} when presence is dead`, () => {
      expect(decideUnattendedStart(mode, "dead")).toBe("park");
    });

    it(`runs under ${mode} when presence is alive`, () => {
      expect(decideUnattendedStart(mode, "alive")).toBe("run");
    });

    it(`runs under ${mode} when presence is indeterminate`, () => {
      expect(decideUnattendedStart(mode, "indeterminate")).toBe("run");
    });
  }
});

describe("admitSupervisorLifecycle", () => {
  it("runs with no consumption when serviceLaunch is null", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      calls,
      policy: validPolicy("linked"),
      presence: { kind: "absent" },
      liveness: "alive",
      consumeResult: { kind: "absent" },
    });
    const result = await admitSupervisorLifecycle(
      { environment: ENVIRONMENT, serviceLaunch: null },
      deps,
    );
    expect(result).toEqual({ kind: "run", consumed: null, presence: null });
    expect(calls).toEqual([]);
  });

  const backgroundPolicyReads: ReadonlyArray<
    [string, LifecycleRecordRead<HostLifecyclePolicy>]
  > = [
    ["absent", { kind: "absent" }],
    ["invalid", { kind: "invalid" }],
    ["unreadable", { kind: "unreadable", cause: "boom" }],
    ["valid background", validPolicy("background")],
  ];

  for (const [label, policyRead] of backgroundPolicyReads) {
    it(`runs with consumed:null and never consumes when policy read is ${label}`, async () => {
      const calls: string[] = [];
      const deps = makeDeps({
        calls,
        policy: policyRead,
        presence: { kind: "absent" },
        liveness: "alive",
        consumeResult: { kind: "absent" },
      });
      const result = await admitSupervisorLifecycle(
        serviceLaunchInput(ENVIRONMENT),
        deps,
      );
      expect(result).toEqual({ kind: "run", consumed: null, presence: null });
      expect(calls).toContain("readPolicy");
      expect(calls).not.toContain("consumeAdoption");
      expect(calls).not.toContain("readPresence");
      expect(calls).not.toContain("probePresence");
    });
  }

  const grantOrigins: ReadonlyArray<
    "desktop" | "terminal" | "maintenance" | null
  > = ["desktop", "terminal", "maintenance", null];

  for (const origin of grantOrigins) {
    it(`runs on a grant with origin ${String(origin)} and never reads presence`, async () => {
      const calls: string[] = [];
      const consumeResult: HostStartAdoptionConsumeResult = {
        kind: "grant",
        grant: {
          origin,
          acknowledgeSpawn: () => Promise.resolve(true),
          abandon: () => Promise.resolve(),
        },
      };
      const deps = makeDeps({
        calls,
        policy: validPolicy("linked"),
        presence: { kind: "absent" },
        liveness: "alive",
        consumeResult,
      });
      const result = await admitSupervisorLifecycle(
        serviceLaunchInput(ENVIRONMENT),
        deps,
      );
      expect(result).toEqual({
        kind: "run",
        consumed: consumeResult,
        presence: null,
      });
      expect(calls).toContain("consumeAdoption");
      expect(calls).not.toContain("readPresence");
    });
  }

  const nonAbsentConsumeResults: ReadonlyArray<
    [string, HostStartAdoptionConsumeResult]
  > = [
    ["lost", { kind: "lost", reason: "another child claimed it" }],
    ["error", { kind: "error", reason: "I/O failure" }],
    ["refused", { kind: "refused", reason: "no live parent" }],
  ];

  for (const [label, consumeResult] of nonAbsentConsumeResults) {
    it(`runs on a ${label} consume result and never reads presence`, async () => {
      const calls: string[] = [];
      const deps = makeDeps({
        calls,
        policy: validPolicy("ask"),
        presence: { kind: "absent" },
        liveness: "alive",
        consumeResult,
      });
      const result = await admitSupervisorLifecycle(
        serviceLaunchInput(ENVIRONMENT),
        deps,
      );
      expect(result).toEqual({
        kind: "run",
        consumed: consumeResult,
        presence: null,
      });
      expect(calls).toContain("consumeAdoption");
      expect(calls).not.toContain("readPresence");
    });
  }

  it("consumes adoption before reading presence, on an absent consume result", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      calls,
      policy: validPolicy("linked"),
      presence: { kind: "valid", record: desktopPresenceRecord() },
      liveness: "alive",
      consumeResult: { kind: "absent" },
    });
    await admitSupervisorLifecycle(serviceLaunchInput(ENVIRONMENT), deps);
    const consumeIndex = calls.indexOf("consumeAdoption");
    const presenceIndex = calls.indexOf("readPresence");
    expect(consumeIndex).toBeGreaterThanOrEqual(0);
    expect(presenceIndex).toBeGreaterThanOrEqual(0);
    expect(consumeIndex).toBeLessThan(presenceIndex);
  });

  const parkingPresenceReads: ReadonlyArray<
    [string, LifecycleRecordRead<DesktopPresence>]
  > = [
    ["dead liveness", { kind: "valid", record: desktopPresenceRecord() }],
    ["absent", { kind: "absent" }],
    ["invalid", { kind: "invalid" }],
    ["unreadable", { kind: "unreadable", cause: "boom" }],
  ];

  for (const [label, presenceRead] of parkingPresenceReads) {
    it(`parks when consume is absent and presence read is ${label}`, async () => {
      const calls: string[] = [];
      const deps = makeDeps({
        calls,
        policy: validPolicy("stop-if-idle"),
        presence: presenceRead,
        liveness: "dead",
        consumeResult: { kind: "absent" },
      });
      const result = await admitSupervisorLifecycle(
        serviceLaunchInput(ENVIRONMENT),
        deps,
      );
      expect(result).toEqual({ kind: "park", mode: "stop-if-idle" });
    });
  }

  const runningPresenceReads: ReadonlyArray<[string, DesktopPresenceLiveness]> =
    [
      ["alive", "alive"],
      ["indeterminate", "indeterminate"],
    ];

  for (const [label, liveness] of runningPresenceReads) {
    it(`runs when consume is absent and presence liveness is ${label}`, async () => {
      const calls: string[] = [];
      const record = desktopPresenceRecord();
      const deps = makeDeps({
        calls,
        policy: validPolicy("linked"),
        presence: { kind: "valid", record },
        liveness,
        consumeResult: { kind: "absent" },
      });
      const result = await admitSupervisorLifecycle(
        serviceLaunchInput(ENVIRONMENT),
        deps,
      );
      if (result.kind !== "run") {
        throw new Error("expected a run result");
      }
      expect(result.consumed).toEqual({ kind: "absent" });
      expect(result.presence).toEqual({
        pid: record.pid,
        onExit: record.onExit,
        liveness,
        observedAt: FIXED_NOW,
      });
    });
  }
});
