import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  autoJudgeGetResponseSchemaV10,
  autoJudgeGetV10,
  autoJudgeSetResponseSchemaV10,
  autoJudgeSetV10,
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

// `autoJudge.get@1.0` and `autoJudge.set@1.0` shipped in
// `host-v1.3.2-staging.39`, so both are frozen. `1.1` opened above them for
// Automatic's `fallback` arm, and the `1.0` responses became hand copies
// (`...V10`) while the head kept the canonical names.
//
// Captured ON TIME, from OSS commit 1b6c05a3b - the parent of the commit that
// opened 1.1 - by rendering that commit's own `auto-mode/contracts.ts`; the
// modules it imports (`framework/`, `host/agent/shared.ts`) are unchanged
// since. The response digests also match the reviewer's independent capture
// from a protocol-only archive of the same commit. The current tree
// reproduces all eight exactly.
//
// Each response pair is shared across the two methods, because the 1.0
// responses are the same shape. The requests are not frozen copies: 1.1
// reuses them by reference, so a change to either one (or to the
// `autoJudgeSelectionSchema` that `set`'s request reaches) is a change to
// the released 1.0 line, and fails here until it is frozen first.
const V10_DIGESTS = {
  "autoJudge.get": {
    request: [
      "93ab7499dc3c616f8db8780fed0d9f69270803cda913882ad2ef3943db8d7225",
      "71fc596a20f27da3dec80050e5d1f553eba34aea24c2853b853488a811e6b892",
    ],
    response: [
      "4e41167cbfcd7d3fa3c66164431ccdfacfc06e54b7b6e6ad7db7dbf7f416bb15",
      "bf26f33bcbf886c7db0c5ca25b9033daf28732127ec33741e3a3f426af316d8a",
    ],
  },
  "autoJudge.set": {
    request: [
      "8a450365af4a8a29c2dee26a1840847789898709f631a4a41cad39d5127be2fa",
      "82d38d7b25999984aa555fc03303f09ddab8a1ad40e37c74873af57a877f4f09",
    ],
    response: [
      "4e41167cbfcd7d3fa3c66164431ccdfacfc06e54b7b6e6ad7db7dbf7f416bb15",
      "bf26f33bcbf886c7db0c5ca25b9033daf28732127ec33741e3a3f426af316d8a",
    ],
  },
} as const;

describe("autoJudge.get/set@1.0 freeze", () => {
  it.each(["autoJudge.get", "autoJudge.set"] as const)(
    "keeps the installed %s@1.0 request and response input/output surfaces byte-stable",
    (method) => {
      const contract = hostRpcRegistry[method][1].versions[0].contract;
      expect(contract.schemaVersion).toEqual({ major: 1, minor: 0 });
      expect([
        schemaDigest(contract.requestSchema, "input"),
        schemaDigest(contract.requestSchema, "output"),
      ]).toEqual(V10_DIGESTS[method].request);
      expect([
        schemaDigest(contract.responseSchema, "input"),
        schemaDigest(contract.responseSchema, "output"),
      ]).toEqual(V10_DIGESTS[method].response);
    },
  );

  it("installs the frozen 1.0 contracts, bound to the frozen response copies", () => {
    expect(hostRpcRegistry["autoJudge.get"][1].versions[0].contract).toBe(
      autoJudgeGetV10,
    );
    expect(hostRpcRegistry["autoJudge.set"][1].versions[0].contract).toBe(
      autoJudgeSetV10,
    );
    expect(autoJudgeGetV10.responseSchema).toBe(autoJudgeGetResponseSchemaV10);
    expect(autoJudgeSetV10.responseSchema).toBe(autoJudgeSetResponseSchemaV10);
  });
});
