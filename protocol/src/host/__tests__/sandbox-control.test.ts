import { describe, expect, it } from "vitest";
import {
  sandboxCatalogueSchema,
  sandboxCreateAcceptedSchema,
  sandboxListResponseSchema,
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
});
