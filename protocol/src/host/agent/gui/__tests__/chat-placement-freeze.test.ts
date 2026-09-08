import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  autonomousResumeBlockSchema,
  autonomousResumeBlockSchemaPrePlacement,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  chatSubscribeV18,
  chatSubscribeV19,
} from "@traycer/protocol/host/agent/gui/subscribe";

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

// Captured from baseline commit 5f81fdc. These are the host -> GUI wire
// surfaces for every released/current minor; changing one means a historical
// line followed a live schema during the placement refactor.
const SERVER_FRAME_DIGESTS = {
  0: [
    "ca66e3d49016048e7390b4c9904f6978f7c31d9098dd2ce4369f51239d0f411e",
    "27fdc1ddb62b264e9cdceb1033936cb3d68b3d9b719fba30962e4074157b2ea5",
  ],
  1: [
    "38436cf5acff1c838764a93b6401547e1340e66417553ffcf48028ff59649c3c",
    "a2f86a8e0c41a35748ed5800868e1774b42fa68c9516ea0d6f4306daf60db2b1",
  ],
  2: [
    "330c139256e35abe1755adc18f55ac928a582609af38e987ba5a5fe5857ccafd",
    "ed339c3fc86f3151921e5a5223f69050fe22615e465c492eea2caf25e3be3fdf",
  ],
  3: [
    "a79e64147b43f0f77cc9d15329a7494ecdcaece4db9271b5786ad00cc0a33945",
    "a176f6a4d1626be4d33cea693c9c3e436003aad463071fbcb20c87b6f0f14459",
  ],
  4: [
    "401f70f67638c2281a2224c889319c995e887f6ff13145699ff6371d11f18c2f",
    "3bd617663722cf012d9aca7567bbabab2fde4cbbe9203dea9ac46948b9843479",
  ],
  5: [
    "e9fb5fcd07bdc3fc49c996a88aa2d0f02e0e2a410e86456fa2b4059b213e6be8",
    "e0b1fb7f37aa49fe786102a39a2ef5b04e8a252e18bc1bac3c451b45210d9391",
  ],
  6: [
    "9f9ac38ef7223f50aa71d10fc14f8384b308fb1c32d13b8655ae215ef9ab6057",
    "c145b4fff10cde51da38b4ae9a844647353e2f29a3ec901922e6ca692f535d52",
  ],
  7: [
    "9cf943da7a3a66f76509b6e55b9bf9a52b7ae8a5fc5c835cb3acbb02239aafa2",
    "c0a654453d8bcc930d35bea29b4bde779705d606ea212504f3f0bc05527c4174",
  ],
  8: [
    "d48c2215f6c49dec3afd5fc271bd6970c52fb9facecaeed5552d14c3b3bd6895",
    "5228f20b183f6e3c7a3d80e280e532befc35570d7437bae03d7f7423424071d6",
  ],
  9: [
    "1d76b7bba58b2125c1f178a8f3253fb3e78b1abe18a1a604f407d5cc5a761b4a",
    "9b0a7ad60cade803ced4099e5eb3aebfff4f381ba4c74f267fda1763e7c7cc34",
  ],
} as const;

const contracts = [
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  chatSubscribeV18,
  chatSubscribeV19,
] as const;

