import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runtimeEventSchema } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { CHAT_SUBSCRIBE_OPEN_HARNESS_MINOR } from "@traycer/protocol/host/agent/gui/chat-frame-compat";
import {
  openAgentSenderSchema,
  openContentBlockSchema,
  openRuntimeEventSchema,
} from "@traycer/protocol/host/agent/gui/open-harness-wire";
import {
  chatSubscribeV121,
  chatSubscribeV122,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { contentBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { agentSenderSchema } from "@traycer/protocol/persistence/epic/senders";

/**
 * `chat.subscribe@1.22` reopens the harness id on every leaf a client merely
 * HEARS a harness through and keeps it closed on every leaf a client DRIVES
 * through (`open-harness-wire.ts`). This file pins both halves: the two unions
 * the open copies re-list cannot drop a live member, and the sweep of the whole
 * `1.22` server-frame surface finds no closed harness-id leaf beyond the
 * acknowledged drive set.
 */

type JsonNode = Record<string, unknown>;

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("open-harness-wire: member sets", () => {
  // Same technique as `chat-sync-open-harness.test.ts`: read the `const` of the
  // discriminant off every member of the rendered union.
  function unionDiscriminants(schema: z.ZodType, key: string): string[] {
    const jsonSchema = z.parse(
      z.object({
        anyOf: z
          .array(
            z.object({
              properties: z.object({ [key]: z.object({ const: z.string() }) }),
            }),
          )
          .optional(),
        oneOf: z
          .array(
            z.object({
              properties: z.object({ [key]: z.object({ const: z.string() }) }),
            }),
          )
          .optional(),
      }),
      z.toJSONSchema(schema, { io: "input" }),
    );
    const options = jsonSchema.anyOf ?? jsonSchema.oneOf ?? [];
    return options.map((option) => option.properties[key].const).sort();
  }

  it("the open content-block union has every member of the live one", () => {
    const live = unionDiscriminants(contentBlockSchema, "type");
    expect(live.length).toBeGreaterThan(0);
    expect(unionDiscriminants(openContentBlockSchema, "type")).toEqual(live);
  });

  it("the open runtime-event union has every member of the live one", () => {
    const live = unionDiscriminants(runtimeEventSchema, "type");
    expect(live.length).toBeGreaterThan(0);
    expect(unionDiscriminants(openRuntimeEventSchema, "type")).toEqual(live);
  });
});

/**
 * Every property named `harnessId` in the rendered schema whose value is CLOSED
 * (an `enum`, or a `const` arm of a union), as a path of property names with
 * array items written `[]` and every `anyOf` / `oneOf` / `allOf` index dropped.
 * `$ref`s are followed (a reference already on the stack is not re-entered).
 */
function closedHarnessIdPaths(schema: z.ZodType): readonly string[] {
  const root = z.toJSONSchema(schema, { io: "output" });
  const defs = isNode(root.$defs) ? root.$defs : {};
  const found = new Set<string>();

  function resolve(node: unknown, stack: readonly string[]): JsonNode | null {
    if (!isNode(node)) return null;
    const ref = node.$ref;
    if (typeof ref !== "string") return node;
    const name = ref.replace("#/$defs/", "");
    if (stack.includes(name)) return null;
    const target = defs[name];
    return isNode(target) ? target : null;
  }

  function isClosed(node: unknown, stack: readonly string[]): boolean {
    const resolved = resolve(node, stack);
    if (resolved === null) return false;
    if (Array.isArray(resolved.enum) || "const" in resolved) return true;
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const arms = resolved[key];
      if (Array.isArray(arms) && arms.some((arm) => isClosed(arm, stack))) {
        return true;
      }
    }
    return false;
  }

  function walk(
    node: unknown,
    path: readonly string[],
    stack: readonly string[],
  ): void {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, path, stack);
      return;
    }
    if (!isNode(node)) return;
    const ref = node.$ref;
    if (typeof ref === "string") {
      const name = ref.replace("#/$defs/", "");
      if (stack.includes(name)) return;
      walk(defs[name], path, [...stack, name]);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs") continue;
      if (key === "properties" && isNode(value)) {
        for (const [name, child] of Object.entries(value)) {
          const childPath = [...path, name];
          if (name === "harnessId" && isClosed(child, stack)) {
            found.add(childPath.join("."));
          }
          walk(child, childPath, stack);
        }
        continue;
      }
      if (key === "items" || key === "prefixItems") {
        walk(value, [...path, "[]"], stack);
        continue;
      }
      if (key === "anyOf" || key === "oneOf" || key === "allOf") {
        walk(value, path, stack);
        continue;
      }
      if (key === "additionalProperties" || key === "not") {
        walk(value, path, stack);
      }
    }
  }

  walk(root, [], []);
  return [...found].sort();
}

