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
 * - `1.10` is provider fallback, minted above it.
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
const LIVE_MINOR = 10;
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
  it("covers chat.subscribe@1.0 through @1.10 (a line added later cannot drop out)", () => {
    expect(MINORS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
      const carriesFallback = minor === LIVE_MINOR;
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
    });
  }
});
