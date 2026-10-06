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
  chatSubscribeV118,
  chatSubscribeV119,
  chatSubscribeV120,
  chatSubscribeV121,
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
// took 1.17 above it, and re-verified after the freeze: identical - and again
// after the Claude-parity freeze put its line above 1.17: identical. The first
// draft of that key was added to the live prompt item in place, which every
// line from 1.13 up reached by reference; this gate caught it on 1.13, and
// the hand-frozen `chatQueuedPromptItemSchemaPreSentFromHost` copy is what
// puts 1.13–1.16 back on their captured values.
//
// 1.17 is captured ON TIME, from main's own bytes at OSS commit da3d4f40d,
// before the Claude-parity surfaces took the line above it. That line had been
// built as 1.17 on a long-lived branch while main minted its own 1.17, so it
// was renumbered rather than folded in: main's line was already on a release
// train. It was re-verified from the tree at OSS commit f82a08de0 before the
// model-routing keys (the settled notice's `receipt`, the queue's
// `pausedReason`) took 1.18 above it, and after that freeze: identical, as is
// every line above. Both keys first reached 1.13–1.17 by reference, through
// the live message bodies and the live queue; the hand-frozen
// `contentBlockSchemaPreReceipt` chain and `chatQueueStateSchemaPrePausedReason`
// are what keep them off. A third `1.18` key, the failed attempt's
// `waitResumesAt`, reached further: every line from 1.10 up bound
// `lastFailedAttemptSchema` by reference (1.10-1.12 through its pre-`auto`
// `.extend`, 1.13-1.17 through the windowed snapshot and the shared
// `turnStateChanged` frame), and all eight digests moved. The hand-frozen
// `lastFailedAttemptSchemaPreWaitResume` puts them back, identical.
//
// 1.18 is captured ON TIME, from main's own bytes at OSS commit 5226395c0,
// where it was the live line (model routing, released on `release-v1.4.0`),
// before the Claude-parity surfaces - renumbered a second time for it - took
// the line above it. The merged tree's frozen 1.18 reproduces main's digests
// exactly, server and client frames alike, and so does every line below it;
// re-verified from main's bytes at OSS commit a525056d8, after skeleton resume
// took 1.19 above it: identical.
//
// 1.19 is captured ON TIME, from main's own bytes at OSS commit a525056d8,
// where it was the live line (skeleton resume), before the Claude-parity
// surfaces - renumbered a third time for it - took 1.20 above it. The merged
// tree's frozen 1.19 reproduces main's digests exactly.
//
// 1.7–1.19 were re-captured when the `commandcode` harness id joined the live
// enum. Each line moved by exactly one enum member at every `harnessId` site
// and by one arm in the message `sessionAnchor` and runtime-event `anchor`
// unions, and by nothing else: with that member and that arm stripped, every
// current digest equals the one pinned before. 1.0–1.6 bind the pre-Reasonix
// copies and did not move. This is the class the four standing
// `compat-exceptions.json` entries name (`**.harnessId.enum`,
// `**.anchor.anyOf[*]`, `**.sessionAnchor.anyOf[*].anyOf[*]` and
// `**.event.anyOf[*]` on `chat.subscribe` server frames). The new id is held
// off released lines by the host's per-harness minimum-minor table
// (`commandcode: 21`), not by these schemas. The one leaf that IS frozen on
// 1.9–1.20 is `rowContext.sessionAnchor`, through
// `transcriptRowContextSchemaPreCommandCode`.
//
// 1.20 is captured LATE, from our own render: on the harness axis it cannot
// match the bytes main shipped, since main's 1.20 predates the id. 1.21 is the
// live line, the first that may name `commandcode`.
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
    "2972058fc6f2bf8bb69597c5e1d0dfdab98cf59618a3c63498a326400b2cf265",
    "a9cfec2289a5da3e3cf30e405b94a1251f74c25fb99852d1f24399530f7d27aa",
  ],
  8: [
    "88f63c0469306ed76c287a83617b7c384166f137eb8568ee15cb8d3de5ed8772",
    "a1eb1f9df80b952a15412cb5beb25f50b93b3d6f7a55693e0e3a07c040598738",
  ],
  9: [
    "a45d5ebfe9b89eba5d983aecdca1b2e7c429efc568da42f8cf272d22dacaec67",
    "322b2339d59ed6d917892f36b69b96ec43e758007f37c38a32d37d51ff8b0b50",
  ],
  10: [
    "21d0548f2b4968208594300aeff12317e9cff382bf69b51ba6005f547b9c7a45",
    "35035b2e5d4b8825f18ad0d1fb34742d6421e86332614953fc2fa7994ee018c3",
  ],
  11: [
    "084bcfe7661f24efafbe36d9aea590f14772f7ecfbeab7c79022e4379c18c4a4",
    "ce0f42c2622d848af1a2d003b65504376fe387aaaec8715b3b134114766446ea",
  ],
  12: [
    "9780f12940560a78d77c3445e23be894d7ad4935f05c3193f0676e2cffe0a283",
    "51806edbbf4a8cb2ab3a7b9e4cd464857001c3488ac97c0e6921efe80a61ca1d",
  ],
  13: [
    "a8bf9702a714b5585634fc4a31ac90c7e1867e8d696f78149f8ebff0e06d0696",
    "29cb1baa74dff1262c102f425b260b8b7fe40c734140bf356502d140ed54a185",
  ],
  14: [
    "ac5f0f6f092b320b1f69687c3f0b994943603652fee4093de17f3d043998b39a",
    "bf654ab31bcf052575c328acbd430791874328d5a6566a8f86ede62f184d531f",
  ],
  15: [
    "cba84866e0cfba0a5e332c5d37d7d1693f611b27cec639a12ca9c3ab3f523f7c",
    "fd9d5274d3e103c2f80ee6192a263dcc2c936b4b7d6c06644749a8168c766537",
  ],
  16: [
    "f903b0516835c52a7577fc97f1dc2b4a9f5d55f81c36c0996566e3ee3b47b0ba",
    "3aceaabf237e5e049a0b4f5e593fb692104db9dda16a0b846dacfcc5b4175214",
  ],
  17: [
    "64db3e02ed3e0268eb98c1b3a11a9d6989e0c680e7a53a15a939c3512e996951",
    "fc8c87edb1549033c42d2b2034a781a7e15f04de94456a910e4b38ca2ef0677f",
  ],
  18: [
    "7a4f2062af5aa44e4a6b5535653e6606ecd2c1352906a9ad10a26f69fe46909f",
    "c4d342f3adf2eaacef9d36a2a7e1551f58bf1797b1766cbc72ca84210713f73f",
  ],
  19: [
    "d450239c4feb1db24a49fa003ed6474137fab7015b5ede8a08dc2429a6adaeed",
    "01e75b75c973a7d40e3bd2b3a23aa13f14e8d1dcdbd1a78969b0f97d9be5b8e5",
  ],
  20: [
    "463161909221ea897690842b41ee10abae7214f1055d0ed16f56b17d9cbbb3cc",
    "5c81ac906499c0383bcb6a21e3f148b0ac9f3d2214d24b3c6700a454814908a1",
  ],
  21: [
    "95eb83c260fa3524bcf2a276bcc7b3e21f36da417803d484580aad803eab4c8d",
    "df9bbe86f245826e18b231b0266dc27364e9cf82d825f3672f48633febd3825a",
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
  chatSubscribeV118,
  chatSubscribeV119,
  chatSubscribeV120,
  chatSubscribeV121,
] as const;

