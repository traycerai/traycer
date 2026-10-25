import { describe, expect, it } from "vitest";
import {
  SANDBOX_FROZEN_RETENTION_DAYS,
  SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY,
  SANDBOX_REFUSAL_CODE_TEAM_PODS_FULL,
  sandboxAutomationResponseSchema,
  sandboxCatalogueSchema,
  sandboxCreateAcceptedSchema,
  sandboxListResponseSchema,
  sandboxPodSchema,
  sandboxRefusalBodySchema,
} from "@traycer/protocol/host/sandbox-control";

/**
 * Fixtures copied from traycer-server's `toSandboxView`, `buildCatalogue` and
 * the `/api/sandboxes` route bodies, so a drift between the mirror and the
 * server shows up here first.
 */
const SANDBOX_VIEW = {
  id: "sbx_1",
  hostId: "8f6f2d7e-1f43-4c1e-9d63-1e3a7d2c9b10",
  kind: "agent",
  provider: "tensorlake",
  region: "us-east",
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: 20480,
  displayName: "build-box",
  state: "awake",
  frozen: false,
  failureCode: null,
  idleMinutes: null,
  burst: false,
  createdByHostId: null,
  createdByAgentId: null,
  createdAt: 1_791_000_000_000,
  lastTransitionAt: 1_791_000_010_000,
  lastActivityAt: null,
  destroyedAt: null,
  priceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
};

