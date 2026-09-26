/**
 * Compat matrix for the busy breakdown split introduced at `host.status@1.6`
 * / `host.restart@1.3`: {@link hostBusyBreakdownV1Schema} stays frozen and
 * every released line below the new minors keeps parsing exactly what it did
 * before, {@link hostBusyBreakdownV2Schema} is required (not optional) once a
 * peer opts into the new minor, and no upgrade path ever turns "did not
 * report" into a fabricated `0`.
 */
import { describe, expect, it } from "vitest";
import { upgradeResponseToVersion } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  hostBusyBreakdownV1Schema,
  hostStatusUpgradeV15ToV16,
  hostStatusV12,
  hostStatusV13,
  hostStatusV14,
  hostStatusV15,
  hostStatusV16,
  type HostBusyBreakdownV2,
  type HostStatusUpdateOperationV2,
} from "@traycer/protocol/host/status/contracts";
import {
  hostRestartResponseSchema,
  hostRestartResponseV13Schema,
} from "@traycer/protocol/host/restart/schemas";
import { hostRestartUpgradeV12ToV13 } from "@traycer/protocol/host/restart/contracts";
import { hostRuntimeStatusAwarenessSchema } from "@traycer/protocol/host/notifications/subscribe";

const V12 = { major: 1, minor: 2 } as const;
const V13 = { major: 1, minor: 3 } as const;
const V16 = { major: 1, minor: 6 } as const;

const BUSY_BREAKDOWN_V1 = {
  workingAgents: 2,
  activeTerminalAgents: 1,
  busyTerminals: 0,
};

const BUSY_BREAKDOWN_V2: HostBusyBreakdownV2 = {
  ...BUSY_BREAKDOWN_V1,
  shells: 3,
  scheduledWakes: 1,
};

/** A V2-shaped breakdown missing the `shells` key entirely (not `null`). */
const BREAKDOWN_WITHOUT_SHELLS = {
  ...BUSY_BREAKDOWN_V1,
  scheduledWakes: BUSY_BREAKDOWN_V2.scheduledWakes,
};

/** A V2-shaped breakdown missing the `scheduledWakes` key entirely (not `null`). */
const BREAKDOWN_WITHOUT_SCHEDULED_WAKES = {
  ...BUSY_BREAKDOWN_V1,
  shells: BUSY_BREAKDOWN_V2.shells,
};

const ATTEMPT_ARM_BASE = {
  kind: "attempt" as const,
  attemptId: "attempt-1",
  generation: 1,
  sequence: 1,
  targetVersion: "1.4.0",
  trigger: "manual" as const,
  phase: "downloading" as const,
  execution: "active" as const,
  continuation: null,
  progress: null,
  liveness: "active" as const,
  livenessCause: null,
  busySessionCount: 3,
  error: null,
};

const ATTEMPT_ARM_V2: HostStatusUpdateOperationV2 = {
  ...ATTEMPT_ARM_BASE,
  busyBreakdown: BUSY_BREAKDOWN_V2,
};

const ATTEMPT_ARM_V1_EXPECTED = {
  ...ATTEMPT_ARM_BASE,
  busyBreakdown: BUSY_BREAKDOWN_V1,
};

const BASE_RESPONSE = {
  ready: true,
  hostVersion: "1.4.0",
  protocolVersion: { major: 1, minor: 6 },
  busy: true,
  busySessionCount: 3,
  updateProgress: null,
};

/** Every field a full `host.status@1.6` response carries, both depths at V2. */
const FULL_V16_RESPONSE = {
  ...BASE_RESPONSE,
  busyBreakdown: BUSY_BREAKDOWN_V2,
  updateOperation: ATTEMPT_ARM_V2,
  updateTransaction: { recordSchemaVersion: 2, authority: "attempt" as const },
  storeFormats: {
    chatDb: {
      current: 9,
      onDiskMax: 9,
      epicCount: 2,
      survey: "complete" as const,
    },
  },
  install: {
    source: "registry" as const,
    version: "1.4.0",
    declaredFormats: null,
  },
};

