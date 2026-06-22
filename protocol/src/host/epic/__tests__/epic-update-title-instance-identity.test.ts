import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  updateEpicRequestSchema,
  updateEpicResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Hard invariant: the `epic.updateTitle` host RPC contract must wire the
 * canonical `updateEpic*` schema instances - not merely equal shapes.
 * Referential equality (`toBe`) catches an accidental future redefinition
 * where a local copy would pass structural checks but break the shared
 * wire-contract identity guarantee.
 *
 * The cloud-side (`cloudDataRpcRegistry["epic.update"]`) reuse of these same
 * instances is guaranteed by construction - the cloud registry imports them
 * directly from `@traycer/protocol/host/epic/unary-schemas` - and is
 * covered on the consumer side, so protocol's own tests stay within the
 * protocol package.
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
