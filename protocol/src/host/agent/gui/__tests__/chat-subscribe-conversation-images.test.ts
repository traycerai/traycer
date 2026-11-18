import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toCanonicalJsonSchema } from "@traycer/protocol/framework/json-schema-fingerprint";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";

/**
 * A resume divider's `conversationMessage` carries the images the member
 * attached, added in place on the unreleased `chat.subscribe@1.44`. `1.43` is
 * the line just below it and the first to carry `conversationMessage` at all:
 * it binds a hand-frozen trigger whose message names no images, so a `1.43`
 * peer drops the key on decode and draws the divider it always did.
 *
 * The lines are read off the registry's negotiated contracts, and the message
 * rides a `range` row, which every windowed line decodes.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const IMAGES_MINOR = 44;
const FROZEN_MINOR = 43;

const FIRST_HASH = "a1".repeat(32);
const SECOND_HASH = "b2".repeat(32);

/** Two images that share a file name: the content address tells them apart. */
const IMAGES = [
  { attachmentHash: FIRST_HASH, mediaType: "image/png", fileName: "image.png" },
  {
    attachmentHash: SECOND_HASH,
    mediaType: "image/png",
    fileName: "image.png",
  },
];

const MESSAGE_FIELDS = {
  conversationId: "channel-1",
  messageId: "message-1",
  requestId: "request-1",
  senderUserId: "user-1",
  postedAt: 5,
};

const RESUME_FRAME = {
  kind: "range",
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  range: {
    requestId: "range-1",
    epoch: 0,
    fromOrdinal: 0,
    rowIds: ["assistant-1"],
    messages: [
      {
        role: "assistant",
        messageId: "assistant-1",
        sender: {
          type: "agent",
          harnessId: "claude",
          agentId: "agent-1",
          displayName: null,
          reply: { expectsReply: false },
          inReplyTo: null,
        },
        blocks: [
          {
            blockId: "resume-1",
            status: "completed",
            timestamp: 3,
            type: "autonomous_resume",
            deliveryPlacement: "turn_start",
            triggers: [
              {
                kind: "command",
                title: "Message from channel-1",
                status: "completed",
                summary: "A member wrote to the bot.",
                blockId: "",
                outputFile: null,
                mcp: null,
                live: false,
                managedCommand: null,
                conversationMessage: { ...MESSAGE_FIELDS, images: IMAGES },
              },
            ],
            wakeTriggers: [],
          },
        ],
        timestamp: 2,
        turnId: "turn-1",
        usage: null,
      },
    ],
    events: [],
    reachedStart: true,
    reachedEnd: true,
  },
};

const recordSchema = z.record(z.string(), z.unknown());
const arraySchema = z.array(z.unknown());

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`expected object for ${label}`);
  return parsed.data;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  const parsed = arraySchema.safeParse(value);
  if (!parsed.success) throw new Error(`expected array for ${label}`);
  return parsed.data;
}

/** The conversation message on the resume trigger a line decoded from the frame. */
function decodedConversationMessage(minor: number): Record<string, unknown> {
  const result =
    line.versions[minor].contract.serverFrameSchema.safeParse(RESUME_FRAME);
  if (!result.success) throw new Error(`1.${minor} refused the frame`);
  const range = asRecord(asRecord(result.data, "frame").range, "range");
  const row = asRecord(asArray(range.messages, "messages")[0], "row");
  const block = asRecord(asArray(row.blocks, "blocks")[0], "block");
  const trigger = asRecord(asArray(block.triggers, "triggers")[0], "trigger");
  return asRecord(trigger.conversationMessage, "conversationMessage");
}

describe("a resume divider's conversation message images", () => {
  it("keeps both images in order with their exact hashes on 1.44", () => {
    expect(decodedConversationMessage(IMAGES_MINOR)).toEqual({
      ...MESSAGE_FIELDS,
      images: IMAGES,
    });
  });

  it("drops the images and keeps the message on 1.43", () => {
    expect(decodedConversationMessage(FROZEN_MINOR)).toEqual(MESSAGE_FIELDS);
  });
});

/**
 * The same boundary read structurally, across every minor. A frame that happens
 * to parse proves one carrier; the JSON Schema of the whole server frame shows
 * every place a line binds a `conversationMessage`, and whether that object
 * names `images`. `1.43` carries the message on the same frames `1.44` does, so
 * the two counts are equal and only the key differs.
 */
type SchemaIo = "input" | "output";
const SCHEMA_IOS: readonly SchemaIo[] = ["input", "output"];