describe("hostBusyBreakdownV1Schema strips shells/scheduledWakes from a V2 value", () => {
  it("parses a V2 breakdown down to the three V1 fields", () => {
    const parsed = hostBusyBreakdownV1Schema.parse(BUSY_BREAKDOWN_V2);
    expect(parsed).toEqual(BUSY_BREAKDOWN_V1);
    expect(parsed).not.toHaveProperty("shells");
    expect(parsed).not.toHaveProperty("scheduledWakes");
  });
});

describe("host.status — V1 stays frozen at every released line", () => {
  it("host.status@1.2 drops shells/scheduledWakes from the top-level breakdown", () => {
    const parsed = hostStatusV12.responseSchema.parse(FULL_V16_RESPONSE);
    expect(parsed).toEqual({
      ...BASE_RESPONSE,
      busyBreakdown: BUSY_BREAKDOWN_V1,
    });
  });

  it("host.status@1.3 drops shells/scheduledWakes at both the top level and the nested updateOperation attempt arm", () => {
    const parsed = hostStatusV13.responseSchema.parse(FULL_V16_RESPONSE);
    expect(parsed).toEqual({
      ...BASE_RESPONSE,
      busyBreakdown: BUSY_BREAKDOWN_V1,
      updateOperation: ATTEMPT_ARM_V1_EXPECTED,
      updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
    });
  });

  it("host.status@1.4 drops the two fields at both depths", () => {
    const parsed = hostStatusV14.responseSchema.parse(FULL_V16_RESPONSE);
    expect(parsed).toEqual({
      ...BASE_RESPONSE,
      busyBreakdown: BUSY_BREAKDOWN_V1,
      updateOperation: ATTEMPT_ARM_V1_EXPECTED,
      updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
      storeFormats: FULL_V16_RESPONSE.storeFormats,
    });
  });

  it("host.status@1.5 drops the two fields at both depths, the way a v1.5 response you would build by hand looks", () => {
    const parsed = hostStatusV15.responseSchema.parse(FULL_V16_RESPONSE);
    const handBuiltV15Response = {
      ...BASE_RESPONSE,
      busyBreakdown: BUSY_BREAKDOWN_V1,
      updateOperation: ATTEMPT_ARM_V1_EXPECTED,
      updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
      storeFormats: FULL_V16_RESPONSE.storeFormats,
      install: FULL_V16_RESPONSE.install,
    };
    expect(parsed).toEqual(handBuiltV15Response);
    expect(parsed.busyBreakdown).not.toHaveProperty("shells");
    expect(parsed.busyBreakdown).not.toHaveProperty("scheduledWakes");
    if (parsed.updateOperation?.kind === "attempt") {
      expect(parsed.updateOperation.busyBreakdown).not.toHaveProperty("shells");
      expect(parsed.updateOperation.busyBreakdown).not.toHaveProperty(
        "scheduledWakes",
      );
    }
  });
});

describe("host.restart — V1 stays frozen at @1.2", () => {
  it("a host.restart@1.3 busy response drops shells/scheduledWakes through hostRestartResponseSchema", () => {
    const v13BusyResponse = {
      outcome: "busy" as const,
      verdict: {
        busySessionCount: 3,
        blockers: { workingAgents: true, runningTerminals: false },
        busyBreakdown: BUSY_BREAKDOWN_V2,
      },
    };
    const parsed = hostRestartResponseSchema.parse(v13BusyResponse);
    expect(parsed).toEqual({
      outcome: "busy",
      verdict: {
        busySessionCount: 3,
        blockers: { workingAgents: true, runningTerminals: false },
        busyBreakdown: BUSY_BREAKDOWN_V1,
      },
    });
  });
});

