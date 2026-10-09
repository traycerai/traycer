import { describe, expect, it } from "vitest";
import type {
  SandboxCost,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxCostsRefetchInterval } from "@/hooks/sandboxes/use-sandbox-costs-query";

function costRow(
  sandboxId: string,
  overrides: Partial<SandboxCost>,
): SandboxCost {
  return {
    sandboxId,
    currentRateMillicreditsPerHour: 0,
    state: "awake",
    frozen: false,
    charged: {
      computeMillicredits: 0,
      storageMillicredits: 0,
      sinceCreatedAt: 1_791_000_000_000,
    },
    pendingMillicredits: 0,
    segments: [],
    ...overrides,
  };
}

function costsOf(
  awakeBurnMillicreditsPerHour: number,
  ...sandboxes: readonly SandboxCost[]
): UserSandboxCost {
  return { sandboxes, awakeBurnMillicreditsPerHour };
}

describe("sandboxCostsRefetchInterval", () => {
  it("polls every minute while an awake sandbox accrues, whatever the rate", () => {
    for (const rate of [1, 120, 5_000_000]) {
      expect(
        sandboxCostsRefetchInterval(
          costsOf(
            rate,
            costRow("a", {
              state: "awake",
              currentRateMillicreditsPerHour: rate,
            }),
          ),
          false,
        ),
      ).toBe(60_000);
    }
  });

  it("polls for a suspended sandbox that accrues only its storage, though the awake burn is zero", () => {
    expect(
      sandboxCostsRefetchInterval(
        costsOf(
          0,
          costRow("a", {
            state: "suspended",
            currentRateMillicreditsPerHour: 4,
          }),
        ),
        false,
      ),
    ).toBe(60_000);
    expect(
      sandboxCostsRefetchInterval(
        costsOf(
          0,
          costRow("a", { state: "stopped", currentRateMillicreditsPerHour: 2 }),
        ),
        false,
      ),
    ).toBe(60_000);
  });

  it("sums the rows: one accruing row among idle ones is enough", () => {
    expect(
      sandboxCostsRefetchInterval(
        costsOf(
          0,
          costRow("a", { state: "suspended", frozen: true }),
          costRow("b", { state: "stopped", currentRateMillicreditsPerHour: 2 }),
          costRow("c", { state: "suspended" }),
        ),
        false,
      ),
    ).toBe(60_000);
  });

  it("does not poll when every row's rate is zero, whatever the awake burn field says", () => {
    expect(
      sandboxCostsRefetchInterval(
        costsOf(
          0,
          costRow("a", { state: "suspended", frozen: true }),
          costRow("b", { state: "awake" }),
        ),
        false,
      ),
    ).toBe(false);
    // The poll rule reads the rows, not the aggregate.
    expect(
      sandboxCostsRefetchInterval(
        costsOf(500, costRow("a", { state: "awake" })),
        false,
      ),
    ).toBe(false);
  });

  it("does not poll with no rows, or before the cost view has answered", () => {
    expect(sandboxCostsRefetchInterval(costsOf(0), false)).toBe(false);
    expect(sandboxCostsRefetchInterval(null, false)).toBe(false);
  });

  describe("after a failed read", () => {
    it("polls every minute when the read failed and there are no costs to go by", () => {
      expect(sandboxCostsRefetchInterval(null, true)).toBe(60_000);
    });

    it("does not poll when nothing failed and there are no costs yet", () => {
      expect(sandboxCostsRefetchInterval(null, false)).toBe(false);
    });

    it("does not poll for data with zero accrual that did not fail", () => {
      expect(
        sandboxCostsRefetchInterval(
          costsOf(0, costRow("a", { state: "suspended", frozen: true })),
          false,
        ),
      ).toBe(false);
    });

    it("polls for data that accrues, whether or not the last read failed", () => {
      const accruing = costsOf(
        120,
        costRow("a", { state: "awake", currentRateMillicreditsPerHour: 120 }),
      );
      expect(sandboxCostsRefetchInterval(accruing, false)).toBe(60_000);
      expect(sandboxCostsRefetchInterval(accruing, true)).toBe(60_000);
    });

    it("polls when the read failed even though the last good data showed zero accrual", () => {
      expect(
        sandboxCostsRefetchInterval(
          costsOf(0, costRow("a", { state: "suspended", frozen: true })),
          true,
        ),
      ).toBe(60_000);
    });
  });
});
