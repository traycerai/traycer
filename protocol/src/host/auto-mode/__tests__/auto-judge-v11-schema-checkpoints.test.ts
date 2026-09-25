import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  autoJudgeBlockedSchema,
  autoJudgeBlockedSchemaV11,
  autoJudgeEffectiveSchema,
  autoJudgeEffectiveSchemaV11,
  autoJudgeGetResponseSchema,
  autoJudgeGetResponseSchemaV11,
  autoJudgeGetV11,
  autoJudgeSetResponseSchema,
  autoJudgeSetResponseSchemaV11,
  autoJudgeSetV11,
} from "@traycer/protocol/host/auto-mode/contracts";

// The same digest recipe as `chat-schema-checkpoints.test.ts`: SHA-256 over
// the key-sorted JSON of `z.toJSONSchema(schema, { io })`.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function schemaDigest(schema: z.ZodType, io: "input" | "output"): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(z.toJSONSchema(schema, { io }))))
    .digest("hex");
}

/**
 * Unwraps a `.nullable().optional()` field to its leaf instance: `ZodOptional`
 * over `ZodNullable`. `.unwrap()` peels optional, then nullable.
 */
function unwrapNullableOptional<Leaf extends z.ZodType>(
  field: z.ZodOptional<z.ZodNullable<Leaf>>,
): Leaf {
  return field.unwrap().unwrap();
}

// `autoJudge.get@1.1` and `autoJudge.set@1.1` shipped in every host tag from
// `host-v1.3.2-staging.52` on, so both are frozen. `1.2` opened above them for
// the machine's last judge pick, and the `1.1` responses became hand copies
// (`...V11`) while the head kept the canonical names.
//
// Captured BEFORE the 1.2 edit, from OSS commit 2335599850 - the released
// 1.1 - from the working tree at that commit and independently from a
// `git archive` of it; both captures were identical. Never recompute these
// from the current tree and paste: they pin the released bytes. The current
// tree must reproduce them unchanged.
//
// Each response pair is shared across the two methods, because the 1.1
// responses are the same shape. The requests are shared by reference with
// 1.0 and 1.2, so the V10 pins also guard them. The nested pins were taken
// from the then-canonical `autoJudgeEffectiveSchema` / `autoJudgeBlockedSchema`,
// which is what 1.1 bound.
const V11_DIGESTS = {
  "autoJudge.get": {
    request: [
      "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
      "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
    ],
    response: [
      "deeb5d21207edcd0ac8d78a35c2e1e64fc3b4d7bac871fc74644c87e6d8c12e3",
      "6da458b4385592e1ae6762583b969eeadcbaf5bb3e795e1be79bd7c34fff9bc8",
    ],
  },
  "autoJudge.set": {
    request: [
      "8a450365af4a8a29c2dee26a1840847789898709f631a4a41cad39d5127be2fa",
      "82d38d7b25999984aa555fc03303f09ddab8a1ad40e37c74873af57a877f4f09",
    ],
    response: [
      "deeb5d21207edcd0ac8d78a35c2e1e64fc3b4d7bac871fc74644c87e6d8c12e3",
      "6da458b4385592e1ae6762583b969eeadcbaf5bb3e795e1be79bd7c34fff9bc8",
    ],
  },
  effective: [
    "52ebd40dda76433f4d3ce7bfdc610a213fad14873caad0aa374341fb8d71380c",
    "5a9ec0e9ac75969cef2598b63b35f254b420a5958d0806fe3491310580a35ecb",
  ],
  blocked: [
    "64911856547c660c0d3c46f8939b6999681a0566817bd5e5cf686caab7eb7b96",
    "ab92c6ed995ddf459d1710bdbf0629369b2f98f3d23a754761001780b8d80eee",
  ],
} as const;

describe("autoJudge.get/set@1.1 freeze", () => {
  it.each(["autoJudge.get", "autoJudge.set"] as const)(
    "keeps the installed %s@1.1 request and response input/output surfaces byte-stable",
    (method) => {
      const contract = hostRpcRegistry[method][1].versions[1].contract;
      expect(contract.schemaVersion).toEqual({ major: 1, minor: 1 });
      expect([
        schemaDigest(contract.requestSchema, "input"),
        schemaDigest(contract.requestSchema, "output"),
      ]).toEqual(V11_DIGESTS[method].request);
      expect([
        schemaDigest(contract.responseSchema, "input"),
        schemaDigest(contract.responseSchema, "output"),
      ]).toEqual(V11_DIGESTS[method].response);
    },
  );

  it("keeps the frozen 1.1 nested effective/blocked surfaces byte-stable", () => {
    expect([
      schemaDigest(autoJudgeEffectiveSchemaV11, "input"),
      schemaDigest(autoJudgeEffectiveSchemaV11, "output"),
    ]).toEqual(V11_DIGESTS.effective);
    expect([
      schemaDigest(autoJudgeBlockedSchemaV11, "input"),
      schemaDigest(autoJudgeBlockedSchemaV11, "output"),
    ]).toEqual(V11_DIGESTS.blocked);
  });

  it("installs the frozen 1.1 contracts, bound to the frozen response copies", () => {
    expect(hostRpcRegistry["autoJudge.get"][1].versions[1].contract).toBe(
      autoJudgeGetV11,
    );
    expect(hostRpcRegistry["autoJudge.set"][1].versions[1].contract).toBe(
      autoJudgeSetV11,
    );
    expect(autoJudgeGetV11.responseSchema).toBe(autoJudgeGetResponseSchemaV11);
    expect(autoJudgeSetV11.responseSchema).toBe(autoJudgeSetResponseSchemaV11);
  });

  it("the frozen 1.1 response copies point at the frozen nested copies, not the live ones", () => {
    expect(
      unwrapNullableOptional(autoJudgeGetResponseSchemaV11.shape.effective),
    ).toBe(autoJudgeEffectiveSchemaV11);
    expect(
      unwrapNullableOptional(autoJudgeGetResponseSchemaV11.shape.blocked),
    ).toBe(autoJudgeBlockedSchemaV11);
    expect(
      unwrapNullableOptional(autoJudgeSetResponseSchemaV11.shape.effective),
    ).toBe(autoJudgeEffectiveSchemaV11);
    expect(
      unwrapNullableOptional(autoJudgeSetResponseSchemaV11.shape.blocked),
    ).toBe(autoJudgeBlockedSchemaV11);

    expect(autoJudgeEffectiveSchemaV11).not.toBe(autoJudgeEffectiveSchema);
    expect(autoJudgeBlockedSchemaV11).not.toBe(autoJudgeBlockedSchema);
    expect(autoJudgeGetResponseSchemaV11).not.toBe(autoJudgeGetResponseSchema);
    expect(autoJudgeSetResponseSchemaV11).not.toBe(autoJudgeSetResponseSchema);
  });
});
