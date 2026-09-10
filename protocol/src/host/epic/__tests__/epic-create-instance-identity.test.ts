import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createEpicRequestSchema,
  createEpicResponseSchema,
  createEpicResponseSchemaPre11,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Hard invariant: the `epic.create` host RPC contracts must wire the
 * canonical `createEpic*` schema instances exported from `unary-schemas`,
 * not structurally-equal copies. Referential equality (`toBe`) catches an
 * accidental future redefinition where a local re-declaration would pass a
 * structural check but break the shared wire-contract identity.
 *
 * The cloud-side (`cloudDataRpcRegistry`) reuse of these same instances is
 * guaranteed by construction - the cloud registry imports them directly from
 * `@traycer/protocol/host/epic/unary-schemas` - and is covered on the
 * consumer side, so protocol's own tests stay within the protocol package.
 *
 * `@1.1` (the create refusal) split the response into two instances, so each
 * LINE is pinned to its own. The last case is the one that keeps the other two
 * honest after that split: a future edit that re-aliased the frozen name onto
 * the live schema would satisfy both `toBe` assertions while quietly deleting
 * the freeze, which is the exact shape a frozen-line regression takes.
 */
describe("epic.create instance identity", () => {
  const v10 = hostRpcRegistry["epic.create"][1].versions[0].contract;
  const v11 = hostRpcRegistry["epic.create"][1].versions[1].contract;

  it("host request schema is the canonical createEpicRequestSchema instance", () => {
    expect(v10.requestSchema).toBe(createEpicRequestSchema);
    // `@1.1` grows the RESPONSE only; both lines take the same request.
    expect(v11.requestSchema).toBe(createEpicRequestSchema);
  });

  it("the released 1.0 response is the frozen instance", () => {
    expect(v10.responseSchema).toBe(createEpicResponseSchemaPre11);
  });

  it("the 1.1 response is the canonical live instance", () => {
    expect(v11.responseSchema).toBe(createEpicResponseSchema);
  });

  it("the frozen instance is not the live one - the freeze is a separate object", () => {
    expect(createEpicResponseSchemaPre11).not.toBe(createEpicResponseSchema);
  });
});
