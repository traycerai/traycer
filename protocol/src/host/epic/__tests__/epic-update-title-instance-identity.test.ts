import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  updateEpicRequestSchema,
  updateEpicResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Hard invariant: the `epic.updateTitle` host RPC contract must wire the canonical `updateEpic*` schema instances - not merely equal shapes.
 */
describe("epic.updateTitle instance identity", () => {
  const hostContract =
    hostRpcRegistry["epic.updateTitle"][1].versions[0].contract;

  it("host request schema is the canonical updateEpicRequestSchema instance", () => {
    expect(hostContract.requestSchema).toBe(updateEpicRequestSchema);
  });

  it("keeps client-authored updatedAt in the shared title update contract", () => {
    expect(
      hostContract.requestSchema.parse({
        epicDelta: { id: "epic-1", title: "Renamed", updatedAt: 4242 },
      }),
    ).toEqual({
      epicDelta: { id: "epic-1", title: "Renamed", updatedAt: 4242 },
    });
    expect(() =>
      hostContract.requestSchema.parse({
        epicDelta: { id: "epic-1", title: "Renamed" },
      }),
    ).toThrow();
  });

  it("host response schema is the canonical updateEpicResponseSchema instance", () => {
    expect(hostContract.responseSchema).toBe(updateEpicResponseSchema);
  });
});