describe("host.status@1.6 requires the V2 shape on a non-null breakdown", () => {
  it("rejects a top-level breakdown missing shells", () => {
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        busyBreakdown: BREAKDOWN_WITHOUT_SHELLS,
      }).success,
    ).toBe(false);
  });

  it("rejects a top-level breakdown missing scheduledWakes", () => {
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        busyBreakdown: BREAKDOWN_WITHOUT_SCHEDULED_WAKES,
      }).success,
    ).toBe(false);
  });

  it("rejects the nested updateOperation attempt breakdown missing shells", () => {
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        updateOperation: {
          ...ATTEMPT_ARM_V2,
          busyBreakdown: BREAKDOWN_WITHOUT_SHELLS,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects the nested updateOperation attempt breakdown missing scheduledWakes", () => {
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        updateOperation: {
          ...ATTEMPT_ARM_V2,
          busyBreakdown: BREAKDOWN_WITHOUT_SCHEDULED_WAKES,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts shells: null and scheduledWakes: null at the top level", () => {
    const parsed = hostStatusV16.responseSchema.parse({
      ...FULL_V16_RESPONSE,
      busyBreakdown: {
        ...BUSY_BREAKDOWN_V1,
        shells: null,
        scheduledWakes: null,
      },
    });
    expect(parsed.busyBreakdown).toEqual({
      ...BUSY_BREAKDOWN_V1,
      shells: null,
      scheduledWakes: null,
    });
  });

  it("accepts non-negative integers for shells and scheduledWakes", () => {
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        busyBreakdown: { ...BUSY_BREAKDOWN_V1, shells: 0, scheduledWakes: 5 },
      }).success,
    ).toBe(true);
  });

  it("rejects a negative shells or scheduledWakes count", () => {
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        busyBreakdown: { ...BUSY_BREAKDOWN_V1, shells: -1, scheduledWakes: 0 },
      }).success,
    ).toBe(false);
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        busyBreakdown: { ...BUSY_BREAKDOWN_V1, shells: 0, scheduledWakes: -1 },
      }).success,
    ).toBe(false);
  });

  it("rejects a non-integer shells or scheduledWakes count", () => {
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        busyBreakdown: { ...BUSY_BREAKDOWN_V1, shells: 1.5, scheduledWakes: 0 },
      }).success,
    ).toBe(false);
    expect(
      hostStatusV16.responseSchema.safeParse({
        ...FULL_V16_RESPONSE,
        busyBreakdown: { ...BUSY_BREAKDOWN_V1, shells: 0, scheduledWakes: 1.5 },
      }).success,
    ).toBe(false);
  });
});

describe("host.restart@1.3 requires the V2 shape on a non-null breakdown", () => {
  const busyResponseWithBreakdown = (
    busyBreakdown: Record<string, unknown>,
  ) => ({
    outcome: "busy" as const,
    verdict: {
      busySessionCount: 3,
      blockers: { workingAgents: true, runningTerminals: false },
      busyBreakdown,
    },
  });

  it("rejects a breakdown missing shells", () => {
    expect(
      hostRestartResponseV13Schema.safeParse(
        busyResponseWithBreakdown(BREAKDOWN_WITHOUT_SHELLS),
      ).success,
    ).toBe(false);
  });

  it("rejects a breakdown missing scheduledWakes", () => {
    expect(
      hostRestartResponseV13Schema.safeParse(
        busyResponseWithBreakdown(BREAKDOWN_WITHOUT_SCHEDULED_WAKES),
      ).success,
    ).toBe(false);
  });

  it("accepts shells: null and scheduledWakes: null", () => {
    const parsed = hostRestartResponseV13Schema.parse(
      busyResponseWithBreakdown({
        ...BUSY_BREAKDOWN_V1,
        shells: null,
        scheduledWakes: null,
      }),
    );
    if (parsed.outcome !== "busy") throw new Error("expected a busy outcome");
    expect(parsed.verdict.busyBreakdown).toEqual({
      ...BUSY_BREAKDOWN_V1,
      shells: null,
      scheduledWakes: null,
    });
  });

  it("accepts non-negative integers and rejects negatives / non-integers", () => {
    expect(
      hostRestartResponseV13Schema.safeParse(
        busyResponseWithBreakdown({
          ...BUSY_BREAKDOWN_V1,
          shells: 0,
          scheduledWakes: 5,
        }),
      ).success,
    ).toBe(true);
    expect(
      hostRestartResponseV13Schema.safeParse(
        busyResponseWithBreakdown({
          ...BUSY_BREAKDOWN_V1,
          shells: -1,
          scheduledWakes: 0,
        }),
      ).success,
    ).toBe(false);
    expect(
      hostRestartResponseV13Schema.safeParse(
        busyResponseWithBreakdown({
          ...BUSY_BREAKDOWN_V1,
          shells: 0,
          scheduledWakes: 1.5,
        }),
      ).success,
    ).toBe(false);
  });
});