describe("sandbox control plane mirror", () => {
  it("parses a list of SandboxView rows, unpriced ones included", () => {
    const parsed = sandboxListResponseSchema.parse({
      sandboxes: [SANDBOX_VIEW, { ...SANDBOX_VIEW, priceMcPerHour: null }],
    });
    expect(parsed.sandboxes).toHaveLength(2);
    expect(parsed.sandboxes[1]?.priceMcPerHour).toBeNull();
  });

  it("tolerates a field the server adds, and refuses an unknown state", () => {
    expect(
      sandboxListResponseSchema.safeParse({
        sandboxes: [{ ...SANDBOX_VIEW, costSoFarMc: 10 }],
      }).success,
    ).toBe(true);
    expect(
      sandboxListResponseSchema.safeParse({
        sandboxes: [{ ...SANDBOX_VIEW, state: "hibernating" }],
      }).success,
    ).toBe(false);
  });

  it("parses the catalogue with its shape bounds and from-prices", () => {
    const parsed = sandboxCatalogueSchema.parse({
      providers: [
        {
          provider: "tensorlake",
          os: ["linux"],
          shape: {
            cpuMin: 1,
            cpuMax: 16,
            cpuStep: 1,
            memoryPerCpuMinMb: 1024,
            memoryPerCpuMaxMb: 8192,
            memoryMinMb: 1024,
            memoryMaxMb: 65536,
            memoryStepMb: 512,
            diskMinMb: 10240,
            diskMaxMb: 102400,
            diskDefaultMb: 20480,
          },
          suspendFidelity: "memory",
          stoppedStorage: "snapshot",
          wakeClass: "resume",
          dockerInGuest: true,
          creatable: true,
          notCreatableReason: null,
          regions: [
            {
              id: "us-east",
              label: "US East",
              fromPriceMcPerHour: { awakeMc: 60, suspendedMc: 2, stoppedMc: 1 },
            },
          ],
        },
      ],
    });
    expect(parsed.providers[0]?.shape.diskDefaultMb).toBe(20480);
  });

  describe("shapes", () => {
    const BOUNDS = {
      cpuMin: 1,
      cpuMax: 16,
      cpuStep: 1,
      memoryPerCpuMinMb: 1024,
      memoryPerCpuMaxMb: 8192,
      memoryMinMb: 1024,
      memoryMaxMb: 65536,
      memoryStepMb: 512,
      diskMinMb: 10240,
      diskMaxMb: 102400,
      diskDefaultMb: 20480,
    };
    const ROW = {
      provider: "tensorlake",
      os: ["linux"],
      shape: BOUNDS,
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      dockerInGuest: true,
      regions: [
        {
          id: "us",
          label: "US",
          fromPriceMcPerHour: { awakeMc: 60, suspendedMc: 2, stoppedMc: 1 },
        },
      ],
    };
    const SMALL = { cpus: 1, memoryMb: 1024, diskMb: 10240, default: false };
    const DEFAULT = { cpus: 2, memoryMb: 4096, diskMb: 20480, default: true };

    function shapesOf(shapes: unknown): unknown {
      return sandboxCatalogueSchema.parse({
        providers: [{ ...ROW, shapes }],
      }).providers[0]?.shapes;
    }

    it("parses a provider's listed shapes", () => {
      expect(shapesOf([SMALL, DEFAULT])).toEqual([SMALL, DEFAULT]);
    });

    // Prevents a client failing on a catalogue from a server that predates the list.
    it("reads a server that lists no shapes as none", () => {
      expect(
        sandboxCatalogueSchema.parse({ providers: [ROW] }).providers[0]?.shapes,
      ).toBeNull();
    });

    // Prevents one bad entry failing the whole catalogue.
    it("reads a list with a bad entry as none and still parses the catalogue", () => {
      expect(shapesOf([SMALL, { ...DEFAULT, cpus: "two" }])).toBeNull();
    });

    // Prevents a client staging a size no rung is the default of.
    it("reads a list without exactly one default as none", () => {
      expect(shapesOf([SMALL, { ...DEFAULT, default: false }])).toBeNull();
      expect(shapesOf([{ ...SMALL, default: true }, DEFAULT])).toBeNull();
    });
  });

  describe("creatable and notCreatableReason", () => {
    // An older server's provider row: neither field.
    const OLDER_ROW = {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 10240,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      dockerInGuest: true,
      regions: [
        {
          id: "us",
          label: "US",
          fromPriceMcPerHour: { awakeMc: 60, suspendedMc: 2, stoppedMc: 1 },
        },
      ],
    };

    // Prevents a client failing on a region from a server before per-unit rates.
    it("reads an older server's region with no per-unit pricing", () => {
      const row = sandboxCatalogueSchema.parse({ providers: [OLDER_ROW] })
        .providers[0];
      expect(row?.regions[0]?.pricing).toBeNull();
    });

    // Prevents a client failing on, or hiding, a catalogue from a server that predates the fields.
    it("reads an older server's row as creatable with no reason", () => {
      const row = sandboxCatalogueSchema.parse({ providers: [OLDER_ROW] })
        .providers[0];
      expect(row?.creatable).toBe(true);
      expect(row?.notCreatableReason).toBeNull();
    });

    // Prevents a client dropping the reason a provider offers no shape.
    it("keeps creatable false and its reason", () => {
      const row = sandboxCatalogueSchema.parse({
        providers: [
          {
            ...OLDER_ROW,
            creatable: false,
            notCreatableReason: SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY,
          },
        ],
      }).providers[0];
      expect(row?.creatable).toBe(false);
      expect(row?.notCreatableReason).toBe("plan-memory-below-host-minimum");
    });
  });

  it("parses the 202 create answer with its row", () => {
    const parsed = sandboxCreateAcceptedSchema.parse({
      sandboxId: "sbx_1",
      hostId: SANDBOX_VIEW.hostId,
      sandbox: { ...SANDBOX_VIEW, state: "creating" },
    });
    expect(parsed.sandbox.state).toBe("creating");
  });

  it("reads each typed refusal body", () => {
    expect(
      sandboxRefusalBodySchema.parse({
        code: "shape_not_offered",
        reason: "memory-per-cpu-out-of-range",
      }).reason,
    ).toBe("memory-per-cpu-out-of-range");
    const gate = sandboxRefusalBodySchema.parse({
      code: "insufficient_credit",
      reason: "denied",
      requiredMc: 120,
      newRateMcPerHour: 120,
      currentAwakeBurnMcPerHour: 60,
      balanceMc: 50,
      shortfallMc: 70,
    });
    expect(gate.shortfallMc).toBe(70);
    expect(gate.currentAwakeBurnMcPerHour).toBe(60);
    expect(
      sandboxRefusalBodySchema.parse({
        code: "verb_not_available",
        verb: "resume",
      }).code,
    ).toBe("verb_not_available");
    expect(
      sandboxRefusalBodySchema.parse({
        code: "sandbox_transition_conflict",
        sandboxId: null,
        state: null,
      }).code,
    ).toBe("sandbox_transition_conflict");
  });

  describe("frozenAt, guestConfigured and guestConfigFailureReason", () => {
    // SANDBOX_VIEW above is the older server's body: none of the three.
    const WITH_FIELDS = {
      ...SANDBOX_VIEW,
      state: "suspended",
      frozen: true,
      frozenAt: 1_791_000_020_000,
      guestConfigured: false,
      guestConfigFailureReason: "broker unreachable",
    };

    it("reads an older server's body as three nulls, never a failure", () => {
      const parsed = sandboxListResponseSchema.parse({
        sandboxes: [SANDBOX_VIEW],
      });
      expect(parsed.sandboxes[0]?.frozenAt).toBeNull();
      expect(parsed.sandboxes[0]?.guestConfigured).toBeNull();
      expect(parsed.sandboxes[0]?.guestConfigFailureReason).toBeNull();
    });

    it("reads a newer server's body with the values it carries", () => {
      const parsed = sandboxListResponseSchema.parse({
        sandboxes: [WITH_FIELDS],
      });
      expect(parsed.sandboxes[0]?.frozenAt).toBe(1_791_000_020_000);
      expect(parsed.sandboxes[0]?.guestConfigured).toBe(false);
      expect(parsed.sandboxes[0]?.guestConfigFailureReason).toBe(
        "broker unreachable",
      );
    });

    it("keeps explicit nulls as nulls", () => {
      const parsed = sandboxListResponseSchema.parse({
        sandboxes: [
          {
            ...SANDBOX_VIEW,
            frozenAt: null,
            guestConfigured: null,
            guestConfigFailureReason: null,
          },
        ],
      });
      expect(parsed.sandboxes[0]?.frozenAt).toBeNull();
      expect(parsed.sandboxes[0]?.guestConfigured).toBeNull();
    });

    it("parses the same two shapes inside the 202 create answer", () => {
      expect(
        sandboxCreateAcceptedSchema.safeParse({
          sandboxId: "sbx_1",
          hostId: SANDBOX_VIEW.hostId,
          sandbox: SANDBOX_VIEW,
        }).success,
      ).toBe(true);
      expect(
        sandboxCreateAcceptedSchema.safeParse({
          sandboxId: "sbx_1",
          hostId: SANDBOX_VIEW.hostId,
          sandbox: WITH_FIELDS,
        }).success,
      ).toBe(true);
    });

    it("still refuses a field of the wrong type", () => {
      for (const bad of [
        { frozenAt: "yesterday" },
        { guestConfigured: "no" },
        { guestConfigFailureReason: 12 },
      ]) {
        expect(
          sandboxListResponseSchema.safeParse({
            sandboxes: [{ ...WITH_FIELDS, ...bad }],
          }).success,
        ).toBe(false);
      }
    });

    it("keeps the retention the day-30 job destroys a frozen row at", () => {
      expect(SANDBOX_FROZEN_RETENTION_DAYS).toBe(30);
    });
  });
});

