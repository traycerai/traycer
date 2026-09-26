import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  autoJudgeBlockedSchemaV11,
  autoJudgeEffectiveSchemaV11,
  autoJudgeGetResponseSchema,
  autoJudgeGetResponseSchemaV12,
  autoJudgeGetV12,
  autoJudgeSelectionSchema,
  autoJudgeSelectionSchemaPreEffort,
  autoJudgeSetRequestSchema,
  autoJudgeSetRequestSchemaPreEffort,
  autoJudgeSetResponseSchema,
  autoJudgeSetResponseSchemaV12,
  autoJudgeSetV12,
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

// `autoJudge.get@1.2` and `autoJudge.set@1.2` are FIXED: a desktop built from
// `main` at traycer#2162 negotiates them and reads the pre-effort selection
// (`harnessId`, `model`, `profileId`) plus `lastSelection`. `1.3` opened above
// them for the judge's effort, and the `1.2` responses became hand copies
// (`...V12`) while the head kept the canonical names.
//
// Captured from OSS commit d98934d58 - `main` at traycer#2162, where 1.2 was
// still the head and these were the canonical schemas - from a `git archive`
// of that commit. Never recompute these from the current tree and paste: they
// pin the bytes a main-built desktop speaks. The current tree must reproduce
// them unchanged.
//
// The requests are the `1.0` ones, shared by reference with 1.0 and 1.1, so
// they carry the V10 digests. The response pair is shared across the two
// methods, because the 1.2 responses are the same shape.
const V12_DIGESTS = {
  "autoJudge.get": {
    request: [
      "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
      "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
    ],
    response: [
      "20f5de249513c4c2c85f5eedf2e56172ee41196a9fb5ec79793fb8cc75c293db",
      "2d03d13faca8737237d858a804cc3ecb8862e5827b035ebf9c8dcc15900554bb",
    ],
  },
  "autoJudge.set": {
    request: [
      "8a450365af4a8a29c2dee26a1840847789898709f631a4a41cad39d5127be2fa",
      "82d38d7b25999984aa555fc03303f09ddab8a1ad40e37c74873af57a877f4f09",
    ],
    response: [
      "20f5de249513c4c2c85f5eedf2e56172ee41196a9fb5ec79793fb8cc75c293db",
      "2d03d13faca8737237d858a804cc3ecb8862e5827b035ebf9c8dcc15900554bb",
    ],
  },
} as const;

describe("autoJudge.get/set@1.2 freeze", () => {
  it.each(["autoJudge.get", "autoJudge.set"] as const)(
    "keeps the fixed %s@1.2 request and response input/output surfaces byte-stable",
    (method) => {
      const contract = hostRpcRegistry[method][1].versions[2].contract;
      expect(contract.schemaVersion).toEqual({ major: 1, minor: 2 });
      expect([
        schemaDigest(contract.requestSchema, "input"),
        schemaDigest(contract.requestSchema, "output"),
      ]).toEqual(V12_DIGESTS[method].request);
      expect([
        schemaDigest(contract.responseSchema, "input"),
        schemaDigest(contract.responseSchema, "output"),
      ]).toEqual(V12_DIGESTS[method].response);
    },
  );

  it("installs the fixed 1.2 contracts, bound to the pre-effort copies", () => {
    expect(hostRpcRegistry["autoJudge.get"][1].versions[2].contract).toBe(
      autoJudgeGetV12,
    );
    expect(hostRpcRegistry["autoJudge.set"][1].versions[2].contract).toBe(
      autoJudgeSetV12,
    );
    expect(autoJudgeGetV12.responseSchema).toBe(autoJudgeGetResponseSchemaV12);
    expect(autoJudgeSetV12.responseSchema).toBe(autoJudgeSetResponseSchemaV12);
    expect(autoJudgeSetV12.requestSchema).toBe(
      autoJudgeSetRequestSchemaPreEffort,
    );
    expect(autoJudgeSetV12.requestSchema).not.toBe(autoJudgeSetRequestSchema);
  });

  it("the fixed 1.2 response copies point at the pre-effort selection and the frozen 1.1 nested copies, not the live ones", () => {
    for (const response of [
      autoJudgeGetResponseSchemaV12,
      autoJudgeSetResponseSchemaV12,
    ]) {
      expect(response.shape.selection.unwrap()).toBe(
        autoJudgeSelectionSchemaPreEffort,
      );
      expect(unwrapNullableOptional(response.shape.lastSelection)).toBe(
        autoJudgeSelectionSchemaPreEffort,
      );
      expect(unwrapNullableOptional(response.shape.effective)).toBe(
        autoJudgeEffectiveSchemaV11,
      );
      expect(unwrapNullableOptional(response.shape.blocked)).toBe(
        autoJudgeBlockedSchemaV11,
      );
    }

    expect(autoJudgeSelectionSchemaPreEffort).not.toBe(
      autoJudgeSelectionSchema,
    );
    expect(autoJudgeGetResponseSchemaV12).not.toBe(autoJudgeGetResponseSchema);
    expect(autoJudgeSetResponseSchemaV12).not.toBe(autoJudgeSetResponseSchema);
  });
});