function recordOrNull(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function arrayOrNull(value: unknown): readonly unknown[] | null {
  const parsed = arraySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function resolveRef(ref: string, root: Record<string, unknown>): unknown {
  const prefix = "#/$defs/";
  const defs = recordOrNull(root.$defs);
  const name = ref.slice(prefix.length);
  if (ref === "#") return root;
  if (!ref.startsWith(prefix) || defs === null || !Object.hasOwn(defs, name)) {
    throw new Error(`unresolvable $ref ${ref}`);
  }
  return defs[name];
}

/**
 * Every schema node reached as the value of a property named
 * `conversationMessage`. A `$ref` is followed once per path, so a cycle ends
 * where it re-enters; `$defs` is reached only through a `$ref`.
 */
function conversationMessageNodes(
  value: unknown,
  root: Record<string, unknown>,
  onPath: Set<string>,
): unknown[] {
  const items = arrayOrNull(value);
  if (items !== null) {
    return items.flatMap((item) =>
      conversationMessageNodes(item, root, onPath),
    );
  }
  const node = recordOrNull(value);
  if (node === null) return [];
  const found: unknown[] = [];
  const ref = node.$ref;
  if (typeof ref === "string" && !onPath.has(ref)) {
    onPath.add(ref);
    found.push(
      ...conversationMessageNodes(resolveRef(ref, root), root, onPath),
    );
    onPath.delete(ref);
  }
  const properties = recordOrNull(node.properties);
  if (properties !== null && Object.hasOwn(properties, "conversationMessage")) {
    found.push(properties.conversationMessage);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "$ref" || key === "$defs") continue;
    found.push(...conversationMessageNodes(child, root, onPath));
  }
  return found;
}

/** The property maps of the object branches inside a (nullable) node. */
function objectBranchProperties(
  value: unknown,
  root: Record<string, unknown>,
  onPath: Set<string>,
): Record<string, unknown>[] {
  const node = recordOrNull(value);
  if (node === null) return [];
  const branches: Record<string, unknown>[] = [];
  const ref = node.$ref;
  if (typeof ref === "string" && !onPath.has(ref)) {
    onPath.add(ref);
    branches.push(
      ...objectBranchProperties(resolveRef(ref, root), root, onPath),
    );
    onPath.delete(ref);
  }
  const properties = recordOrNull(node.properties);
  if (properties !== null) branches.push(properties);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const arm of arrayOrNull(node[key]) ?? []) {
      branches.push(...objectBranchProperties(arm, root, onPath));
    }
  }
  return branches;
}

const surveys = new Map<string, readonly boolean[]>();

/** Whether each `conversationMessage` object on the line names `images`. */
function conversationMessageHasImages(
  minor: number,
  io: SchemaIo,
): readonly boolean[] {
  const key = `${minor}/${io}`;
  const cached = surveys.get(key);
  if (cached !== undefined) return cached;
  const root = recordOrNull(
    toCanonicalJsonSchema(line.versions[minor].contract.serverFrameSchema, {
      io,
      unrepresentable: "any",
    }),
  );
  if (root === null) throw new Error(`1.${minor} has no JSON Schema object`);
  const survey = conversationMessageNodes(root, root, new Set(["#"]))
    .flatMap((node) => objectBranchProperties(node, root, new Set(["#"])))
    .map((properties) => Object.hasOwn(properties, "images"));
  surveys.set(key, survey);
  return survey;
}

describe.each(SCHEMA_IOS)(
  "the conversationMessage objects in the %s JSON Schema of every minor",
  (io) => {
    it("are absent from every line below 1.43", () => {
      const carrying = Object.keys(line.versions)
        .map(Number)
        .filter(
          (minor) =>
            minor < FROZEN_MINOR &&
            conversationMessageHasImages(minor, io).length > 0,
        );
      expect(carrying).toEqual([]);
    });

    it("are present on 1.43 and none names images", () => {
      const frozen = conversationMessageHasImages(FROZEN_MINOR, io);
      expect(frozen.length).toBeGreaterThan(0);
      expect(frozen).not.toContain(true);
    });

    it("all name images on 1.44", () => {
      expect(conversationMessageHasImages(IMAGES_MINOR, io)).not.toContain(
        false,
      );
    });

    it("sit on as many carriers on 1.44 as on 1.43", () => {
      expect(conversationMessageHasImages(IMAGES_MINOR, io)).toHaveLength(
        conversationMessageHasImages(FROZEN_MINOR, io).length,
      );
    });
  },
);