describe("Automations pods", () => {
  const POD = { sandbox: SANDBOX_VIEW, ordinal: 0, liveShells: 2, headroom: 6 };

  it("defaults pods to an empty list when a server from before the pod list sends none", () => {
    const parsed = sandboxAutomationResponseSchema.parse({
      available: true,
      sandbox: null,
    });
    expect(parsed.pods).toEqual([]);
    expect(parsed.available).toBe(true);
    expect(parsed.sandbox).toBeNull();
  });

  it("parses a pod with its slot, live shells and headroom", () => {
    const parsed = sandboxAutomationResponseSchema.parse({
      available: true,
      sandbox: null,
      pods: [POD, { ...POD, ordinal: 1, liveShells: 8, headroom: 0 }],
    });
    expect(parsed.pods).toHaveLength(2);
    expect(parsed.pods[0]?.sandbox.id).toBe("sbx_1");
    expect(parsed.pods[0]?.ordinal).toBe(0);
    expect(parsed.pods[0]?.liveShells).toBe(2);
    expect(parsed.pods[0]?.headroom).toBe(6);
    expect(parsed.pods[1]?.headroom).toBe(0);
  });

  it("parses a single pod through its own schema", () => {
    expect(sandboxPodSchema.parse(POD).ordinal).toBe(0);
  });

  it("refuses a negative headroom, live-shell count or ordinal, and a fractional ordinal", () => {
    for (const bad of [
      { headroom: -1 },
      { liveShells: -1 },
      { ordinal: -1 },
      { ordinal: 1.5 },
    ]) {
      expect(sandboxPodSchema.safeParse({ ...POD, ...bad }).success).toBe(
        false,
      );
      expect(
        sandboxAutomationResponseSchema.safeParse({
          available: true,
          sandbox: null,
          pods: [{ ...POD, ...bad }],
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a pod with no row", () => {
    const { sandbox: _omitted, ...withoutRow } = POD;
    expect(sandboxPodSchema.safeParse(withoutRow).success).toBe(false);
  });
});

describe("refusal body message", () => {
  it("reads a refusal that carries a server-composed message", () => {
    const parsed = sandboxRefusalBodySchema.parse({
      code: SANDBOX_REFUSAL_CODE_TEAM_PODS_FULL,
      message: "Every pod of Alpha is full. Ask an admin to add one.",
    });
    expect(parsed.code).toBe("team_pods_full");
    expect(parsed.message).toBe(
      "Every pod of Alpha is full. Ask an admin to add one.",
    );
  });

  it("reads a refusal with no message, and one whose message is null", () => {
    expect(
      sandboxRefusalBodySchema.parse({ code: "sandbox_busy" }).message,
    ).toBeUndefined();
    expect(
      sandboxRefusalBodySchema.parse({ code: "sandbox_busy", message: null })
        .message,
    ).toBeNull();
  });

  it("refuses a message that is not a string", () => {
    expect(
      sandboxRefusalBodySchema.safeParse({ code: "sandbox_busy", message: 3 })
        .success,
    ).toBe(false);
  });
});
