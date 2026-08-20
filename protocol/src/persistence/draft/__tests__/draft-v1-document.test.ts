import { describe, expect, it } from "vitest";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  canonicalJsonStringify,
  isJsonObject,
  readJsonProperty,
  type JsonObject,
  type JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  DRAFT_HEAD_PARTS_KEY,
  decodeDraftHeadDocument,
  encodeDraftHeadDocument,
  encodeDraftHead,
  listDraftHeadPartAddresses,
  serializeDraftHeadDocument,
  type DraftHeadRecord,
} from "@traycer/protocol/persistence/draft/index";
import {
  draftComposerPortableSchema,
  draftHeadSchema,
} from "@traycer/protocol/persistence/draft/schemas";
import {
  DRAFT_HEAD_DIALECT,
  DRAFT_HEAD_SCHEMA_VERSION,
} from "@traycer/protocol/persistence/draft/version";
import {
  draftHeadRecordV100,
  persistenceRecordRegistry,
  type DraftHead,
} from "@traycer/protocol/persistence/registry";

const EMPTY_DOC = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const RUN_SETTINGS = {
  harnessId: "claude" as const,
  model: "claude-sonnet-4",
  permissionMode: "supervised" as const,
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular" as const,
  profileId: null,
};

const HOST_LOCAL = {
  hostId: "host-1",
  workspace: {
    folders: ["/repo"],
    folderInfoByPath: {
      "/repo": {
        path: "/repo",
        name: "repo",
        repoIdentifier: { owner: "acme", repo: "widgets" },
        hostId: "host-1",
      },
    },
    primaryPath: "/repo",
  },
};

const COMPOSER_HEAD: DraftHeadRecord = {
  dialect: DRAFT_HEAD_DIALECT,
  schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
  kind: "draft",
  surfaceKind: "landing",
  lastTouchedAt: 1_753_000_000_000,
  target: { epicId: null, chatId: null, blockId: null },
  portable: {
    content: EMPTY_DOC,
    selection: { from: 1, to: 1 },
    runSettings: RUN_SETTINGS,
    composerMode: "chat",
    blobHashes: [],
  },
  hostLocal: HOST_LOCAL,
};

const INTERVIEW_HEAD: DraftHeadRecord = {
  dialect: DRAFT_HEAD_DIALECT,
  schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
  kind: "interview",
  lastTouchedAt: 1_753_000_000_000,
  target: { epicId: "epic-1", chatId: "chat-1", blockId: "block-1" },
  portable: {
    pageIndex: 0,
    answers: [
      { selected: ["a"], otherText: "", otherSelected: false },
    ],
  },
  hostLocal: { hostId: "host-1", workspace: null },
};

const STASH_HEAD: DraftHeadRecord = {
  dialect: DRAFT_HEAD_DIALECT,
  schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
  kind: "stash-entry",
  lastTouchedAt: 1_753_000_000_000,
  target: { epicId: null, chatId: null, blockId: null },
  portable: {
    content: EMPTY_DOC,
    blobHashes: ["ab".repeat(32)],
    createdAt: 1_753_000_000_000,
  },
  hostLocal: { hostId: "host-1", workspace: null },
};

function readEnvelope(documentBytes: string): JsonValue | undefined {
  const parsed: unknown = JSON.parse(documentBytes);
  if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
  return readJsonProperty(parsed, DRAFT_HEAD_PARTS_KEY);
}

function withEnvelope(record: DraftHeadRecord, envelope: JsonValue): string {
  const document = encodeDraftHeadDocument(record);
  const tampered: JsonObject = {
    ...document,
    [DRAFT_HEAD_PARTS_KEY]: envelope,
  };
  return canonicalJsonStringify(tampered);
}

type Assignable<From, To> = [From] extends [To] ? true : never;
const registeredFitsMirror: Assignable<DraftHead, DraftHeadRecord> = true;

