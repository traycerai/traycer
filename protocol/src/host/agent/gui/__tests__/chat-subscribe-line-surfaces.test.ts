/**
 * Which `chat.subscribe` minor carries which surface, read off the JSON Schema
 * of the contracts the registry actually negotiates.
 *
 * A stream peer negotiates the highest shared minor and there is no downgrade
 * bridge, so the version IS the behaviour: a surface that leaks one minor down
 * reaches every peer of that minor, and a surface missing from the line that
 * owns it reaches nobody. Two boundaries are pinned here:
 *
 * - `1.9` is mainline's windowed line as the `v1.3.x` staging builds shipped
 *   it (delivery placement, Antigravity anchors), frozen;
 * - `1.10` is provider fallback, minted above it, frozen as the staging
 *   builds shipped it;
 * - `1.11` is the shell host on a resume trigger and on the queued
 *   managed-command item, minted above that;
 * - `1.13` is the `auto` permission mode, minted above THAT. It carries the
 *   whole fallback and shell-host surface too - what it holds back from `1.11`
 *   is the queue and approval-card shape, pinned in `chat-subscribe.test.ts`;
 * - `1.14` is the port-forward surface, minted above `1.13`: the agent's
 *   forwards on the snapshot, the `portForwardsChanged` frame, and the queue
 *   item that reports one going `interrupted`;
 * - `1.15` is the message-delivery surface, minted above `1.14`: the one
 *   `messageDeliveryRestored` client acknowledgement and the
 *   `messageDeliveryChanged` push. Its own shape/freeze coverage lives in
 *   `chat-subscribe-message-delivery-v115.test.ts`; it is listed here only so
 *   the line-count and ceiling assertions below stay truthful;
 * - `1.16` is the approval-tier surface, minted above `1.15`: the optional
 *   `tier` on the approval card's judge reason. It is tolerance, not
 *   projection (written at every minor, dropped by an older decoder), so no
 *   needle can pin a boundary for it; its shape coverage lives in
 *   `chat-subscribe-approval-tier-v116.test.ts` and it is listed here for the
 *   same line-count and ceiling reason as `1.15`;
 * - `1.17` is the sender-host surface, minted above `1.16`, and tolerance for
 *   the same reason `1.16` is; listed for the same line-count and ceiling
 *   reason;
 * - `1.18` is the model-routing surface, minted above `1.17`: the settled
 *   notice's `receipt` and the queue's `pausedReason`, which the older lines
 *   bind frozen schemas without, so needles pin the boundary;
 * - `1.19` is skeleton resume, minted above `1.18`: a claim on the open request
 *   and `retainedRows` on a resumed stream's first chunk. No projected key, so
 *   it is listed for the same line-count and ceiling reason as `1.15`;
 * - `1.20` is the Claude-parity surface, minted above `1.19`: the suggested
 *   prompt, the thinking-tokens estimate and frame, the cron background item
 *   kind, and the approval card's display facts / cautious / rule-forced
 *   keys. Unlike `1.16` these are PROJECTED for an older peer, and the older
 *   lines bind frozen schemas without them, so needles do pin the boundary;
 * - `1.31` is the tool-call `artifact` stamp, minted above `1.30`: the
 *   manifest an inline `traycer_render_inline` artifact showed. PROJECTED,
 *   like `1.23`'s MCP App stamp, so a needle pins the boundary.
 *
 * The needles are searched in the whole stringified schema, both `io`
 * directions, so a leak through ANY binding shows up - a snapshot key, a
 * notice kind reached through a transcript tail or a `range` response, a live
 * `blockDelta` upsert, an `actionAck` vocabulary. A parse-based pin sees only
 * the one frame it builds.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  backgroundItemKindSchema,
  chatActionSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { providerNoticeKindSchema } from "@traycer/protocol/persistence/epic/content-blocks";

const chatSubscribeLine = hostStreamRpcRegistry["chat.subscribe"][1];
// The minor each surface was minted on. A line carries a surface from its own
// minor UPWARD - `1.13` is not "not the shell-host line", it is a later one
// that inherits it - so these are thresholds, not equalities. Written as `===`
// they assert that the newest line has LOST the surface below it.
const FALLBACK_MINOR = 10;
const SHELL_HOST_MINOR = 11;
const DRAFT_IMAGE_CAUSE_MINOR = 12;
const AUTO_MINOR = 13;
const PORT_FORWARD_MINOR = 14;
// `1.15` (message delivery), `1.16` (approval tier) and `1.17` (sender host)
// mint no boundary a needle below can pin, so only the ceiling names them.
const APPROVAL_TIER_MINOR = 16;
const SENT_FROM_HOST_MINOR = 17;
// `1.18` (model routing) is the boundary for the receipt / pausedReason needles;
// `1.19` adds only the open-request resume claim and first-chunk retainedRows.
const MODEL_ROUTING_MINOR = 18;
const MODEL_ROUTING_NEEDLES = ['"receipt":', '"pausedReason":'];
// The Claude-parity surfaces: suggested prompt, thinking tokens, cron items,
// approval display facts / cautious / rule-forced.
const CLAUDE_PARITY_MINOR = 20;
// `1.21` is the Command Code line: it adds no key, only which harnesses the
// shapes may name. `1.22` is the open-harness-id line: it adds no key either,
// only reopens the heard-from harness leaves to a string. `1.23` adds the
// tool-call `mcpApp` stamp (pinned below). `1.24` adds the cron
// next-run time, whose `scheduledFor` key already exists on other item kinds;
// `chat-subscribe-cron-next-run-v124.test.ts` pins that arm directly. `1.25`
// adds the bot-conversation request on a user row and the
// `conversation-message` queue item (pinned below). `1.26` adds the
// `task-checkin` queue item (pinned below). `1.27` adds the `task-overdue`
// queue item (pinned below). `1.28` adds `signInParked` on a queued prompt
// (pinned below). `1.29` adds the tool-call `agentMessageDelivery` stamp
// (pinned below). `1.30` lets an `artifact_operation` block and event name
// the html, canvas and file artifact kinds (pinned below). `1.31` adds the
// tool-call `artifact` stamp (pinned below). `1.32` grows the browser
// annotation record with the canvas arm (pinned by
// `chat-subscribe-canvas-annotations-v132.test.ts`). `1.33` widens the
// accumulated-change `artifact` tag to all seven artifact kinds (pinned by
// `checkpoint-artifact-kinds.test.ts`). `1.34` adds the optional `sendWouldQueue`
// bit (pinned by `chat-subscribe-send-would-queue-v134.test.ts`). `1.35` has
// `1.34`'s frames and marks a client that shows both Managed OpenCode rows.
// Every threshold above still reads `>=` against the live line.
const LIVE_MINOR = 35;
// `1.28`: the host's sign-in park mark on a queued prompt, server frames only
// (the host sets it; a client never sends a queue item).
const SIGN_IN_PARK_MINOR = 28;
const SIGN_IN_PARK_NEEDLES = ['"signInParked":'];
// `1.31`: the tool-call `artifact` stamp - the manifest an inline
// `traycer_render_inline` artifact showed. Found structurally
// (`toolCallArtifactStampPresent`, defined below), not by a substring
// needle: `'"artifact":'` already appears on every line via the unrelated
// `checkpointArtifactTagSchema` field.
const ARTIFACT_STAMP_MINOR = 31;
// `1.30`: the html-artifacts surface - the artifact kinds an `artifact_operation`
// block and event may name. Found structurally (`artifactOperationKinds`,
// defined below), not by a `'"canvas"'` needle: from `1.32` a browser
// annotation's `source` is the literal `"canvas"` too, which is a different
// fact (where an annotation was captured, not which artifact kind an
// operation touched) and must not read as the kind enum having grown.
const HTML_ARTIFACTS_MINOR = 30;
const HTML_ARTIFACT_KINDS = ["html", "canvas", "file"];
// `1.27`: the task-overdue surface - the queue item's discriminant, its one
// needle for the same reason as the check-in's.
const TASK_OVERDUE_MINOR = 27;
const TASK_OVERDUE_NEEDLES = ['"task-overdue"'];
// `1.26`: the task check-in surface - the queue item's discriminant. The item
// is content-free (it carries no key of its own beside the shared queue-item
// fields), so the discriminant is its one needle.
const TASK_CHECKIN_MINOR = 26;
const TASK_CHECKIN_NEEDLES = ['"task-checkin"'];
// `1.25`: the conversation surface - the user row's request key and the key
// only that request carries, the queue item's discriminant and the key only
// that item carries. (`requestId` is not a needle: a `range` response has
// carried one since `1.8`.) All or none - a line that carried the queue item
// without the row key would show a chip for a request it cannot name.
const CONVERSATION_MINOR = 25;
// `1.29`: the cross-host send state on a tool call, server frames only (the
// host stamps it; a client never sends a body).
const DELIVERY_MINOR = 29;
const DELIVERY_NEEDLES = ['"agentMessageDelivery":'];
const CONVERSATION_NEEDLES = [
  '"conversationRequest":',
  '"resolvedByMessageId":',
  '"conversation-message"',
  '"conversationId":',
];
// Object keys carry their colon so a needle cannot hit an enum value or a
// description that merely mentions the name; the two literals (`thinkingTokens`
// frame kind, `cron` background kind) are matched with both quotes, which
// `"thinkingTokensEstimate":` and `"cron..."` cannot satisfy by prefix.
// `1.23`: the tool-call `mcpApp` stamp, server frames only (a client never
// sends a body).
const MCP_APP_STAMP_MINOR = 23;
const MCP_APP_STAMP_NEEDLES = ['"mcpApp":'];
const CLAUDE_PARITY_NEEDLES = [
  '"suggestedPrompt":',
  '"thinkingTokensEstimate":',
  '"thinkingTokens"',
  '"displayFacts":',
  '"cautious":',
  '"ruleForced":',
  '"cron"',
];
const MINORS = Object.keys(chatSubscribeLine.versions)
  .map(Number)
  .sort((a, b) => a - b);

function schemaText(schema: z.ZodType): string {
  return (["input", "output"] as const)
    .map((io) =>
      JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: "any" })),
    )
    .join("\n");
}

// Enum members are derived from the live enums by the rule that names them,
// so a member added later is checked on every line without editing this file;
// the counts below are the tripwire that says the rule still matches.
const fallbackNoticeKinds = providerNoticeKindSchema.options.filter((kind) =>
  kind.startsWith("fallback_"),
);
const fallbackActions = chatActionSchema.options.filter((action) =>
  action.startsWith("fallback."),
);
const fallbackBackgroundKinds = backgroundItemKindSchema.options.filter(
  (kind) => kind.startsWith("fallback-"),
);

// Object keys are matched with their colon, so a needle cannot hit an enum
// value or a description that merely mentions the name.
const FALLBACK_SERVER_NEEDLES = [
  '"pendingFallback":',
  '"pendingReturn":',
  '"lastFailedAttempt":',
  '"lastFallbackOutcome":',
  '"failure":',
  ...[
    ...fallbackNoticeKinds,
    ...fallbackActions,
    ...fallbackBackgroundKinds,
  ].map((member) => JSON.stringify(member)),
];
const FALLBACK_CLIENT_NEEDLES = fallbackActions.map((action) =>
  JSON.stringify(action),
);
const PLACEMENT_NEEDLE = '"deliveryPlacement":';
// The approval card's transient judge stage. `reason` would be the other half,
// but that key name is shared with unrelated frames; `reviewing` is unique to
// the card, and the two are added and frozen together.
const AUTO_APPROVAL_NEEDLE = '"reviewing":';

// The port-forward surface: the snapshot key, the frame kind, the queue item's
// discriminant and the key only that item carries. All four or none - a line
// that carried the queue item without the frame would show a wake chip for a
// forward it has no row for.
const PORT_FORWARD_NEEDLES = [
  '"portForwards":',
  '"portForwardsChanged"',
  '"port-forward"',
  '"forwardId":',
];

// The two shapes the shell host rides, found structurally rather than by a
// `"hostId":` needle - the chat record's own `hostId` is on every line. A
// resume trigger's `managedCommand` is the object carrying `commandId` and
// `monitoring` with no `description` (the tool-call identity has one); the
// queued managed-command item is the object carrying `queueItemId` beside
// `commandId`.
function shellShapes(schema: z.ZodType): {
  shapes: number;
  withHost: number;
} {
  const tally = { shapes: 0, withHost: 0 };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties !== null && typeof properties === "object") {
      const keys = new Set(Object.keys(properties));
      const isTriggerShell =
        keys.has("commandId") &&
        keys.has("monitoring") &&
        !keys.has("description");
      const isQueuedShell = keys.has("queueItemId") && keys.has("commandId");
      if (isTriggerShell || isQueuedShell) {
        tally.shapes += 1;
        if (keys.has("hostId")) tally.withHost += 1;
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  for (const io of ["input", "output"] as const) {
    visit(z.toJSONSchema(schema, { io, unrepresentable: "any" }));
  }
  return tally;
}

// Whether any `tool_call` or `tool_call.completed` object node carries its
// OWN `artifact` key, found structurally rather than by a `'"artifact":'`
// needle - that substring already appears on every line via the unrelated,
// much older `artifact: checkpointArtifactTagSchema` field (`subscribe.ts`,
// `subscribe-windowed.ts`), so a plain needle cannot pin this boundary.
function toolCallArtifactStampPresent(schema: z.ZodType): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties !== null && typeof properties === "object") {
      const propertyKeys = properties as Record<string, unknown>;
      const typeConst = literalSchema.safeParse(propertyKeys.type).data?.const;
      if (
        (typeConst === "tool_call" || typeConst === "tool_call.completed") &&
        Object.hasOwn(propertyKeys, "artifact")
      ) {
        found = true;
        return;
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  for (const io of ["input", "output"] as const) {
    visit(z.toJSONSchema(schema, { io, unrepresentable: "any" }));
    if (found) return true;
  }
  return found;
}

function collectStrings(node: unknown, into: Set<string>): void {
  if (typeof node === "string") {
    into.add(node);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, into);
    return;
  }
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.enum)) collectStrings(record.enum, into);
  if (typeof record.const === "string") into.add(record.const);
  for (const [key, value] of Object.entries(record)) {
    if (key !== "enum" && key !== "const") collectStrings(value, into);
  }
}

// Every kind an `artifact_operation` block or event can name, read off the
// `kind` property of the shapes whose `type` is that literal. Nothing else on
// a frame, a browser annotation's `source` included, is looked at.
function artifactOperationKinds(schema: z.ZodType): string[] {
  const kinds = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties !== null && typeof properties === "object") {
      const propertyKeys = properties as Record<string, unknown>;
      const typeConst = literalSchema.safeParse(propertyKeys.type).data?.const;
      if (typeConst === "artifact_operation") {
        collectStrings(propertyKeys.kind, kinds);
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  for (const io of ["input", "output"] as const) {
    visit(z.toJSONSchema(schema, { io, unrepresentable: "any" }));
  }
  return [...kinds];
}

const unionArmsSchema = z.object({
  oneOf: z
    .array(z.object({ properties: z.record(z.string(), z.unknown()) }))
    .optional(),
  anyOf: z
    .array(z.object({ properties: z.record(z.string(), z.unknown()) }))
    .optional(),
});
const literalSchema = z.object({ const: z.string() });

function actionAckPropertyNames(serverFrameSchema: z.ZodType): string[] {
  const json = unionArmsSchema.parse(
    z.toJSONSchema(serverFrameSchema, {
      io: "output",
      unrepresentable: "any",
    }),
  );
  const arms = json.oneOf ?? json.anyOf ?? [];
  const [ack, ...extra] = arms.filter(
    (arm) =>
      literalSchema.safeParse(arm.properties.kind).data?.const === "actionAck",
  );
  expect(extra).toEqual([]);
  if (ack === undefined) throw new Error("no actionAck arm");
  return Object.keys(ack.properties);
}

describe("chat.subscribe line surfaces", () => {
  it("covers chat.subscribe@1.0 through @1.35 (a line added later cannot drop out)", () => {
    // RESTATED on purpose: this is the change-detector for the line SET, so a
    // derived list would assert the registry against itself. When a new minor
    // lands, extending this by hand is the acknowledgement.
    expect(MINORS).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
    ]);
    expect(chatSubscribeLine.latestMinor).toBe(LIVE_MINOR);
  });

  it("derives the fallback vocabulary it searches for (5 notice kinds, 2 actions, 1 background kind)", () => {
    expect(fallbackNoticeKinds).toHaveLength(5);
    expect(fallbackActions).toEqual([
      "fallback.holdForChoice",
      "fallback.releaseChoice",
    ]);
    expect(fallbackBackgroundKinds).toEqual(["fallback-wait"]);
  });

  for (const minor of MINORS) {
    describe(`chat.subscribe@1.${minor}`, () => {
      const { contract } = chatSubscribeLine.versions[minor];
      const carriesFallback = minor >= FALLBACK_MINOR;
      const carriesShellHost = minor >= SHELL_HOST_MINOR;
      const carriesAuto = minor >= AUTO_MINOR;
      const carriesPortForwards = minor >= PORT_FORWARD_MINOR;
      const carriesModelRouting = minor >= MODEL_ROUTING_MINOR;
      const carriesPlacement = minor >= 9;
      const carriesRefusalCause = minor >= DRAFT_IMAGE_CAUSE_MINOR;
      const carriesClaudeParity = minor >= CLAUDE_PARITY_MINOR;
      const carriesMcpAppStamp = minor >= MCP_APP_STAMP_MINOR;
      const carriesConversation = minor >= CONVERSATION_MINOR;
      const carriesSignInPark = minor >= SIGN_IN_PARK_MINOR;
      const carriesDelivery = minor >= DELIVERY_MINOR;

      it(`server frames ${carriesDelivery ? "carry" : "hold back"} the cross-host send delivery state`, () => {
        const text = schemaText(contract.serverFrameSchema);
        expect(
          DELIVERY_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual(carriesDelivery ? DELIVERY_NEEDLES : []);
      });

      it("client frames hold back the delivery state on every line", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          DELIVERY_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      it(`server frames ${carriesSignInPark ? "carry" : "hold back"} the sign-in park mark`, () => {
        const text = schemaText(contract.serverFrameSchema);
        expect(
          SIGN_IN_PARK_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual(carriesSignInPark ? SIGN_IN_PARK_NEEDLES : []);
      });

      it("client frames hold back the sign-in park mark on every line", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          SIGN_IN_PARK_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      it(`server frames ${carriesConversation ? "carry" : "hold back"} the bot-conversation surface`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = CONVERSATION_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesConversation ? CONVERSATION_NEEDLES : []);
      });

      it("client frames hold back the bot-conversation surface on every line", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          CONVERSATION_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      const carriesArtifactStamp = minor >= ARTIFACT_STAMP_MINOR;

      it(`server frames ${carriesArtifactStamp ? "carry" : "hold back"} the tool-call artifact stamp`, () => {
        expect(toolCallArtifactStampPresent(contract.serverFrameSchema)).toBe(
          carriesArtifactStamp,
        );
      });

      it("client frames hold back the artifact stamp on every line", () => {
        expect(toolCallArtifactStampPresent(contract.clientFrameSchema)).toBe(
          false,
        );
      });

      const carriesHtmlArtifacts = minor >= HTML_ARTIFACTS_MINOR;

      it(`server frames ${carriesHtmlArtifacts ? "carry" : "hold back"} the html, canvas and file artifact kinds`, () => {
        const kinds = artifactOperationKinds(contract.serverFrameSchema);
        const found = HTML_ARTIFACT_KINDS.filter((kind) =>
          kinds.includes(kind),
        );
        expect(found).toEqual(carriesHtmlArtifacts ? HTML_ARTIFACT_KINDS : []);
      });

      it("client frames hold back the html, canvas and file artifact kinds on every line", () => {
        const kinds = artifactOperationKinds(contract.clientFrameSchema);
        expect(
          HTML_ARTIFACT_KINDS.filter((kind) => kinds.includes(kind)),
        ).toEqual([]);
      });

      const carriesTaskOverdue = minor >= TASK_OVERDUE_MINOR;

      it(`server frames ${carriesTaskOverdue ? "carry" : "hold back"} the task-overdue queue item`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = TASK_OVERDUE_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesTaskOverdue ? TASK_OVERDUE_NEEDLES : []);
      });

      it("client frames hold back the task-overdue queue item on every line", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          TASK_OVERDUE_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      const carriesTaskCheckin = minor >= TASK_CHECKIN_MINOR;

      it(`server frames ${carriesTaskCheckin ? "carry" : "hold back"} the task-checkin queue item`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = TASK_CHECKIN_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesTaskCheckin ? TASK_CHECKIN_NEEDLES : []);
      });

      it("client frames hold back the task-checkin queue item on every line", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          TASK_CHECKIN_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      it(`server frames ${carriesClaudeParity ? "carry" : "hold back"} every Claude-parity surface`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = CLAUDE_PARITY_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesClaudeParity ? CLAUDE_PARITY_NEEDLES : []);
      });

      it(`server frames ${carriesMcpAppStamp ? "carry" : "hold back"} the tool-call MCP App stamp`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = MCP_APP_STAMP_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesMcpAppStamp ? MCP_APP_STAMP_NEEDLES : []);
      });

      it("client frames hold back the MCP App stamp on every line", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          MCP_APP_STAMP_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      it("client frames hold back the Claude-parity surface on every line (host-authored)", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          CLAUDE_PARITY_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      it(`server frames ${carriesFallback ? "carry" : "hold back"} every provider-fallback surface`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = FALLBACK_SERVER_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesFallback ? FALLBACK_SERVER_NEEDLES : []);
      });

      it(`client frames ${carriesFallback ? "accept" : "reject"} the fallback grace-menu actions`, () => {
        const text = schemaText(contract.clientFrameSchema);
        const found = FALLBACK_CLIENT_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesFallback ? FALLBACK_CLIENT_NEEDLES : []);
      });

      it(`server frames ${carriesPlacement ? "carry" : "hold back"} autonomous-resume delivery placement`, () => {
        expect(
          schemaText(contract.serverFrameSchema).includes(PLACEMENT_NEEDLE),
        ).toBe(carriesPlacement);
      });

      it(`actionAck ${carriesFallback ? "carries" : "has no"} the grace-hold lease token`, () => {
        expect(
          actionAckPropertyNames(contract.serverFrameSchema).includes("token"),
        ).toBe(carriesFallback);
      });

      it(`actionAck ${carriesRefusalCause ? "carries" : "has no"} the draft-image refusal cause`, () => {
        expect(
          actionAckPropertyNames(contract.serverFrameSchema).includes("cause"),
        ).toBe(carriesRefusalCause);
      });

      it(`server frames ${carriesShellHost ? "carry" : "hold back"} the shell host on every shell shape`, () => {
        const { shapes, withHost } = shellShapes(contract.serverFrameSchema);
        // Every line reaches a resume trigger through its chat tree, so the
        // walk must find something - a zero here means the finder is wrong,
        // not that the line is clean.
        expect(shapes).toBeGreaterThan(0);
        expect(withHost).toBe(carriesShellHost ? shapes : 0);
      });

      it(`server frames ${carriesAuto ? "carry" : "hold back"} the approval card's judge stage`, () => {
        expect(
          schemaText(contract.serverFrameSchema).includes(AUTO_APPROVAL_NEEDLE),
        ).toBe(carriesAuto);
      });

      it(`server frames ${carriesPortForwards ? "carry" : "hold back"} every port-forward surface`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = PORT_FORWARD_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesPortForwards ? PORT_FORWARD_NEEDLES : []);
      });

      it(`server frames ${carriesModelRouting ? "carry" : "hold back"} the receipt and pausedReason keys`, () => {
        const text = schemaText(contract.serverFrameSchema);
        const found = MODEL_ROUTING_NEEDLES.filter((needle) =>
          text.includes(needle),
        );
        expect(found).toEqual(carriesModelRouting ? MODEL_ROUTING_NEEDLES : []);
      });

      it("client frames carry neither the receipt nor the pausedReason key on any line", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          MODEL_ROUTING_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });

      it("client frames hold back the port-forward surface on every line (a forward is stopped over portForward.stop)", () => {
        const text = schemaText(contract.clientFrameSchema);
        expect(
          PORT_FORWARD_NEEDLES.filter((needle) => text.includes(needle)),
        ).toEqual([]);
      });
    });
  }
});
