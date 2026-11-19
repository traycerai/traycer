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
  chatSubscribeV122,
  chatSubscribeV123,
  chatSubscribeV124,
  chatSubscribeV125,
  chatSubscribeV126,
  chatSubscribeV127,
  chatSubscribeV128,
  chatSubscribeV129,
  chatSubscribeV130,
  chatSubscribeV131,
  chatSubscribeV132,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { toCanonicalJsonSchema } from "@traycer/protocol/framework/json-schema-fingerprint";

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
    .update(JSON.stringify(canonical(toCanonicalJsonSchema(schema, { io }))))
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
// match the bytes main shipped, since main's 1.20 predates the id.
//
// 1.21 is captured ON TIME, from the tree before the open-harness-id line took
// 1.22 above it: the last line whose heard-from leaves (agent senders, event
// actors, provider notices, plan sources, session announcements) are still the
// closed enum, and the first that may name `commandcode`. Its server-frame
// union is the closed live `chatSubscribeWindowedServerFrameSchema`, which the
// host builds; 1.22 binds its open twin.
//
// 1.22 is main's released line, frozen byte for byte: it reopens exactly those
// heard-from leaves to a string (`open-harness-wire.ts`) and moves nothing
// else, so the 1.0-1.21 digests above did not change when it opened. It does
// NOT carry the tool-call MCP App stamp.
//
// 1.23 adds the MCP App stamp. The PreMcpApp leaves keep it off older lines.
// Entries 1.23–1.27 were regenerated when the never-released page stamp was
// removed. The released 1.0–1.22 digests remain unchanged.
// Entries 1.23–1.32 were regenerated again when the assistant row gained the
// bot channel's optional `announcement` in place (no release carries 1.23 or
// above); 1.0–1.22 did not move.
// Entries 1.23–1.32 were regenerated a third time when the assistant row
// gained the optional `options` (a bot reply's choices) and the announcement
// kind gained `question` in place (Tracy Bots T46b); 1.0–1.22 did not move.
// Entries 1.23–1.32 were regenerated a fourth time when a bot channel's rows
// gained the direct reply mode in place (Tracy Bots T52): a user row's
// conversation request the optional `direct`, an assistant row the optional
// `repliesTo`; 1.0–1.22 did not move.
// Entries 1.23–1.32 were regenerated a fifth time when the chat record gained
// the optional `opencodeLine` (OpenCode 2) in place, above the T52 fields;
// 1.0–1.22 did not move.
// Entries 1.23–1.32 were regenerated a sixth time when a bot's row gained the
// optional `question` (Tracy Bots T91, a question asked without waiting) and
// a user row the optional `questionAnswer`, in place; 1.0–1.22 did not move.
// Entries 1.23–1.32 were regenerated a seventh time when a bot's row gained
// the optional `surface` (Tracy Bots T89, what in a task the post points
// at), in place, and again when its browser kind gained the park's id;
// 1.0–1.22 did not move.
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
    "56e335b905e9fc1ea1ecc430d2e0b1a614946d8ef48f6b7476071189eb5498a8",
    "c9ffb457f5a7610f343f7ce0a747ff01c4536a8b498f83c00dcb9e671d734258",
  ],
  8: [
    "ae93abefa774ccb48a554a05f4eb5293e3765f4a161e32b8be202351a6f1f868",
    "c886ff4277701f51c3416789ec6b03ca2d8d2897b4022849cfa382c96ffc705b",
  ],
  9: [
    "f20874d46e386797167248d503ff9037f178db61067551a9997e4a8dd2bf83e5",
    "6a1aa1d39123da798c601e9a57fdf868add0598bc6cc67cb0e0d2c9ff553b143",
  ],
  10: [
    "1bb5d282f0cd3409374fc552b4f7923d71fd5663273da54f7a363677be2cee67",
    "3d1eeb963ee7fed1ecc9e65e8c9994cec250e93fca6985cd67e3e7003726d76e",
  ],
  11: [
    "16714072b3dc0e5160b26b0537ef6a64660a6c8042bc8f68a0e0f415fe3f403f",
    "8fd39ec55e6bf2fd50a13033a0cffcfd125c5e14ab23349cf33ef41618ec720a",
  ],
  12: [
    "841912e96e07edb4a4052cb3c37c74beb676b6cd738d1fbf0d986c86cbc84b15",
    "c45d33081830c87655deebb5cdd80e9a28177818f218f2fb84a0e5ad9c1e3633",
  ],
  13: [
    "a93f998496c742f9eb0795d36b369b6ffe89d056c072a5d52af4d460f763a1f1",
    "d0eb0c1992a3af01bbc16b66e68df54174d051b39a94a37f3dda7b2603aeeb7d",
  ],
  14: [
    "1b996fb5ac09c16ac912e9ae2db5dab5083b10498b3098923c35c213029ea057",
    "511d8ed913afe90e144ecdb0f1be329f8c81551197e9b61d65d01801e14738d1",
  ],
  15: [
    "0318ee2cdad8420507c1b6983461d640755b7be732585afdb349689ddd1a9304",
    "c7dd9d0ee1649817d1eed914b74d3debc3a099742a37cb12a626bd9f264b3786",
  ],
  16: [
    "f57d9ccd0c806746298eb71cd749b5667116dd128eb6ae10122bc214cf74dc6b",
    "cecc39bdee5de1c2258a29c4e66d10016a1bcdc6d96121650c5c8344c1384c0d",
  ],
  17: [
    "b0ddd3a28d218d5e8aebe45a4143c421196c475dc79baf2f8736a7c028aa8fc7",
    "bbab93c8b75fc0de62121f9182872d356dcec735c20778fd7d8109e4cbf4776c",
  ],
  18: [
    "d37320847eba9431b1a2e0bac3a6cec80f6ab99b3400f970f130076831ad660a",
    "db6240e8958d5e473a061e1ef9c4b91fbd12ca21b760a37107e96838f7c5f2e2",
  ],
  19: [
    "8f22b95dbc7f2f3caa71c91b358e0aaf2acdf5c7adab38abb7a1166044404d3f",
    "e0142cf277454359273777395ad91b741d9fd4d4d805a883ce5fe7620aa33379",
  ],
  20: [
    "267803d667bffa32d0e7038e6ec1321c36690645650325596d1a2037b7661ee4",
    "f0a3fc6d61b508c4dc901d7be39710342fb03717acbcd407e4833b274d56426e",
  ],
  21: [
    "52c5e37f323b7ff951ba9546eda65b342a0e5d6cc8b3bfcfd94c6ad62bd87a1d",
    "0f0cb53be5846016431bbb9295846a1bfd327ffe6cee5f749ed73364f5f05f2e",
  ],
  22: [
    "e1f1c4d92a18a8423cbe9b07b8bc389e7d029949a750bc395cd5a157deda9dd1",
    "ebb1f90fb9e2b6b6799ec33624ee42f781e5ceca7ed8c3e01995f5ffe3824f40",
  ],
  23: [
    "725c1c98ac0b2ad93ecf9923e39a71ce06dec064abf6866eb5da3ca9351df407",
    "7f5d542d21942eda9da0cc70673e7f65067626921128c2bb0430c91209d2e641",
  ],
  // Captured from the live schema the moment before 1.25 opened above it: the
  // cron next-run line, with no bot-conversation request on a user row and no
  // conversation-message queue item.
  24: [
    "28a02553fd78cf36320da488600e68e592fc36a367ea69b316bda7ff7cc35b93",
    "b51fcced953e22883ded52ee896f72ab246923682ee7e2c9976f33ba245f5c3e",
  ],
  // Captured from the live schema the moment before 1.26 opened above it: the
  // bot-conversation line, with no task-checkin queue item.
  25: [
    "6cbd6fe26e74ca8e4d9e8767b0b921d0f5c123950ec96f6974134158ed659fde",
    "4aa1593b172b8680d6bc07eaa879959894875aafa63808e7cb78ad521fa3c441",
  ],
  // Captured from the live schema the moment before 1.27 opened above it: the
  // task-checkin line, with no task-overdue queue item.
  26: [
    "7948297517316b0e9ffa1a689e8f68e7de4a4836aa83fe405cb16edc51c25f2e",
    "3697b98492b0ed8dd20c71eb1d7e8bd682e6ef6dbad3fc6cdc52a6212f5d4ddc",
  ],
  // Captured from the live schema the moment before 1.28 opened above it: the
  // task-overdue line, with no `signInParked` on a queued prompt and operation
  // blocks and events limited to the four markdown artifact kinds. Main pinned
  // its own 1.27 with the page stamp this tree removed; the value here is the
  // one this tree pinned before main's 1.28 landed, and the merged tree's
  // frozen 1.27 reproduces it.
  27: [
    "6792dab575af3a22a380ce1d2c091bdf94efbdce4fdf9ce95e662b7deb6980a6",
    "42caa677f5d8c7edce3012a433b50ee151926d652d974b82bb107ebef3d3377f",
  ],
  // The sign-in park line (main's 1.28): a queued prompt may carry
  // `signInParked`; operation blocks and events keep the four markdown kinds.
  // Captured from the merged tree when the artifact lines re-minted above it.
  // With `signInParked` removed from the rendered schema, 1.28 reproduces
  // 1.27 above, and 1.29–1.31 reproduce the values this tree pinned for them
  // as 1.28–1.30, so the re-mint moved nothing else.
  28: [
    "9ae81ced85f6c37e1eed02cacc45a94ec01c2558df87958d721e81cd9569e3f7",
    "7f6a9d2a01d9903424dd888439047d84cda0965b9e2dbec1614354c65f4a7a03",
  ],
  // The delivery line (main's 1.29): a tool block may carry
  // `agentMessageDelivery`; operation blocks and events keep the four markdown
  // kinds, tool calls carry no `artifact` stamp. Captured from the merged tree
  // when the artifact lines re-minted above it. 1.29–1.32 re-minted when the
  // stamp gained `targetHostOffline` (traycer#2421): no stable release carries
  // 1.29 or above, and every line through 1.28 reproduces its value.
  29: [
    "748e5eb64ffaa11ab7b5bb90f75b5228edba772bcbffbf58cc8513e2a87f384b",
    "a0fa845aeca4a2390ea7033e8253c5a86b9c85d75a632468b945b72347e5f3ac",
  ],
  // The html/canvas/file artifact-kind line, with tool calls carrying no
  // `artifact` stamp. Re-minted above main's 1.29.
  30: [
    "f94dff7598365591d06b452f981f168ea59b6135da7512e45822f03d5c161828",
    "785c59f99c7432b48658215b9009b10faddaa7e0157e80201105a6b8097a9cb6",
  ],
  // The artifact-stamp line, with no canvas annotations. Re-minted above
  // main's 1.29.
  31: [
    "5f13ad506888fc0fcd3cd42504c3442dc2ad0aef77ffa5fa02c98d136725674e",
    "5ebdc4a673a74c35421862be1d21e91e99f3743d81e4be0a015ac2fa9db4ca5c",
  ],
  // The canvas-annotation line, before 1.33 widened checkpoint artifact tags.
  // Re-minted above main's 1.29.
  32: [
    "50156f6565e51692170a51c618cec3b509be61ac48a7d13411b84058eef715eb",
    "8cd92633dd7dbde5c03523ba51a24c3ff55defb1a3acbbbae791278381420234",
  ],
} as const;

