import { createHash } from "node:crypto";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import type {
  ChatPartFetcher,
  StagedChatPart,
} from "@traycer/protocol/persistence/chat-sync/assembly";
import {
  serializeChatHeadDocument,
  type ChatHeadPart,
  type ChatHeadRecord,
} from "@traycer/protocol/persistence/chat-sync/head";
import {
  canonicalJsonStringify,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import { serializeChatShard } from "@traycer/protocol/persistence/chat-sync/shard";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import {
  persistenceRecordRegistry,
  type ChatHead,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";

/**
 * A published chat as a reader actually meets it: a head, the shard bytes it
 * names, and a fetch port that serves them.
 *
 * Shared by the assembly and presentation suites because they test two halves
 * of one journey, and a fixture that drifted between them would let each half
 * pass against a chat the other could not produce.
 *
 * The content is chosen for what it exercises rather than for realism: one
 * known message with a known block, a block carrying payload refs the reader
 * cannot resolve, a block type from the future, a message role from the future,
 * and an event type from the future - all split across two cohorts so the
 * assembly order actually has something to get wrong.
 */

const chatHeadSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-head",
  "latest",
);

const chatShardSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-shard",
  "latest",
);

export const CHAT_ID = "chat-1";

/** Valid 1.1 CDC params for fixtures; sizes are host choices, not protocol defaults. */
export const FIXTURE_CDC = {
  algorithm: "fastcdc-gear-v1",
  mask: 65_535,
  target: 65_536,
  min: 16_384,
  max: 262_144,
} as const;

export const textBlock: JsonObject = {
  blockId: "b-text",
  status: "completed",
  timestamp: 10,
  type: "text",
  text: "here is the change",
  providerNotice: null,
  parentBlockId: null,
};

/**
 * The payload-ref case: both diff sides live as content-addressed blobs in the
 * ORIGIN host's SnapshotStore, so a cloud reader has the block but not its
 * contents.
 */
export const fileChangeBlock: JsonObject = {
  blockId: "b-file",
  status: "completed",
  timestamp: 11,
  type: "file_change",
  filePath: "src/app.ts",
  operation: "edit",
  diffSource: "snapshot",
  beforeHash: "aaa111",
  afterHash: "bbb222",
  additions: 3,
  deletions: 1,
  reason: "snapshot",
  parentBlockId: null,
};

/** The other payload-ref case: a plan whose full text is behind a content ref. */
export const planBlock: JsonObject = {
  blockId: "b-plan",
  status: "completed",
  timestamp: 12,
  type: "plan",
  planStatus: "ready",
  planId: "plan-1",
  harnessId: "starfleet-cli",
  source: {
    harnessId: "starfleet-cli",
    sessionId: null,
    turnId: null,
    kind: "harness",
  },
  title: "Refactor the store",
  summary: null,
  markdownPreview: "## Step one",
  fullContentRef: { kind: "plan_content", hash: "ccc333" },
  steps: [],
  actions: [],
  approvalId: null,
  supersededByPlanId: null,
  metadata: null,
  parentBlockId: null,
};

/** A block type no shipped reader knows, carrying a nested subtree. */
export const unknownBlock: JsonObject = {
  blockId: "b-future",
  status: "completed",
  timestamp: 13,
  type: "holodeck",
  program: { name: "cafe", characters: ["leah", null, 3] },
};

export const userMessage: JsonObject = {
  role: "user",
  messageId: "m-user",
  sender: { type: "user", userId: "u-1" },
  message: { kind: "user", content: { type: "doc" } },
  timestamp: 1,
  sessionAnchor: null,
};

export const assistantMessage: JsonObject = {
  role: "assistant",
  messageId: "m-assistant",
  sender: {
    type: "agent",
    // An open harness id: this build has never heard of it, and the shard must
    // still parse (see `open-harness.ts`).
    harnessId: "starfleet-cli",
    agentId: "agent-1",
    displayName: null,
    reply: { expectsReply: false },
    inReplyTo: null,
  },
  blocks: [textBlock, fileChangeBlock, planBlock, unknownBlock],
  startedAt: null,
  timestamp: 2,
  turnId: null,
  usage: null,
  reasoningEffort: null,
  serviceTier: null,
};

/** A message role no shipped reader knows. */
export const unknownMessage: JsonObject = {
  role: "telemetry",
  messageId: "m-future",
  timestamp: 3,
  payload: { samples: [1, 2, 3] },
};