describe("hostStatusUpgradeV15ToV16.upgradeResponse never fabricates zero", () => {
  const V15_BASE = {
    ...BASE_RESPONSE,
    storeFormats: FULL_V16_RESPONSE.storeFormats,
    install: FULL_V16_RESPONSE.install,
  };

  it("turns a non-null breakdown into V2 with shells: null, scheduledWakes: null, keeping the three counts", () => {
    const v15Response = hostStatusV15.responseSchema.parse({
      ...V15_BASE,
      busyBreakdown: BUSY_BREAKDOWN_V1,
      updateOperation: null,
      updateTransaction: null,
    });
    const upgraded = hostStatusUpgradeV15ToV16.upgradeResponse(v15Response);
    expect(upgraded.busyBreakdown).toEqual({
      ...BUSY_BREAKDOWN_V1,
      shells: null,
      scheduledWakes: null,
    });
    expect(upgraded.busyBreakdown?.shells).not.toBe(0);
    expect(upgraded.busyBreakdown?.scheduledWakes).not.toBe(0);
    expect(() => hostStatusV16.responseSchema.parse(upgraded)).not.toThrow();
  });

  it("keeps a null breakdown null", () => {
    const v15Response = hostStatusV15.responseSchema.parse({
      ...V15_BASE,
      busyBreakdown: null,
      updateOperation: null,
      updateTransaction: null,
    });
    const upgraded = hostStatusUpgradeV15ToV16.upgradeResponse(v15Response);
    expect(upgraded.busyBreakdown).toBeNull();
    expect(() => hostStatusV16.responseSchema.parse(upgraded)).not.toThrow();
  });

  it("keeps updateOperation: null null", () => {
    const v15Response = hostStatusV15.responseSchema.parse({
      ...V15_BASE,
      busyBreakdown: null,
      updateOperation: null,
      updateTransaction: null,
    });
    const upgraded = hostStatusUpgradeV15ToV16.upgradeResponse(v15Response);
    expect(upgraded.updateOperation).toBeNull();
  });

  it("leaves updateOperation: { kind: 'none' } unchanged", () => {
    const v15Response = hostStatusV15.responseSchema.parse({
      ...V15_BASE,
      busyBreakdown: null,
      updateOperation: { kind: "none" },
      updateTransaction: null,
    });
    const upgraded = hostStatusUpgradeV15ToV16.upgradeResponse(v15Response);
    expect(upgraded.updateOperation).toEqual({ kind: "none" });
    expect(() => hostStatusV16.responseSchema.parse(upgraded)).not.toThrow();
  });

  it("leaves updateOperation: { kind: 'unavailable', ... } unchanged", () => {
    const unavailable = {
      kind: "unavailable" as const,
      reason: "corrupt" as const,
      cause: "bad bytes",
    };
    const v15Response = hostStatusV15.responseSchema.parse({
      ...V15_BASE,
      busyBreakdown: null,
      updateOperation: unavailable,
      updateTransaction: null,
    });
    const upgraded = hostStatusUpgradeV15ToV16.upgradeResponse(v15Response);
    expect(upgraded.updateOperation).toEqual(unavailable);
    expect(() => hostStatusV16.responseSchema.parse(upgraded)).not.toThrow();
  });

  it("lifts a nested attempt breakdown the same way (never a fabricated zero)", () => {
    const v15Response = hostStatusV15.responseSchema.parse({
      ...V15_BASE,
      busyBreakdown: BUSY_BREAKDOWN_V1,
      updateOperation: ATTEMPT_ARM_V1_EXPECTED,
      updateTransaction: null,
    });
    const upgraded = hostStatusUpgradeV15ToV16.upgradeResponse(v15Response);
    if (
      upgraded.updateOperation === null ||
      upgraded.updateOperation.kind !== "attempt"
    ) {
      throw new Error("expected an attempt arm");
    }
    expect(upgraded.updateOperation.busyBreakdown).toEqual({
      ...BUSY_BREAKDOWN_V1,
      shells: null,
      scheduledWakes: null,
    });
    expect(() => hostStatusV16.responseSchema.parse(upgraded)).not.toThrow();
  });
});