// 1.23–1.32 carry `routing` on the chat record (`agent.configure@7.1`); every
// released line below 1.23 ships the record without it and is unchanged.
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
  chatSubscribeV122,
  chatSubscribeV123,
  chatSubscribeV124,
  chatSubscribeV125,
  chatSubscribeV126,
  chatSubscribeV127,
  chatSubscribeV128,
  chatSubscribeV129,
  chatSubscribeV130,
  chatSubscribeV131,
  chatSubscribeV132,
] as const;

describe("chat.subscribe placement freeze", () => {
  it("keeps every 1.0–1.32 server schema input/output surface byte-stable", () => {
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

  it("1.21 and 1.22 differ only in the heard-from harness leaves", () => {
    const agentSender = (harnessId: string) => ({
      type: "agent",
      harnessId,
      agentId: "a",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    });
    const userRow = (harnessId: string) => ({
      role: "user",
      messageId: "m-1",
      sender: agentSender(harnessId),
      message: {
        kind: "agent",
        content: { type: "doc", content: [] },
        fromAgentId: "a",
        senderTitle: null,
        senderHarnessId: harnessId,
        reply: { expectsReply: false },
      },
      timestamp: 1,
      sessionAnchor: null,
    });
    const rangeFrame = (harnessId: string) => ({
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "range-1",
        epoch: 0,
        fromOrdinal: 0,
        rowIds: ["m-1"],
        messages: [userRow(harnessId)],
        events: [],
        rowContext: {},
        reachedStart: true,
        reachedEnd: true,
      },
    });
    // Positive control: a roster id parses on both lines, so the frame itself
    // is well formed and the only thing the unknown id can be rejected for is
    // the harness leaf.
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(rangeFrame("claude"))
        .success,
    ).toBe(true);
    expect(
      chatSubscribeV122.serverFrameSchema.safeParse(rangeFrame("claude"))
        .success,
    ).toBe(true);
    expect(
      chatSubscribeV123.serverFrameSchema.safeParse(rangeFrame("claude"))
        .success,
    ).toBe(true);
    // The heard-from leaf: open on 1.22 and 1.23, still the closed enum on 1.21.
    expect(
      chatSubscribeV123.serverFrameSchema.safeParse(rangeFrame("zzz-future"))
        .success,
    ).toBe(true);
    expect(
      chatSubscribeV122.serverFrameSchema.safeParse(rangeFrame("zzz-future"))
        .success,
    ).toBe(true);
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(rangeFrame("zzz-future"))
        .success,
    ).toBe(false);
  });

  it("keeps the harness a client DRIVES closed on 1.22 and 1.23: the snapshot's chat settings and the active turn", () => {
    const settings = (harnessId: string) => ({
      harnessId,
      model: "model-1",
      permissionMode: "supervised",
      reasoningEffort: null,
      agentMode: "epic",
    });
    const snapshotFrame = (harnessId: string) => ({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: {
          parentId: null,
          id: "chat-1",
          userId: "user-1",
          hostId: "host-1",
          title: "Chat",
          createdAt: 1000,
          updatedAt: 1000,
          isTitleEditedByUser: false,
          settings: settings(harnessId),
        },
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: "idle",
        activeTurn: null,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChangeCount: 0,
        transcriptEpoch: 0,
        rowCount: 0,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [], events: [] },
        derived: {
          latestAssistantUsage: null,
          pinnedTodo: null,
          pinnedTaskTodoItems: [],
          latestForkableAssistantMessageId: null,
          restorableSetupInterruption: null,
          interviewAnswerability: [],
          latestAssistantAuthFailureTurnKey: null,
          setupCardWindows: [],
        },
      },
    });
    // Positive control on both lines: the fixture is a valid snapshot.
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(snapshotFrame("claude"))
        .success,
    ).toBe(true);
    expect(
      chatSubscribeV122.serverFrameSchema.safeParse(snapshotFrame("claude"))
        .success,
    ).toBe(true);
    expect(
      chatSubscribeV123.serverFrameSchema.safeParse(snapshotFrame("claude"))
        .success,
    ).toBe(true);
    // The drive carrier stays closed on BOTH lines.
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(snapshotFrame("zzz-future"))
        .success,
    ).toBe(false);
    expect(
      chatSubscribeV122.serverFrameSchema.safeParse(snapshotFrame("zzz-future"))
        .success,
    ).toBe(false);
    expect(
      chatSubscribeV123.serverFrameSchema.safeParse(snapshotFrame("zzz-future"))
        .success,
    ).toBe(false);

    // The same holds for the active turn on `turnStateChanged`.
    const turnFrame = (harnessId: string) => ({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: {
        turnId: "turn-1",
        userMessageId: "m-1",
        status: "running",
        harnessId,
        model: "model-1",
        startedAt: 1,
        updatedAt: 1,
      },
    });
    for (const contract of [
      chatSubscribeV121,
      chatSubscribeV122,
      chatSubscribeV123,
    ]) {
      expect(
        contract.serverFrameSchema.safeParse(turnFrame("claude")).success,
      ).toBe(true);
      expect(
        contract.serverFrameSchema.safeParse(turnFrame("zzz-future")).success,
      ).toBe(false);
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
        toCanonicalJsonSchema(autonomousResumeBlockSchemaV18, {
          io: "input",
        }),
      ),
    ).not.toContain("deliveryPlacement");
    expect(
      JSON.stringify(
        toCanonicalJsonSchema(autonomousResumeBlockSchemaV18, {
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