describe("draft-head registry", () => {
  it("registers draft-head at 1.0 beside the chat-sync records", () => {
    expect(draftHeadRecordV100.name).toBe("draft-head");
    expect(draftHeadRecordV100.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(
      getRecordSchema(persistenceRecordRegistry, "draft-head", "latest"),
    ).toBe(draftHeadRecordV100.schema);
    expect(registeredFitsMirror).toBe(true);
  });
});

describe("draft/v1 document envelope", () => {
  it("carries a top-level parts array - the one tenant obligation", () => {
    expect(readEnvelope(serializeDraftHeadDocument(COMPOSER_HEAD))).toEqual([]);
    expect(listDraftHeadPartAddresses(COMPOSER_HEAD)).toEqual([]);
  });

  it("round-trips a landing draft, an interview, and a stash entry", () => {
    for (const head of [COMPOSER_HEAD, INTERVIEW_HEAD, STASH_HEAD]) {
      const decoded = decodeDraftHeadDocument(serializeDraftHeadDocument(head));
      expect(decoded.status).toBe("ok");
      if (decoded.status !== "ok") continue;
      expect(decoded.record.kind).toBe(head.kind);
      expect(decoded.record.dialect).toBe(DRAFT_HEAD_DIALECT);
      expect(decoded.record.lastTouchedAt).toBe(head.lastTouchedAt);
      expect(decoded.record.target).toEqual(head.target);
    }
  });

  it("preserves surfaceKind on a composer draft and omits it on the others", () => {
    const landing = decodeDraftHeadDocument(
      serializeDraftHeadDocument(COMPOSER_HEAD),
    );
    expect(landing.status).toBe("ok");
    if (landing.status === "ok" && landing.record.kind === "draft") {
      expect(landing.record.surfaceKind).toBe("landing");
    }

    const interview = decodeDraftHeadDocument(
      serializeDraftHeadDocument(INTERVIEW_HEAD),
    );
    expect(interview.status).toBe("ok");
    if (interview.status === "ok") {
      expect(interview.record.kind).toBe("interview");
      expect(Object.hasOwn(interview.record, "surfaceKind")).toBe(false);
    }
  });

  it("refuses a document with no parts envelope", () => {
    const payload = encodeDraftHeadDocument(COMPOSER_HEAD);
    const without: JsonObject = Object.create(null);
    for (const key of Object.getOwnPropertyNames(payload)) {
      if (key === DRAFT_HEAD_PARTS_KEY) continue;
      const descriptor = Object.getOwnPropertyDescriptor(payload, key);
      if (descriptor === undefined) continue;
      Object.defineProperty(without, key, descriptor);
    }
    const result = decodeDraftHeadDocument(canonicalJsonStringify(without));
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.reason).toBe("parts-envelope-missing");
    }
  });

  it("refuses a non-empty parts envelope - v1 names no shards", () => {
    const result = decodeDraftHeadDocument(
      withEnvelope(COMPOSER_HEAD, [
        { sha256: "ab".repeat(32), byteLength: 12 },
      ]),
    );
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.reason).toBe("parts-envelope-mismatch");
    }
  });

  it("strips a stale parts key from the payload so it cannot be re-emitted", () => {
    const decoded = decodeDraftHeadDocument(
      serializeDraftHeadDocument(COMPOSER_HEAD),
    );
    expect(decoded.status).toBe("ok");
    if (decoded.status !== "ok") return;
    expect(Object.hasOwn(decoded.record, DRAFT_HEAD_PARTS_KEY)).toBe(false);
  });

  it("refuses malformed JSON", () => {
    const result = decodeDraftHeadDocument("{");
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.reason).toBe("malformed-json");
    }
  });
});

describe("draft/v1 exact-minor reads", () => {
  it("refuses a 1.1 head so a futureField cannot strip on the claim path", () => {
    const payload = encodeDraftHead(COMPOSER_HEAD);
    payload.schemaVersion = { major: 1, minor: 1 };
    payload.futureField = "must-not-survive-a-1.0-decode";
    const document: JsonObject = {
      ...payload,
      [DRAFT_HEAD_PARTS_KEY]: [],
    };
    const result = decodeDraftHeadDocument(canonicalJsonStringify(document));
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.reason).toBe("schema-rejected");
    }
    expect(draftHeadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses a 1.0-shaped head that claims minor 1 even without extra keys", () => {
    const payload = encodeDraftHead(COMPOSER_HEAD);
    payload.schemaVersion = { major: 1, minor: 1 };
    const document: JsonObject = {
      ...payload,
      [DRAFT_HEAD_PARTS_KEY]: [],
    };
    const result = decodeDraftHeadDocument(canonicalJsonStringify(document));
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.reason).toBe("schema-rejected");
    }
  });
});

describe("draft/v1 strict run-settings", () => {
  it("treats omitted serviceTier or profileId as a parse error, not null", () => {
    const portable = {
      content: EMPTY_DOC,
      selection: null,
      composerMode: "chat" as const,
      blobHashes: [] as string[],
      runSettings: {
        harnessId: "claude" as const,
        model: "claude-sonnet-4",
        permissionMode: "supervised" as const,
        reasoningEffort: null,
        agentMode: "regular" as const,
      },
    };
    const omittedBoth = draftComposerPortableSchema.safeParse(portable);
    expect(omittedBoth.success).toBe(false);

    const omittedTier = draftComposerPortableSchema.safeParse({
      ...portable,
      runSettings: {
        ...portable.runSettings,
        profileId: null,
      },
    });
    expect(omittedTier.success).toBe(false);

    const omittedProfile = draftComposerPortableSchema.safeParse({
      ...portable,
      runSettings: {
        ...portable.runSettings,
        serviceTier: null,
      },
    });
    expect(omittedProfile.success).toBe(false);

    const explicitNulls = draftComposerPortableSchema.parse({
      ...portable,
      runSettings: {
        ...portable.runSettings,
        serviceTier: null,
        profileId: null,
      },
    });
    expect(explicitNulls.runSettings).toEqual({
      harnessId: "claude",
      model: "claude-sonnet-4",
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    });
  });
});
