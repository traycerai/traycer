import { z } from "zod";
import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createChatInitialMessageSchema,
  createChatInitialMessageSchemaV12,
  createChatRequestSchema,
  createChatRequestSchemaV11,
  createChatRequestSchemaV12,
  createChatResponseSchema,
  createChatResponseSchemaV12,
  createEpicChatSeedSchema,
  createEpicChatSeedSchemaV12,
  createEpicRequestSchema,
  createEpicRequestSchemaV12,
  createEpicResponseSchema,
  createEpicResponseSchemaPre11,
  createEpicResponseSchemaV12,
  epicCreateRefusalKindSchema,
  epicCreateRefusalKindSchemaV12,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Unwraps a `.nullable().optional()` field to its leaf instance: `ZodOptional`
 * over `ZodNullable`.
 *
 * The two wrappers are named in the SIGNATURE rather than checked at runtime.
 * That is the stronger statement of the same invariant: a field that stops
 * being `.nullable().optional()` fails to compile at the call site, where the
 * change is, instead of throwing from in here for one of the callers. And
 * because `ZodOptional<T>.unwrap()` and `ZodNullable<T>.unwrap()` both return
 * `T`, the leaf keeps its concrete instance type - a `z.ZodType` return would
 * erase it and leave the `toBe` pins below comparing two opaque schemas.
 */
function unwrapNullableOptional<Leaf extends z.ZodType>(
  field: z.ZodOptional<z.ZodNullable<Leaf>>,
): Leaf {
  return field.unwrap().unwrap();
}

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

  it("1.2 pins the V12 request/response instances, distinct from the released 1.0/1.1 ones", () => {
    const v12 = hostRpcRegistry["epic.create"][1].versions[2].contract;
    expect(v12.requestSchema).toBe(createEpicRequestSchemaV12);
    expect(v12.responseSchema).toBe(createEpicResponseSchemaV12);
    expect(v12.requestSchema).not.toBe(createEpicRequestSchema);
    expect(v12.responseSchema).not.toBe(createEpicResponseSchema);
    expect(v12.responseSchema).not.toBe(createEpicResponseSchemaPre11);
  });
});

/**
 * Shape-level pins on the leaf, per the tech plan's Verification section:
 * these are the PRIMARY defence (over the reference-identity pins above),
 * because the freeze this ticket relies on is that the released instances
 * never gain the new keys, not merely that they keep their names.
 */
describe("epic.create@1.2 leaf freeze - shape pins on the released instances", () => {
  it("createEpicRequestSchema.shape.chat is still the existing createEpicChatSeedSchema instance, unwrapped twice", () => {
    // The prior describe block already pins `versions[0].contract.requestSchema`
    // to this exact instance, so unwrapping it directly names the wire shape.
    expect(unwrapNullableOptional(createEpicRequestSchema.shape.chat)).toBe(
      createEpicChatSeedSchema,
    );
  });

  it("the existing createChatInitialMessageSchema has no attachmentsByHash key", () => {
    expect(createChatInitialMessageSchema.shape).not.toHaveProperty(
      "attachmentsByHash",
    );
    expect(createChatInitialMessageSchemaV12.shape).toHaveProperty(
      "attachmentsByHash",
    );
  });

  it("the released initial-message settings leaf has no identityId key; the V12 leaf has it", () => {
    expect(
      createChatInitialMessageSchema.shape.settings.shape,
    ).not.toHaveProperty("identityId");
    expect(
      createChatInitialMessageSchemaV12.shape.settings.shape,
    ).toHaveProperty("identityId");
  });

  it("the released createChat fork settings tuple has no identityId key; V12's has it", () => {
    expect(
      unwrapNullableOptional(createChatRequestSchema.shape.settings).shape,
    ).not.toHaveProperty("identityId");
    expect(
      unwrapNullableOptional(createChatRequestSchemaV11.shape.settings).shape,
    ).not.toHaveProperty("identityId");
    expect(
      unwrapNullableOptional(createChatRequestSchemaV12.shape.settings).shape,
    ).toHaveProperty("identityId");
  });

  it("the existing createEpicChatSeedSchema has no deferWorktreeProvisioning key", () => {
    expect(createEpicChatSeedSchema.shape).not.toHaveProperty(
      "deferWorktreeProvisioning",
    );
    expect(createEpicChatSeedSchemaV12.shape).toHaveProperty(
      "deferWorktreeProvisioning",
    );
  });

  it("the released refusal enum still has exactly one value; the V12 enum has two", () => {
    expect(epicCreateRefusalKindSchema.options).toEqual([
      "local-store-unavailable",
    ]);
    expect(epicCreateRefusalKindSchemaV12.options).toEqual([
      "local-store-unavailable",
      "missing-attachment-bytes",
    ]);
  });
});

/**
 * `epic.createChat` has no instance pin today; add one alongside the
 * `epic.create` pin above, per-minor request/response instances plus the
 * V12 leaf unwrap.
 */
describe("epic.createChat instance identity", () => {
  it("pins each minor's request schema to its canonical instance", () => {
    const line = hostRpcRegistry["epic.createChat"][1];
    expect(line.versions[0].contract.requestSchema).toBe(
      createChatRequestSchema,
    );
    expect(line.versions[1].contract.requestSchema).toBe(
      createChatRequestSchemaV11,
    );
    expect(line.versions[2].contract.requestSchema).toBe(
      createChatRequestSchemaV12,
    );
  });

  it("pins each minor's response schema to its canonical instance", () => {
    const line = hostRpcRegistry["epic.createChat"][1];
    expect(line.versions[0].contract.responseSchema).toBe(
      createChatResponseSchema,
    );
    expect(line.versions[1].contract.responseSchema).toBe(
      createChatResponseSchema,
    );
    expect(line.versions[2].contract.responseSchema).toBe(
      createChatResponseSchemaV12,
    );
  });

  it("V12's initialMessage unwraps to the V12 leaf instance", () => {
    expect(
      unwrapNullableOptional(createChatRequestSchemaV12.shape.initialMessage),
    ).toBe(createChatInitialMessageSchemaV12);
  });
});
