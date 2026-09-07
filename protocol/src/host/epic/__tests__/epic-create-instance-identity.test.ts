import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createEpicRequestSchema,
  createEpicResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Hard invariant: the `epic.create` host RPC contract must wire the canonical `createEpic*` schema instances exported from `unary-schemas`, not structurally-equal copies.
 */
describe("epic.create instance identity", () => {
  const hostContract = hostRpcRegistry["epic.create"][1].versions[0].contract;

  it("host request schema is the canonical createEpicRequestSchema instance", () => {
    expect(hostContract.requestSchema).toBe(createEpicRequestSchema);
  });

  it("host response schema is the canonical createEpicResponseSchema instance", () => {
    expect(hostContract.responseSchema).toBe(createEpicResponseSchema);
  });
});
