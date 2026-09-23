/**
 * The container-agnostic half: a prefix array that is not the epic's, and the
 * `executable` bit. Everything the epic instance pins (defaults, leniency, the
 * versions cap, refs) is covered by `persistence/epic/__tests__/epic-files.test.ts`
 * through the epic re-exports, and is not repeated here.
 */
import { describe, expect, it } from "vitest";
import {
  filePlaneEntrySchema,
  filePlaneObjectSchema,
  formatFilePlaneRef,
  isFilePlanePath,
  parseFilePlaneRef,
} from "@traycer/protocol/persistence/file-plane/files";
import {
  EPIC_FILE_PATH_PREFIXES,
  epicFileEntrySchema,
  isEpicFilePath,
} from "@traycer/protocol/persistence/epic/files";

const sha = "a".repeat(64);
const IDENTITY_PREFIXES: readonly string[] = ["skills/"];

const object = {
  sha256: sha,
  byteLength: 1024,
  mediaType: "text/plain",
  createdAt: 1_700_000_000_000,
  createdBy: "user-1",
  producer: { type: "user" },
};

describe("isFilePlanePath with a container's own prefixes", () => {
  it.each([
    "skills/deploy/SKILL.md",
    "skills/deploy/scripts/run.sh",
    "skills/a/assets/logo.png",
  ])("accepts %s under skills/", (path) => {
    expect(isFilePlanePath(path, IDENTITY_PREFIXES)).toBe(true);
    // The same key is NOT an epic key: the prefix array is what decides.
    expect(isEpicFilePath(path)).toBe(false);
  });

  it.each([
    ["the epic prefix", "files/clip.mp4"],
    ["a top-level markdown file", "SOUL.md"],
    ["a memory file", "memories/MEMORY.md"],
    ["a native skill layout", ".claude/skills/deploy/SKILL.md"],
    ["a dot-prefixed segment", "skills/deploy/.env"],
    ["a traversal segment", "skills/../SOUL.md"],
    ["the empty string", ""],
  ])("rejects %s under skills/", (_label, path) => {
    expect(isFilePlanePath(path, IDENTITY_PREFIXES)).toBe(false);
  });

  it("accepts a key under any of several prefixes", () => {
    const prefixes: readonly string[] = ["skills/", "assets/"];
    expect(isFilePlanePath("assets/logo.png", prefixes)).toBe(true);
    expect(isFilePlanePath("skills/x/SKILL.md", prefixes)).toBe(true);
    expect(isFilePlanePath("memories/MEMORY.md", prefixes)).toBe(false);
  });

  it("is exactly the epic predicate under the epic prefixes", () => {
    for (const path of ["files/clip.mp4", "files/.index.md", "skills/x.sh"]) {
      expect(isFilePlanePath(path, EPIC_FILE_PATH_PREFIXES)).toBe(
        isEpicFilePath(path),
      );
    }
  });
});

describe("file plane refs under a container's own prefixes", () => {
  it("round-trips a skills/ ref and rejects it under the epic prefixes", () => {
    const ref = formatFilePlaneRef("skills/deploy/scripts/run.sh", sha);
    expect(parseFilePlaneRef(ref, IDENTITY_PREFIXES)).toEqual({
      path: "skills/deploy/scripts/run.sh",
      sha256: sha,
    });
    expect(parseFilePlaneRef(ref, EPIC_FILE_PATH_PREFIXES)).toBeNull();
  });
});

describe("the executable bit", () => {
  it("is optional on the object and absent when a writer omits it", () => {
    const parsed = filePlaneObjectSchema.safeParse(object);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.executable).toBeUndefined();
  });

  it("round-trips through the entry schema when set", () => {
    const parsed = filePlaneEntrySchema.safeParse({
      v: 1,
      kind: "file",
      current: { ...object, executable: true },
      status: "pending",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.current.executable).toBe(true);
  });

  it("rejects a non-boolean value rather than coercing it", () => {
    expect(
      filePlaneObjectSchema.safeParse({ ...object, executable: "yes" }).success,
    ).toBe(false);
  });

  it("is the same schema the epic instance re-exports", () => {
    expect(epicFileEntrySchema).toBe(filePlaneEntrySchema);
  });
});

describe("the agent producer's evolution discriminator", () => {
  it("round-trips when set and is absent when a writer omits it", () => {
    const evolution = filePlaneObjectSchema.safeParse({
      ...object,
      producer: { type: "agent", chatId: "chat-1", evolution: true },
    });
    expect(evolution.success).toBe(true);
    if (!evolution.success) {
      return;
    }
    expect(evolution.data.producer).toEqual({
      type: "agent",
      chatId: "chat-1",
      evolution: true,
    });
    const plain = filePlaneObjectSchema.safeParse({
      ...object,
      producer: { type: "agent", chatId: "chat-1" },
    });
    expect(plain.success).toBe(true);
    if (!plain.success) {
      return;
    }
    expect(plain.data.producer).toEqual({ type: "agent", chatId: "chat-1" });
  });

  it("is only ever true: a false value is refused rather than read as a kind", () => {
    expect(
      filePlaneObjectSchema.safeParse({
        ...object,
        producer: { type: "agent", chatId: "chat-1", evolution: false },
      }).success,
    ).toBe(false);
  });
});