export const knownEvent: JsonObject = {
  eventId: "e-1",
  type: "turn.started",
  timestamp: 4,
  clientActionId: null,
  actor: null,
  message: null,
  turnId: null,
  messageId: null,
  queueItemId: null,
  approvalId: null,
  blockId: null,
  severity: "info",
  metadata: null,
};

/** An event type no shipped reader knows. */
export const unknownEvent: JsonObject = {
  eventId: "e-2",
  type: "warp.engaged",
  timestamp: 5,
  factor: 9.975,
};

export const persistedHostPrivate: JsonObject = {
  revision: 3,
  data: {
    activeSessionChain: { harnessId: "starfleet-cli", sessionId: "s-1" },
  },
};

/** A wire shard carrying only what its `section` allows. */
export function persistedShard(fields: {
  readonly section: "messages" | "events" | "host-private";
  readonly messages: readonly JsonObject[];
  readonly events: readonly JsonObject[];
  readonly hostPrivate: JsonObject | null;
}): JsonObject {
  return {
    schemaVersion: {
      major: CHAT_SYNC_SCHEMA_VERSION.major,
      minor: CHAT_SYNC_SCHEMA_VERSION.minor,
    },
    chatId: CHAT_ID,
    section: fields.section,
    messages: [...fields.messages],
    events: [...fields.events],
    hostPrivate: fields.hostPrivate,
  };
}

export function messageShard(messages: readonly JsonObject[]): JsonObject {
  return persistedShard({
    section: "messages",
    messages,
    events: [],
    hostPrivate: null,
  });
}

export function eventShard(events: readonly JsonObject[]): JsonObject {
  return persistedShard({
    section: "events",
    messages: [],
    events,
    hostPrivate: null,
  });
}

export function hostPrivateShard(hostPrivate: JsonObject): JsonObject {
  return persistedShard({
    section: "host-private",
    messages: [],
    events: [],
    hostPrivate,
  });
}

/** The two message cohorts every fixture publishes, in transcript order. */
export const FIRST_COHORT: readonly JsonObject[] = [
  userMessage,
  assistantMessage,
];
export const SECOND_COHORT: readonly JsonObject[] = [unknownMessage];

export function parseHead(value: JsonObject): ChatHead {
  return chatHeadSchema.parse(value);
}