describe("hostRestartUpgradeV12ToV13.upgradeResponse never fabricates zero", () => {
  it("lifts the busy arm's breakdown with shells: null, scheduledWakes: null", () => {
    const v12Response = hostRestartResponseSchema.parse({
      outcome: "busy",
      verdict: {
        busySessionCount: 3,
        blockers: { workingAgents: true, runningTerminals: false },
        busyBreakdown: BUSY_BREAKDOWN_V1,
      },
    });
    const upgraded = hostRestartUpgradeV12ToV13.upgradeResponse(v12Response);
    if (upgraded.outcome !== "busy") throw new Error("expected a busy outcome");
    expect(upgraded.verdict.busyBreakdown).toEqual({
      ...BUSY_BREAKDOWN_V1,
      shells: null,
      scheduledWakes: null,
    });
    expect(() => hostRestartResponseV13Schema.parse(upgraded)).not.toThrow();
  });

  it("leaves an accepted response unchanged", () => {
    const v12Response = hostRestartResponseSchema.parse({
      outcome: "accepted",
    });
    const upgraded = hostRestartUpgradeV12ToV13.upgradeResponse(v12Response);
    expect(upgraded).toEqual({ outcome: "accepted" });
  });

  it("a null breakdown stays null", () => {
    const v12Response = hostRestartResponseSchema.parse({
      outcome: "busy",
      verdict: {
        busySessionCount: 3,
        blockers: null,
        busyBreakdown: null,
      },
    });
    const upgraded = hostRestartUpgradeV12ToV13.upgradeResponse(v12Response);
    if (upgraded.outcome !== "busy") throw new Error("expected a busy outcome");
    expect(upgraded.verdict.busyBreakdown).toBeNull();
  });
});

describe("registry chain: upgradeResponseToVersion ends with null shells/scheduledWakes", () => {
  it("host.status @1.2 -> @1.6 keeps the three V1 counts and nulls the two V2 counts", () => {
    const v12Response = hostStatusV12.responseSchema.parse({
      ...BASE_RESPONSE,
      busyBreakdown: BUSY_BREAKDOWN_V1,
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["host.status"],
      V12,
      V16,
      v12Response,
    );
    expect(upgraded.busyBreakdown).toEqual({
      ...BUSY_BREAKDOWN_V1,
      shells: null,
      scheduledWakes: null,
    });
  });

  it("host.restart @1.2 -> @1.3 keeps the three V1 counts and nulls the two V2 counts", () => {
    const v12Response = hostRestartResponseSchema.parse({
      outcome: "busy",
      verdict: {
        busySessionCount: 3,
        blockers: { workingAgents: true, runningTerminals: false },
        busyBreakdown: BUSY_BREAKDOWN_V1,
      },
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["host.restart"],
      V12,
      V13,
      v12Response,
    );
    if (upgraded.outcome !== "busy") throw new Error("expected a busy outcome");
    expect(upgraded.verdict.busyBreakdown).toEqual({
      ...BUSY_BREAKDOWN_V1,
      shells: null,
      scheduledWakes: null,
    });
  });
});

describe("hostRuntimeStatusAwarenessSchema stays on V1", () => {
  it("still accepts an entry with no busyBreakdown key", () => {
    const parsed = hostRuntimeStatusAwarenessSchema.parse({
      busy: true,
      busySessionCount: 3,
      updateProgress: null,
    });
    expect(parsed.busyBreakdown).toBeUndefined();
  });

  it("strips shells/scheduledWakes from a V2 breakdown", () => {
    const parsed = hostRuntimeStatusAwarenessSchema.parse({
      busy: true,
      busySessionCount: 3,
      updateProgress: null,
      busyBreakdown: BUSY_BREAKDOWN_V2,
    });
    expect(parsed.busyBreakdown).toEqual(BUSY_BREAKDOWN_V1);
    expect(parsed.busyBreakdown).not.toHaveProperty("shells");
    expect(parsed.busyBreakdown).not.toHaveProperty("scheduledWakes");
  });
});