describe("chat.subscribe placement freeze", () => {
  it("keeps every 1.0–1.9 server schema input/output surface byte-stable", () => {
    for (const contract of contracts) {
      const minor = contract.schemaVersion.minor;
      expect([
        schemaDigest(contract.serverFrameSchema, "input"),
        schemaDigest(contract.serverFrameSchema, "output"),
      ]).toEqual(SERVER_FRAME_DIGESTS[minor]);
    }
  });

  it("keeps old notifications placement-free while current explicit placement survives", () => {
    const oldStored = {
      blockId: "resume-1",
      status: "completed",
      timestamp: 1000,
      type: "autonomous_resume",
      triggers: [
        {
          kind: "monitor",
          title: "Monitor",
          status: "completed",
          summary: "done",
        },
      ],
      wakeTriggers: [{ title: "Wake", status: "failed", summary: "late" }],
    } as const;
    const old = autonomousResumeBlockSchemaPrePlacement.parse(oldStored);
    expect(old).not.toHaveProperty("deliveryPlacement");
    expect(old.triggers.map((trigger) => trigger.kind)).toEqual([
      "monitor",
      "wakeup",
    ]);
    const oldEncoded = autonomousResumeBlockSchemaPrePlacement.encode(old);
    expect(oldEncoded).not.toHaveProperty("deliveryPlacement");
    expect(oldEncoded.wakeTriggers).toEqual([
      {
        title: "Wake",
        status: "failed",
        summary: "late",
        blockId: "",
        outputFile: null,
      },
    ]);
    expect(
      JSON.stringify(
        z.toJSONSchema(autonomousResumeBlockSchemaPrePlacement, {
          io: "input",
        }),
      ),
    ).not.toContain("deliveryPlacement");
    expect(
      JSON.stringify(
        z.toJSONSchema(autonomousResumeBlockSchemaPrePlacement, {
          io: "output",
        }),
      ),
    ).not.toContain("deliveryPlacement");

    const currentMissing = autonomousResumeBlockSchema.parse({
      blockId: "resume-2a",
      status: "completed",
      timestamp: 1000,
      type: "autonomous_resume",
      triggers: [],
    });
    expect(currentMissing.deliveryPlacement).toBeNull();

    const current = autonomousResumeBlockSchema.parse({
      blockId: "resume-2",
      status: "completed",
      timestamp: 1000,
      type: "autonomous_resume",
      deliveryPlacement: "in_turn",
      triggers: [],
    });
    expect(current.deliveryPlacement).toBe("in_turn");
    expect(autonomousResumeBlockSchema.encode(current).deliveryPlacement).toBe(
      "in_turn",
    );
  });

  it("round-trips wakeTriggers in stable order and applies historical defaults", () => {
    const parsed = autonomousResumeBlockSchema.parse({
      blockId: "resume-3",
      status: "completed",
      timestamp: 1000,
      type: "autonomous_resume",
      triggers: [
        {
          kind: "monitor",
          title: "Monitor",
          status: "completed",
          summary: "done",
        },
      ],
      wakeTriggers: [{ title: "Wake", status: "failed", summary: "late" }],
    });
    expect(parsed.triggers.map((trigger) => trigger.kind)).toEqual([
      "monitor",
      "wakeup",
    ]);
    expect(parsed.triggers[1]).toMatchObject({
      kind: "wakeup",
      blockId: "",
      outputFile: null,
      mcp: null,
      live: false,
      managedCommand: null,
    });
    expect(autonomousResumeBlockSchema.encode(parsed).wakeTriggers).toEqual([
      {
        title: "Wake",
        status: "failed",
        summary: "late",
        blockId: "",
        outputFile: null,
      },
    ]);
  });

  it("keeps 1.7 whole snapshots separate from 1.8 tail/range bodies", () => {
    const v17Snapshot = chatSubscribeV17.serverFrameSchema.def.options[0];
    const v18Snapshot = chatSubscribeV18.serverFrameSchema.def.options[0];
    const v18Range = chatSubscribeV18.serverFrameSchema.def.options.find(
      (option) => option.shape.kind.value === "range",
    );
    expect(v17Snapshot.shape.snapshot.shape.chat.shape).toHaveProperty(
      "messages",
    );
    expect(v17Snapshot.shape.snapshot.shape.chat.shape).toHaveProperty(
      "events",
    );
    expect(v18Snapshot.shape.snapshot.shape).toHaveProperty("tail");
    expect(v18Snapshot.shape.snapshot.shape).not.toHaveProperty("messages");
    expect(Object.keys(v18Range?.shape ?? {})).toContain("range");
  });
});