export function parseShard(value: JsonObject): ChatShard {
  return chatShardSchema.parse(value);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** In-memory staging: what a reader that buffers instead of spooling produces. */
export function stageFromText(text: string): StagedChatPart {
  return {
    byteLength: Buffer.byteLength(text, "utf8"),
    sha256: sha256Hex(text),
    readText: () => Promise.resolve(text),
  };
}

/** Serializes a wire shard and returns the part address that names it. */
export function publishShard(wire: JsonObject): {
  readonly bytes: string;
  readonly part: ChatHeadPart;
} {
  return addressBytes(serializeChatShard(parseShard(wire)));
}

/**
 * Canonical bytes for a wire shard WITHOUT parsing it first.
 *
 * For the shapes a writer must not produce: a shard the registered schema
 * rejects cannot be built through `publishShard`, but a hostile or buggy writer
 * can still upload its bytes under a correct content address. That is the case
 * the reader has to refuse on its own, so a test needs a way to forge one.
 */
export function publishRawShard(wire: JsonObject): {
  readonly bytes: string;
  readonly part: ChatHeadPart;
} {
  return addressBytes(canonicalJsonStringify(wire));
}

function addressBytes(bytes: string): {
  readonly bytes: string;
  readonly part: ChatHeadPart;
} {
  return {
    bytes,
    part: {
      sha256: sha256Hex(bytes),
      byteLength: Buffer.byteLength(bytes, "utf8"),
    },
  };
}

export type PublishedChat = {
  readonly head: ChatHeadRecord;
  /**
   * The bytes a publisher actually stores: the head DOCUMENT, envelope and all.
   * Never the payload - see `headSha256`.
   */
  readonly documentBytes: string;
  /**
   * The head's identity: sha256 of `documentBytes`.
   *
   * This is the CAS witness, the digest the chat row holds, and the value the
   * NEXT head carries as its `parentHeadSha256` - one value for all three. A
   * fixture that exposed the payload digest here would teach every consumer to
   * chain on bytes nobody stores, so the next sync would fail to find the
   * ancestor it named and report a fork that never happened. This fixture did
   * exactly that once; hence the emphasis.
   */
  readonly headSha256: string;
  /** Every part's bytes, keyed by the address the head names it with. */
  readonly bytesByPart: ReadonlyMap<string, string>;
  /** Serves `bytesByPart`; `delays` lets a test reorder completion. */
  readonly fetch: ChatPartFetcher;
};

/**
 * Publishes the fixture chat.
 *
 * `graduate` decides which head sections have outgrown the head and moved to
 * parts of their own - the two layouts a reader must handle identically.
 * `parentHeadSha256` seeds the lineage chain.
 */
export function publishChat(options: {
  readonly graduate: {
    readonly events: boolean;
    readonly hostPrivate: boolean;
  };
  readonly parentHeadSha256: string | null;
}): PublishedChat {
  const bytesByPart = new Map<string, string>();

  const messageShards = [FIRST_COHORT, SECOND_COHORT].map((cohort, index) => {
    const published = publishShard(messageShard(cohort));
    bytesByPart.set(published.part.sha256, published.bytes);
    const firstSeq = index === 0 ? 1 : 3;
    const lastSeq = index === 0 ? 2 : 3;
    const first = cohort[0];
    const last = cohort[cohort.length - 1];
    const firstRecordId =
      first !== undefined && typeof first.messageId === "string"
        ? first.messageId
        : `m-first-${index}`;
    const lastRecordId =
      last !== undefined && typeof last.messageId === "string"
        ? last.messageId
        : `m-last-${index}`;
    return {
      ...published.part,
      firstSeq,
      lastSeq,
      recordCount: cohort.length,
      firstRecordId,
      lastRecordId,
    };
  });

  const eventShards: ChatHeadPart[] = [];
  if (options.graduate.events) {
    for (const [index, cohort] of [[knownEvent], [unknownEvent]].entries()) {
      const published = publishShard(eventShard(cohort));
      bytesByPart.set(published.part.sha256, published.bytes);
      const eventId =
        cohort[0] !== undefined && typeof cohort[0].eventId === "string"
          ? cohort[0].eventId
          : `e-${index}`;
      eventShards.push({
        ...published.part,
        firstSeq: 4 + index,
        lastSeq: 4 + index,
        recordCount: cohort.length,
        firstRecordId: eventId,
        lastRecordId: eventId,
      });
    }
  }

  let graduatedHostPrivate: ChatHeadPart | null = null;
  if (options.graduate.hostPrivate) {
    const published = publishShard(hostPrivateShard(persistedHostPrivate));
    bytesByPart.set(published.part.sha256, published.bytes);
    graduatedHostPrivate = published.part;
  }

  const wireHead: JsonObject = {
    schemaVersion: {
      major: CHAT_SYNC_SCHEMA_VERSION.major,
      minor: CHAT_SYNC_SCHEMA_VERSION.minor,
    },
    parentHeadSha256: options.parentHeadSha256,
    throughRecordSeq: 42,
    capturedAt: 1_700_000_000_000,
    // What a correct 1.1 publisher stamps. The floor is for a change an older
    // reader cannot safely INTERPRET, and the 1.1 cut plan is not one: a 1.0
    // reader takes the part entries as addresses and re-derives its own cut.
    minReaderVersion: null,
    cdc: { ...FIXTURE_CDC },
    core: {
      chatId: CHAT_ID,
      parentChatId: null,
      ownerUserId: "u-1",
      originHostId: "host-origin",
      title: "A published chat",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 5,
      lifecycle: { state: "active", archivedAt: null, deletedAt: null },
      settings: null,
    },
    messageShards: messageShards.map((part) => ({ ...part })),
    events: options.graduate.events ? null : [knownEvent, unknownEvent],
    eventShards: eventShards.map((part) => ({ ...part })),
    hostPrivate: options.graduate.hostPrivate ? null : persistedHostPrivate,
    hostPrivateShard:
      graduatedHostPrivate === null ? null : { ...graduatedHostPrivate },
  };

  const head = parseHead(wireHead);
  // The DOCUMENT, not the payload: these are the bytes a publisher stores and
  // the digest everything downstream chains on.
  const documentBytes = serializeChatHeadDocument(head);

  return {
    head,
    documentBytes,
    headSha256: sha256Hex(documentBytes),
    bytesByPart,
    fetch: (request) => {
      const bytes = bytesByPart.get(request.part.sha256);
      if (bytes === undefined) {
        return Promise.reject(
          new Error(`No such part: ${request.part.sha256}`),
        );
      }
      return Promise.resolve(stageFromText(bytes));
    },
  };
}
