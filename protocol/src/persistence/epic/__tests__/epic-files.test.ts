import {
  EPIC_FILES_MAP_NAME,
  EPIC_FILE_VERSIONS_CAP,
  epicFileEntrySchema,
  epicFileObjectSchema,
  formatEpicFileRef,
  isEpicFilePath,
  normalizeEpicFileStatus,
  parseEpicFileRef,
} from "@traycer/protocol/persistence/epic/files";
import { describe, expect, it } from "vitest";

const sha = "a".repeat(64);
const otherSha = "b".repeat(64);

const object = {
  sha256: sha,
  byteLength: 1024,
  mediaType: "video/mp4",
  createdAt: 1_700_000_000_000,
  createdBy: "user-1",
  producer: { type: "user" },
};

const entry = {
  v: 1,
  kind: "recording",
  current: object,
  versions: [],
  status: "available",
  recordingId: "rec-1",
  derivedFrom: [],
  deletedAt: null,
};

describe("isEpicFilePath", () => {
  it.each([
    "files/clip.mp4",
    "files/recordings/abc.events.json",
    `files/artifact-images/${sha}.png`,
  ])("accepts %s", (path) => {
    expect(isEpicFilePath(path)).toBe(true);
  });

  it.each([
    ["a relative escape", "../x"],
    ["an absolute path", "/abs"],
    ["a traversal segment", "files/../etc/passwd"],
    ["the staging sibling", ".file-staging/x.mp4"],
    ["a dot-prefixed segment", "files/.hidden"],
    ["the host index projection", "files/.index.md"],
    ["a backslash", "files\\win"],
    ["a NUL byte", "files/clip\0.mp4"],
    ["an empty segment", "files//clip.mp4"],
    ["a trailing slash", "files/recordings/"],
    ["the empty string", ""],
    ["an unaddressed prefix", "generated-images/x.png"],
    ["the artifact projection tree", `artifacts/artifact-1/images/${sha}.png`],
  ])("rejects %s", (_label, path) => {
    expect(isEpicFilePath(path)).toBe(false);
  });

  it("rejects a path longer than 1024 characters", () => {
    expect(isEpicFilePath(`files/${"a".repeat(1019)}`)).toBe(false);
    expect(isEpicFilePath(`files/${"a".repeat(1018)}`)).toBe(true);
  });
});

describe("epicFileEntrySchema", () => {
  it("parses a current entry", () => {
    const parsed = epicFileEntrySchema.safeParse(entry);
    expect(parsed.success).toBe(true);
  });

  it("names the sibling map, not an epic record field", () => {
    expect(EPIC_FILES_MAP_NAME).toBe("files");
  });

  it("parses a future-shaped entry into its known fields", () => {
    const parsed = epicFileEntrySchema.safeParse({
      ...entry,
      v: 2,
      kind: "walkthrough",
      status: "archived",
      unknownKey: { anything: true },
      current: { ...object, mediaType: "video/av1", unknownKey: 1 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.v).toBe(2);
    expect(parsed.data.kind).toBe("walkthrough");
    expect(parsed.data.current.mediaType).toBe("video/av1");
    expect(parsed.data.current.sha256).toBe(sha);
    expect(parsed.data).not.toHaveProperty("unknownKey");
    expect(parsed.data.current).not.toHaveProperty("unknownKey");
    expect(normalizeEpicFileStatus(parsed.data.status)).toBe("unknown");
  });

  it.each(["pending", "available", "failed", "local-only"])(
    "buckets the known status %s",
    (status) => {
      expect(normalizeEpicFileStatus(status)).toBe(status);
    },
  );

  it("defaults the fields a writer may omit", () => {
    const parsed = epicFileEntrySchema.safeParse({
      v: 1,
      kind: "file",
      current: object,
      status: "pending",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.versions).toEqual([]);
    expect(parsed.data.derivedFrom).toEqual([]);
    expect(parsed.data.recordingId).toBeNull();
    expect(parsed.data.deletedAt).toBeNull();
  });

  it("fails when current is missing", () => {
    const { current: _current, ...withoutCurrent } = entry;
    expect(epicFileEntrySchema.safeParse(withoutCurrent).success).toBe(false);
  });

  it.each([
    ["a malformed sha", { ...object, sha256: "A".repeat(64) }],
    ["a short sha", { ...object, sha256: "a".repeat(63) }],
    ["a negative byteLength", { ...object, byteLength: -1 }],
    ["a fractional byteLength", { ...object, byteLength: 1.5 }],
    [
      "an agent producer without a chatId",
      { ...object, producer: { type: "agent" } },
    ],
  ])("rejects an object with %s", (_label, current) => {
    expect(epicFileEntrySchema.safeParse({ ...entry, current }).success).toBe(
      false,
    );
  });

  it("accepts an unknown producer type as a generic producer", () => {
    // Per-ENTRY leniency, the same rule `kind`/`mediaType`/`status` follow: a
    // producer this build has no name for must not fail the whole entry, or a
    // newer host's file would vanish from the panel instead of rendering as a
    // generic row.
    const parsed = epicFileObjectSchema.safeParse({
      ...object,
      producer: { type: "system" },
    });
    expect(parsed.success && parsed.data.producer.type).toBe("system");
  });

  it("accepts an agent producer", () => {
    const parsed = epicFileObjectSchema.safeParse({
      ...object,
      producer: { type: "agent", chatId: "chat-1" },
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps versions up to the cap and trims the rest instead of failing", () => {
    const version = { ...object, sha256: otherSha };
    const atCap = epicFileEntrySchema.safeParse({
      ...entry,
      versions: Array.from({ length: EPIC_FILE_VERSIONS_CAP }, () => version),
    });
    expect(atCap.success && atCap.data.versions.length).toBe(
      EPIC_FILE_VERSIONS_CAP,
    );
    const overCap = epicFileEntrySchema.safeParse({
      ...entry,
      versions: Array.from(
        { length: EPIC_FILE_VERSIONS_CAP + 1 },
        () => version,
      ),
    });
    // A lenient reader must not lose `current` over a bookkeeping overflow.
    expect(overCap.success && overCap.data.versions.length).toBe(
      EPIC_FILE_VERSIONS_CAP,
    );
    expect(overCap.success && overCap.data.current.sha256).toBe(sha);
  });

  it("parses a tombstoned entry", () => {
    const parsed = epicFileEntrySchema.safeParse({
      ...entry,
      deletedAt: 1_700_000_001_000,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.deletedAt).toBe(1_700_000_001_000);
  });
});

describe("epic file refs", () => {
  it.each([
    "files/clip.mp4",
    "files/recordings/abc.events.json",
    "files/weird@name.png",
  ])("round-trips %s", (path) => {
    expect(parseEpicFileRef(formatEpicFileRef(path, sha))).toEqual({
      path,
      sha256: sha,
    });
  });

  it.each([
    ["no separator", "files/clip.mp4"],
    ["a non-hex sha", `files/clip.mp4@${"z".repeat(64)}`],
    ["a short sha", `files/clip.mp4@${"a".repeat(63)}`],
    ["an invalid path", `../clip.mp4@${sha}`],
    ["an empty path", `@${sha}`],
  ])("rejects %s", (_label, ref) => {
    expect(parseEpicFileRef(ref)).toBeNull();
  });
});
