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
 * - `1.12` is the `auto` permission mode, minted above THAT. It carries the
 *   whole fallback and shell-host surface too - what it holds back from `1.11`
 *   is the queue and approval-card shape, pinned in `chat-subscribe.test.ts`.
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
const FALLBACK_MINOR = 10;
const SHELL_HOST_MINOR = 11;
const LIVE_MINOR = 12;
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
  it("covers chat.subscribe@1.0 through @1.12 (a line added later cannot drop out)", () => {
    expect(MINORS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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
      const carriesAuto = minor === LIVE_MINOR;
      const carriesPlacement = minor >= 9;

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
    });
  }
});