// The DRIVE set, written out by hand as the acknowledgement - not derived from
// the sweep. A client acts on the run-settings and chain carriers (they seed the
// composer, the pickers and the send path), and a `sessionAnchor` is a
// discriminated union with a per-harness resume payload, so an unknown arm has
// no string to decode into. A leaf that joins this list is a decision, not a
// side effect of a rename. Paths are property names with array items as `[]`.
const CLOSED_DRIVE_LEAVES: readonly string[] = [
  // The chat's run settings, its session chain and the held wake chains.
  "snapshot.chat.settings.harnessId",
  "snapshot.chat.activeSessionChain.harnessId",
  "snapshot.chat.claudePendingWakes.[].heldChain.harnessId",
  // The active turn, on the snapshot and on `turnStateChanged`.
  "snapshot.activeTurn.harnessId",
  "activeTurn.harnessId",
  // A queued prompt's settings.
  "snapshot.queue.items.[].settings.harnessId",
  "queue.items.[].settings.harnessId",
  // The fallback tuples (run-settings tuples), snapshot and `turnStateChanged`.
  "snapshot.pendingFallback.failedTuple.harnessId",
  "snapshot.pendingFallback.targetTuple.harnessId",
  "snapshot.pendingFallback.impendingAction.target.harnessId",
  "snapshot.pendingReturn.preferredTuple.harnessId",
  "snapshot.pendingReturn.fallbackTuple.harnessId",
  "snapshot.lastFailedAttempt.failedTuple.harnessId",
  "pendingFallback.failedTuple.harnessId",
  "pendingFallback.targetTuple.harnessId",
  "pendingFallback.impendingAction.target.harnessId",
  "pendingReturn.preferredTuple.harnessId",
  "pendingReturn.fallbackTuple.harnessId",
  "lastFailedAttempt.failedTuple.harnessId",
  // Every `sessionAnchor` union: the snapshot's tail rows and row context, the
  // `range` response's rows and row context, and a `blockDelta` message.
  "snapshot.tail.messages.[].sessionAnchor.harnessId",
  "snapshot.tail.rowContext.sessionAnchor.harnessId",
  "range.messages.[].sessionAnchor.harnessId",
  "range.rowContext.sessionAnchor.harnessId",
  "message.sessionAnchor.harnessId",
  // The `user_message.anchor_resolved` runtime event's `anchor` union.
  "event.anchor.harnessId",
  // `user_message.anchor_tail_updated.harnessId` is `z.literal("claude")`, not
  // an enum a new harness extends, on an event the schema documents as
  // host-internal ("never reaches the wire"). It rides the same union only
  // because the runtime-event union lists it.
  "event.harnessId",
];

describe("open-harness-wire: the 1.22 server-frame sweep", () => {
  it("finds a closed harness-id leaf only on the acknowledged drive set", () => {
    expect(closedHarnessIdPaths(chatSubscribeV122.serverFrameSchema)).toEqual(
      [...CLOSED_DRIVE_LEAVES].sort(),
    );
  });

  it("1.21 closes a strict superset: every heard-from leaf is an enum there", () => {
    const v122 = new Set(
      closedHarnessIdPaths(chatSubscribeV122.serverFrameSchema),
    );
    const v121 = new Set(
      closedHarnessIdPaths(chatSubscribeV121.serverFrameSchema),
    );
    for (const path of v122) expect(v121.has(path)).toBe(true);
    expect(v121.size).toBeGreaterThan(v122.size);
    // The difference is exactly the heard-from set, restated by hand: agent
    // senders (rows, queued prompts, steer blocks and `steer.submitted`), event
    // actors, provider notices, plan blocks and their sources, and the
    // `session.*` / `plan.*` runtime events.
    expect([...v121].filter((path) => !v122.has(path)).sort()).toEqual(
      [
        "event.actor.harnessId",
        "event.sender.harnessId",
        "event.session.harnessId",
        "event.source.harnessId",
        "message.sender.harnessId",
        "queue.items.[].sender.harnessId",
        "range.events.[].actor.harnessId",
        "range.messages.[].blocks.[].harnessId",
        "range.messages.[].blocks.[].providerNotice.harnessId",
        "range.messages.[].blocks.[].sender.harnessId",
        "range.messages.[].blocks.[].source.harnessId",
        "range.messages.[].sender.harnessId",
        "snapshot.queue.items.[].sender.harnessId",
        "snapshot.tail.events.[].actor.harnessId",
        "snapshot.tail.messages.[].blocks.[].harnessId",
        "snapshot.tail.messages.[].blocks.[].providerNotice.harnessId",
        "snapshot.tail.messages.[].blocks.[].sender.harnessId",
        "snapshot.tail.messages.[].blocks.[].source.harnessId",
        "snapshot.tail.messages.[].sender.harnessId",
      ].sort(),
    );
  });
});

describe("CHAT_SUBSCRIBE_OPEN_HARNESS_MINOR", () => {
  it("is the literal 22, the minor the open leaves arrived on", () => {
    expect(CHAT_SUBSCRIBE_OPEN_HARNESS_MINOR).toBe(22);
  });
});

describe("openAgentSenderSchema", () => {
  const sender = (harnessId: string) => ({
    type: "agent",
    harnessId,
    agentId: "a",
    displayName: null,
    reply: { expectsReply: false },
    inReplyTo: null,
  });

  it("parses an unknown harness id where the live agent sender rejects it", () => {
    expect(openAgentSenderSchema.safeParse(sender("zzz-future")).success).toBe(
      true,
    );
    expect(agentSenderSchema.safeParse(sender("zzz-future")).success).toBe(
      false,
    );
  });

  it("agrees with the live sender on a roster id, and still rejects an empty id", () => {
    expect(openAgentSenderSchema.safeParse(sender("claude")).success).toBe(
      true,
    );
    expect(agentSenderSchema.safeParse(sender("claude")).success).toBe(true);
    expect(openAgentSenderSchema.safeParse(sender("")).success).toBe(false);
  });
});
