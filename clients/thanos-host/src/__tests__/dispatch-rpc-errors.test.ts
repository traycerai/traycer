import { describe, expect, it } from "vitest";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import { EpicCatalog } from "../catalog";
import { dispatchRpc } from "../handlers";

const LIST_CLOUD_TASKS_REQUEST = {
  limit: 20,
  filters: null,
  sort: "recent",
  extensionPhaseVersion: "1.0.0",
  extensionEpicVersion: "2.0.0",
} as const;

describe("dispatchRpc error codes", () => {
  it("returns E_INVALID_ARGUMENT when epic.listTasks params fail Zod parse", () => {
    const dispatched = dispatchRpc(
      "epic.listTasks",
      { major: 1, minor: 2 },
      {},
      new EpicCatalog(),
    );

    expect(dispatched.result).toBeNull();
    expect(dispatched.error?.code).toBe("E_INVALID_ARGUMENT");
  });

  it("returns RPC_ERROR when an implemented handler throws a non-Zod error", () => {
    class ExplodingCatalog extends EpicCatalog {
      override list(): TaskLight[] {
        throw new TypeError("catalog exploded");
      }
    }

    const dispatched = dispatchRpc(
      "epic.listTasks",
      { major: 1, minor: 2 },
      LIST_CLOUD_TASKS_REQUEST,
      new ExplodingCatalog(),
    );

    expect(dispatched.result).toBeNull();
    expect(dispatched.error?.code).toBe("RPC_ERROR");
  });
});