describe("chat.subscribe placement freeze", () => {
  it("keeps every 1.0–1.21 server schema input/output surface byte-stable", () => {
    for (const contract of contracts) {
      const minor = contract.schemaVersion.minor;
      expect([
        schemaDigest(contract.serverFrameSchema, "input"),
        schemaDigest(contract.serverFrameSchema, "output"),
      ]).toEqual(SERVER_FRAME_DIGESTS[minor]);
    }
  });

  it("1.20 and 1.21 server frames differ only in the row-context session anchor", () => {
    const anchor = {
      harnessId: "commandcode",
      hostId: "host-1",
      sessionId: "session-1",
      sessionWorkspaceSnapshot: {
        workspaceKind: "session-snapshot",
        primaryWorkspace: "/repo",
        secondaryWorkspaces: [],
      },
      createdAt: 1,
      coveredUntilMessageId: null,
    };
    const rangeFrame = (rowContext: Record<string, unknown>) => ({
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "range-1",
        epoch: 0,
        fromOrdinal: 0,
        rowIds: [],
        messages: [],
        events: [],
        rowContext,
        reachedStart: true,
        reachedEnd: true,
      },
    });
    // Positive control: with no anchor the same frame parses on both lines.
    expect(
      chatSubscribeV120.serverFrameSchema.safeParse(rangeFrame({})).success,
    ).toBe(true);
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(rangeFrame({})).success,
    ).toBe(true);
    const withAnchor = rangeFrame({ "row-1": { sessionAnchor: anchor } });
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(withAnchor).success,
    ).toBe(true);
    expect(
      chatSubscribeV120.serverFrameSchema.safeParse(withAnchor).success,
    ).toBe(false);
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
