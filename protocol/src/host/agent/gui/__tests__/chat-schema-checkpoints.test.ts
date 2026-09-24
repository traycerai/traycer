import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  autonomousResumeBlockSchema,
  autonomousResumeBlockSchemaV18,
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
  chatSubscribeV110,
  chatSubscribeV111,
  chatSubscribeV112,
  chatSubscribeV113,
  chatSubscribeV114,
  chatSubscribeV115,
  chatSubscribeV116,
  chatSubscribeV117,
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

// Captured from main commit 6fcb2af85 before adding placement. These
// historical 1.0–1.8 surfaces must not follow the current message schema.
// 1.9 was captured from main commit 68125d26d, the line as the v1.3.x
// staging builds shipped it, when provider fallback took 1.10 above it.
// 1.10 was captured from main commit 320fc0bac, the line as the staging
// builds shipped it, when the shell host on a resume trigger and on the
// queued managed-command item took 1.11 above it.
//
// 1.11 and 1.12 are captured LATE, and differently: the rule above says
// capture a line when the next minor opens over it, and that did not happen
// for either - main minted 1.12 over 1.11 without capturing, and this branch
// minted 1.13 over 1.12 without capturing. Both are recorded here from OUR
// render, not from the commit that shipped them.
//
// So read these two for less than the ones above. A digest taken from our own
// tree cannot prove the line still matches the bytes main shipped; it only
// freezes it from here on. That is worth having anyway, and more here than
// anywhere above, because 1.11 and 1.12 are the only two lines in this table
// that are RECONSTRUCTIONS - assembled out of `...PreAuto` pieces by a merge
// rather than inherited intact - so they are the entries most able to drift
// under an edit nobody meant to be a wire change. If a faithfulness check
// against main's bytes is ever wanted, take main's own digest and expect a
// benign difference: `chatQueuedItemSchemaPreAuto`'s comment records that
// `z.union` and `z.discriminatedUnion` render `anyOf` versus `oneOf` and move
// every field path beneath them.
// 1.7–1.12 were re-captured when the grok session anchor gained its nullable
// `grokPromptIndex` (default null). 1.0–1.6 bind hand-frozen pre-index anchor
// copies and did not move; 1.7 and 1.8 reach the live user-message and
// runtime-event schemas by reference (the two `**.grokPromptIndex` entries in
// `compat-exceptions.json` record why that is tolerated), and 1.9 onward carry
// the field live.
//
// 1.13 is captured ON TIME, the way the rule asks: taken from the tree at OSS
// commit c18aba718, before the port-forward surface took 1.14 above it, and
// re-taken after the freeze to confirm the two agree. It is the first entry
// since 1.10 that proves the freeze rather than merely starting one. Then
// re-captured with 1.7–1.12 above when the grok anchor gained
// `grokPromptIndex`: main made that change on its live line, which is 1.13,
// so the frozen copy here (which reaches the anchor by reference) moved with
// it. The values below are main's own live-1.13 digests at that merge, and
// the frozen copy on the merged tree reproduces them exactly.
//
// 1.14 is captured LATE, like 1.11/1.12: the rule asks for a capture when the
// next minor opens over it, and that did not happen here either - 1.15
// (main's message-delivery line) opened over 1.14 without a capture, so this
// is our own render, not the bytes the port-forward line shipped with.
//
// 1.15 is captured ON TIME, from the tree before 1.16 opened above it for the
// approval card's judge-reason tier, and re-verified after that freeze:
// identical.
//
// 1.16 is captured ON TIME, from main's own bytes at OSS commit 0014b742d,
// before the sender-host key (`sentFromHostId` on the queued prompt item)
// took 1.17 above it, and re-verified after the freeze: identical. The first
// draft of that key was added to the live prompt item in place, which every
// line from 1.13 up reached by reference; this gate caught it on 1.13, and
// the hand-frozen `chatQueuedPromptItemSchemaPreSentFromHost` copy is what
// puts 1.13–1.16 back on their captured values.
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
    "035b1bdd21da66e03d29dae9fe140c0ca15b3688c4b8b6937a2bbf97979c4539",
    "672452c0457e22f05f13eab07f73661639027b5c4ab9b4e029bd7ccccf5b0557",
  ],
  8: [
    "7572ac8bdca83e79f94d67cd0e3bd6ae4521f5fa204976b6ffda2307c0384d7d",
    "7489cce3dd9e1c6dbe5709c5f3d3d9b3905e08cbd769de00aa8bfdbd0c63af91",
  ],
  9: [
    "a236937293d40c46f02c34fcf4c156ee44b8a0c5d3b4d10613817fd82be44a30",
    "669c98b7f46cd3a4d5a20c037cbc4b8b9ef055ad0a08750e395bf746e3932d54",
  ],
  10: [
    "a50e4b67a7847bc2016ded46cc45ce0ae2ff6ff3166242fc1ba2421f76377a7f",
    "49980dad9ffe9c9ff93146d285d5513745b5f231a70f7bc03911199bbb74fae8",
  ],
  11: [
    "ad656a7ced38c2e9194ef1633dff8d5c7f17047471751ba12deab114e1abb354",
    "eb8902c993b15f4bdc9cf1bcf33b8d4d56ed6e074fc1b121e129371c218060fb",
  ],
  12: [
    "1de46aa26aebc0b902d91cf0b108e9b34cb0906bbd8a03dee5a60627c9e135d3",
    "882f4af25ef15550956d59c48c622c0c592f3c313b15b44b337e4a5b398bb809",
  ],
  // RE-CAPTURED for agent identity, and it is the only entry that moved -
  // `1.0`-`1.12` are byte-identical across that change, which is the freeze
  // reporting that it held.
  //
  // `1.13` is the first line that binds the LIVE chat record and the LIVE
  // settings tuple by reference (`1.7`-`1.12` sit on the `...PreAuto` copies),
  // so the three new fields - `chat.kind`, `chat.evolutionTurnsSinceReview` and
  // `settings.identityId` - land on it the moment they land on the persisted
  // shapes. Nothing below it can follow, by construction.
  //
  // Re-capturing rather than freezing `1.13` properly is a deliberate call and
  // a narrow one: released `chat.subscribe` is `1.8` (`host-v1.3.1`), so every
  // line from `1.9` up is unreleased and no peer in the field speaks this one.
  // The entry's value here is as a DRIFT tripwire over a superseded line, and
  // it did its job - it is why this comment exists rather than the change
  // passing unnoticed. If `1.13` ever needs to be frozen against the live
  // shapes for real, that is hand-frozen copies of `chatSchema` and the run
  // settings tuple, the way `chatSchemaV16` and `chatRunSettingsSchemaPreAuto`
  // are - not an edit here.
  13: [
    "5cd4121cfd8360c6ca0bc41944b46e133004ed027c109e8853970df6251b59ca",
    "22d50843f7b95a6be5d9869b8387255c24f81a5314f44fc96dccdb07a7c7dd74",
  ],
  // `1.14`-`1.16` RE-CAPTURED on the tgill-release-train-2 merge of the agent
  // identity stack, for the same reason and under the same rule as `1.13`
  // above: they bind the live chat record and settings tuple by reference, so
  // `chat.kind`, `chat.evolutionTurnsSinceReview` and `settings.identityId`
  // move them the moment they land. Released `chat.subscribe` is still `1.8`;
  // `1.0`-`1.12` are byte-identical across the merge.
  14: [
    "2debf2e6043f185a50d4dcdaa0560af22da5e2a08d995efc84dade97e7285478",
    "f36e1d5e008a2557a1f87183fe2b3dacc15a7bc8e849a6f58a75e3805a5224b9",
  ],
  15: [
    "3e1998c45b5cb09d2d005ab00562c8b98b179804f396c7919110cf9e62382086",
    "33b7c62df6cfaefadf46f207774a445aaf2eab47f19e5ced88ebd11de6fbd340",
  ],
  16: [
    "944de3a5f3e27b39673eaf6d76d8165c2993161a04c7772b50a5c8d35a4a5663",
    "822b1b2217a53a5570acd151cfcac14d1d5ed77a03167a74d0a21d1a5847ef90",
  ],
  // 1.17 is captured ON TIME, from the train tree at OSS commit 2e88f7f4c,
  // before the bound identity on the active turn (`activeTurn.identityId`)
  // took 1.18 above it, and re-verified after the freeze: identical.
  17: [
    "0526bebdadfd28288c29924257acc2f045a092d409f588a1189448895d56e04c",
    "3fb2a9327f872de86ee4ba9133f8203157b7240db280c9b43756e5f2f0686c8f",
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
  chatSubscribeV110,
  chatSubscribeV111,
  chatSubscribeV112,
  chatSubscribeV113,
  chatSubscribeV114,
  chatSubscribeV115,
  chatSubscribeV116,
  chatSubscribeV117,
] as const;

describe("chat.subscribe placement freeze", () => {
  it("keeps every 1.0–1.17 server schema input/output surface byte-stable", () => {
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
    const old = autonomousResumeBlockSchemaV18.parse(oldStored);
    expect(old).not.toHaveProperty("deliveryPlacement");
    expect(old.triggers.map((trigger) => trigger.kind)).toEqual([
      "monitor",
      "wakeup",
    ]);
    const oldEncoded = autonomousResumeBlockSchemaV18.encode(old);
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
        z.toJSONSchema(autonomousResumeBlockSchemaV18, {
          io: "input",
        }),
      ),
    ).not.toContain("deliveryPlacement");
    expect(
      JSON.stringify(
        z.toJSONSchema(autonomousResumeBlockSchemaV18, {
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
