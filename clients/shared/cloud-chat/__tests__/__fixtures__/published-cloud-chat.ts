import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  chatHeadReaderSchema,
  serializeChatHeadDocument,
  type ChatHeadPart,
  type ChatHeadRecord,
} from "@traycer/protocol/persistence/chat-sync/head";
import {
  canonicalJsonStringify,
  type JsonObject,
  type JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import { serializeChatShard } from "@traycer/protocol/persistence/chat-sync/shard";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import type {
  CloudChatIdentity,
  CloudChatSummary,
  ReadCloudChatPartResponse,
  ResolveCloudChatHeadResponse,
} from "@traycer/protocol/host/epic/cloud-chat";
import {
  encodeBase64,
  utf8Bytes,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import type { CloudChatReadPort } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";

/**
 * A published chat as a CLIENT meets it: a head DOCUMENT (record plus the
 * server's `parts` envelope), the shard bytes it names, and a port that serves
 * them while counting every call.
 *
 * Two properties of this fixture are load-bearing for the suites that use it:
 *
 * 1. **Bytes are produced by the real encoders.** Shards go through
 *    `serializeChatShard` and the head through `encodeChatHead`, so a content
 *    address here is the same address a publisher would mint. A fixture that
 *    hand-rolled its JSON would let the reader's digest checks pass against
 *    bytes no publisher can produce.
 * 2. **Cohorts are addressed by content, so an append moves exactly one.**
 *    `publishCloudChat` takes the cohorts explicitly, which is what lets a test
 *    publish a chat, add one message to the tail cohort, and republish - and
 *    then assert that only the tail shard's digest changed.
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

export const TASK_ID = "task-1";
export const CHAT_ID = "chat-1";
export const OWNER_USER_ID = "u-1";

export const IDENTITY: CloudChatIdentity = {
  taskId: TASK_ID,
  chatId: CHAT_ID,
  ownerUserId: OWNER_USER_ID,
};

// ---- Leaves ------------------------------------------------------------- //

export function textBlock(id: string, text: string): JsonObject {
  return {
    blockId: id,
    status: "completed",
    timestamp: 10,
    type: "text",
    text,
    providerNotice: null,
    parentBlockId: null,
  };
}

/** Both diff sides live as blobs on the ORIGIN host - the payload-ref case. */
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

/**
 * A block type no shipped reader knows, carrying a nested subtree.
 *
 * The subtree is deliberately awkward - a mixed array with a null and a number -
 * because the passthrough's promise is that the WHOLE value survives, not that
 * its scalar leaves do.
 */
export const unknownBlock: JsonObject = {
  blockId: "b-future",
  status: "completed",
  timestamp: 13,
  type: "holodeck",
  program: { name: "cafe", characters: ["leah", null, 3] },
};

export function userMessage(id: string): JsonObject {
  return {
    role: "user",
    messageId: id,
    sender: { type: "user", userId: OWNER_USER_ID },
    message: { kind: "user", content: { type: "doc" } },
    timestamp: 1,
    sessionAnchor: null,
  };
}

export function assistantMessage(
  id: string,
  blocks: readonly JsonObject[],
): JsonObject {
  return {
    role: "assistant",
    messageId: id,
    sender: {
      type: "agent",
      harnessId: "starfleet-cli",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [...blocks],
    startedAt: null,
    timestamp: 2,
    turnId: null,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
  };
}

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

export const persistedHostPrivate: JsonObject = {
  revision: 3,
  data: {
    activeSessionChain: { harnessId: "starfleet-cli", sessionId: "s-1" },
  },
};

/** The cohorts a plain fixture chat publishes: two, so order can go wrong. */
export const FIRST_COHORT: readonly JsonObject[] = [
  userMessage("m-user"),
  assistantMessage("m-assistant", [
    textBlock("b-text", "here is the change"),
    fileChangeBlock,
    unknownBlock,
  ]),
];
export const SECOND_COHORT: readonly JsonObject[] = [
  userMessage("m-user-2"),
  assistantMessage("m-assistant-2", [textBlock("b-text-2", "and again")]),
];

// ---- Publishing --------------------------------------------------------- //

function messageShardWire(
  messages: readonly JsonObject[],
  minor: number,
): JsonObject {
  return {
    schemaVersion: { major: 1, minor },
    chatId: CHAT_ID,
    section: "messages",
    messages: [...messages],
    events: [],
    hostPrivate: null,
  };
}

export type PublishedPart = {
  readonly address: ChatHeadPart;
  readonly bytes: Uint8Array;
};

/**
 * Shard bytes and the address that names them.
 *
 * At this contract's own minor the wire object goes through the REGISTERED
 * writer schema first, so the fixture cannot mint bytes a real publisher could
 * not. A FUTURE minor cannot: the writer schema pins the version literal by
 * design, which is the anti-forgery property that makes `schemaVersion`
 * trustworthy. Those are canonicalized directly - the same bypass 02's own
 * suite uses to forge shapes a writer must not produce but a reader must still
 * refuse or tolerate correctly.
 */
function publishShard(wire: JsonObject, minor: number): Promise<PublishedPart> {
  const text =
    minor === CHAT_SYNC_SCHEMA_VERSION.minor
      ? serializeChatShard(chatShardSchema.parse(wire))
      : canonicalJsonStringify(wire);
  const bytes = utf8Bytes(text);
  return webCryptoSha256Hex(bytes).then((sha256) => ({
    address: { sha256, byteLength: bytes.byteLength },
    bytes,
  }));
}

export type PublishedCloudChat = {
  readonly head: ChatHeadRecord;
  /** The bytes stored on the row: the record PLUS the `parts` envelope. */
  readonly headDocument: string;
  readonly headSha256: string;
  readonly parts: readonly PublishedPart[];
  readonly bytesByDigest: ReadonlyMap<string, Uint8Array>;
  readonly summary: CloudChatSummary;
};

export type PublishOptions = {
  readonly cohorts: readonly (readonly JsonObject[])[];
  /**
   * The minor this publication claims, on the head AND on every shard.
   *
   * `CHAT_SYNC_SCHEMA_VERSION.minor` is this build's own contract. Anything
   * higher publishes as a FUTURE writer - which is the only way to reach the
   * passthrough end to end, and the only way to state a `minReaderVersion`
   * ahead of this contract.
   */
  readonly payloadMinor: number;
  /** The reader minimum the head states, or `null` for the ordinary case. */
  readonly minReaderVersion: {
    readonly major: number;
    readonly minor: number;
  } | null;
  readonly parentHeadSha256: string | null;
  /**
   * Adds an unmodeled key at EVERY captured residual level of the head.
   *
   * What a newer writer's extra FIELDS look like on the wire. Capture works at
   * this contract's own minor too - `withResidualCapture` sweeps unmodeled keys
   * regardless of the version claimed - so this is orthogonal to
   * `payloadMinor`, and keeping them separate is what lets a clone test assert
   * on residuals without also having to forge a version.
   */
  readonly withFutureFields: boolean;
  /** Lifecycle the source publishes with - a deleted source has no clone. */
  readonly lifecycleState: "active" | "archived" | "deleted";
};

/** The unmodeled key each captured level carries when `withFutureFields`. */
/**
 * Keyed by residual LEVEL, and typed as its own literal map rather than a
 * `Record<string, string>`: an index signature answers `string` for a level
 * that does not exist, so a mistyped level would mint the key `"undefined"` and
 * the head would still parse - leaving the passthrough tests below green over a
 * future field that was never planted where they think it was.
 */
export const FUTURE_FIELDS = {
  head: "futureHeadField",
  core: "futureCoreField",
  "core.lifecycle": "futureLifecycleField",
  "core.settings": "futureSettingsField",
  hostPrivate: "futureHostPrivateField",
} as const satisfies Readonly<Record<string, string>>;

export type FutureFieldLevel = keyof typeof FUTURE_FIELDS;

/** Settings that parse, so `core.settings` is non-null and can carry a bag. */
const RUN_SETTINGS: JsonObject = {
  harnessId: "starfleet-cli",
  model: "warp-9",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

export const DEFAULT_PUBLISH: PublishOptions = {
  cohorts: [FIRST_COHORT, SECOND_COHORT],
  payloadMinor: CHAT_SYNC_SCHEMA_VERSION.minor,
  // What a correct publisher stamps: the floor is reserved for a change an
  // older reader cannot safely INTERPRET, and the 1.1 reshape is additive and
  // read-safe. A non-null floor is the deliberate exception - the refusal case
  // below states one explicitly.
  minReaderVersion: null,
  parentHeadSha256: null,
  withFutureFields: false,
  lifecycleState: "active",
};

export async function publishCloudChat(
  options: PublishOptions,
): Promise<PublishedCloudChat> {
  const { payloadMinor } = options;
  const parts: PublishedPart[] = [];
  for (const cohort of options.cohorts) {
    parts.push(
      await publishShard(messageShardWire(cohort, payloadMinor), payloadMinor),
    );
  }

  const future = (level: FutureFieldLevel, value: JsonValue): JsonObject =>
    options.withFutureFields ? { [FUTURE_FIELDS[level]]: value } : {};

  const wireHead: JsonObject = {
    schemaVersion: { major: 1, minor: payloadMinor },
    parentHeadSha256: options.parentHeadSha256,
    throughRecordSeq: 42,
    capturedAt: 1_700_000_000_000,
    minReaderVersion: options.minReaderVersion,
    cdc: {
      algorithm: "fastcdc-gear-v1",
      mask: 65_535,
      target: 65_536,
      min: 16_384,
      max: 262_144,
    },
    ...future("head", "head-level"),
    core: {
      chatId: CHAT_ID,
      parentChatId: null,
      ownerUserId: OWNER_USER_ID,
      originHostId: "host-origin",
      title: "A published chat",
      isTitleEditedByUser: false,
      createdAt: 1,
      updatedAt: 5,
      lifecycle: {
        state: options.lifecycleState,
        archivedAt: options.lifecycleState === "archived" ? 6 : null,
        deletedAt: options.lifecycleState === "deleted" ? 7 : null,
        ...future("core.lifecycle", "lifecycle-level"),
      },
      settings: options.withFutureFields
        ? { ...RUN_SETTINGS, ...future("core.settings", "settings-level") }
        : null,
      ...future("core", "core-level"),
    },
    // Membership stamps derived from the ACTUAL cohorts: assembly now
    // cross-checks these claims against the parsed shard, so a fixture that
    // stamped placeholders would refuse its own publication.
    messageShards: parts.map((part, index) => {
      const cohort = options.cohorts[index] ?? [];
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
        ...part.address,
        firstSeq: index + 1,
        lastSeq: index + 1,
        recordCount: cohort.length,
        firstRecordId,
        lastRecordId,
      };
    }),
    events: [knownEvent],
    eventShards: [],
    hostPrivate: {
      ...persistedHostPrivate,
      ...future("hostPrivate", "host-private-level"),
    },
    hostPrivateShard: null,
  };

  // Same split as the shards: this build's own minor goes through the
  // registered writer schema, a future one through the reader schema, because
  // the writer's version literal is pinned on purpose.
  const head: ChatHeadRecord =
    payloadMinor === CHAT_SYNC_SCHEMA_VERSION.minor
      ? chatHeadSchema.parse(wireHead)
      : chatHeadReaderSchema.parse(wireHead);
  // The protocol's own document codec, always - including for a future-minor
  // publication. The document is the digest identity, and a fixture that
  // serialized it any other way would be testing the reader against bytes no
  // publisher produces.
  const headDocument = serializeChatHeadDocument(head);
  const headSha256 = await webCryptoSha256Hex(utf8Bytes(headDocument));

  return {
    head,
    headDocument,
    headSha256,
    parts,
    bytesByDigest: new Map(
      parts.map((part) => [part.address.sha256, part.bytes]),
    ),
    summary: summaryFor(headSha256),
  };
}

/**
 * A head document whose envelope disagrees with the shard lists it carries.
 *
 * Forged at the byte level on purpose: `encodeChatHeadDocument` DERIVES the
 * envelope from the record, so no encoder in this build can produce one - which
 * is exactly why the decoder's cross-check needs a test that bypasses it.
 */
export function withForgedPartsEnvelope(
  document: string,
  parts: readonly ChatHeadPart[],
): string {
  const parsed: JsonObject = JSON.parse(document);
  return canonicalJsonStringify({
    ...parsed,
    parts: parts.map((part) => ({
      sha256: part.sha256,
      byteLength: part.byteLength,
    })),
  });
}

function summaryFor(headSha256: string | null): CloudChatSummary {
  return {
    identity: IDENTITY,
    ownerHostId: "host-origin",
    createdAt: 1,
    visibility: "task",
    title: "A published chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 5,
    headSha256,
    publishedAt: headSha256 === null ? null : 1_700_000_000_000,
    throughRecordSeq: headSha256 === null ? null : 42,
    isOwnedByViewer: true,
  };
}

export const UNPUBLISHED_SUMMARY: CloudChatSummary = summaryFor(null);

// ---- The counting port -------------------------------------------------- //

export type RecordingPort = CloudChatReadPort & {
  /** Every `resolveHead` call, in order. */
  readonly resolveCalls: readonly CloudChatIdentity[];
  /** Every part digest asked for, in order. Duplicates are real duplicates. */
  readonly partCalls: readonly string[];
};

export type PortBehaviour = {
  readonly resolve: () => ResolveCloudChatHeadResponse;
  /**
   * May return a promise, so a test can make one part settle after another and
   * drive completion order apart from head order - the only way to witness that
   * assembly really is ordered by the head.
   */
  readonly part: (
    sha256: string,
  ) => ReadCloudChatPartResponse | Promise<ReadCloudChatPartResponse>;
};

/**
 * A port that records what it was asked for.
 *
 * The request COUNT is the observable these suites assert on - not what
 * rendered, and not whether a cache method was called. A cache that quietly
 * missed and refetched still renders the right transcript, so only the call log
 * can tell the incremental read from the whole one.
 */
export function recordingPort(behaviour: PortBehaviour): RecordingPort {
  const resolveCalls: CloudChatIdentity[] = [];
  const partCalls: string[] = [];

  return {
    resolveCalls,
    partCalls,
    resolveHead: (identity) => {
      resolveCalls.push(identity);
      return Promise.resolve(behaviour.resolve());
    },
    readPart: (request) => {
      partCalls.push(request.sha256);
      return Promise.resolve(behaviour.part(request.sha256));
    },
  };
}

/** The ordinary healthy behaviour: serve the published chat. */
export function servingBehaviour(published: PublishedCloudChat): PortBehaviour {
  return {
    resolve: () => ({
      chat: published.summary,
      outcome: {
        status: "ok",
        head: published.headDocument,
        headSha256: published.headSha256,
      },
    }),
    part: (sha256) => {
      const bytes = published.bytesByDigest.get(sha256);
      if (bytes === undefined) {
        return { outcome: { status: "not-found" } };
      }
      return {
        outcome: {
          status: "ok",
          bytesBase64: encodeBase64(bytes),
          byteLength: bytes.byteLength,
        },
      };
    },
  };
}
