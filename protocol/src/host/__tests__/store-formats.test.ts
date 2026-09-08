import { describe, expect, it } from "vitest";
import {
  HOST_OLDER_THAN_DATA_FATAL_CODE,
  NO_CHAT_STORE,
  SOURCE_TREE_HOST_VERSION,
  decideStoreFormatFloor,
  isReleasedHostVersion,
  resolveHostStoreFormats,
  storeFloorApplicability,
  storeFloorClearedByFormats,
  storeFormatsFromReleasedTable,
  type HostStoreFormatsKnowledge,
} from "../store-formats";

describe("storeFormatsFromReleasedTable", () => {
  it.each([
    ["1.1.10", 0],
    ["1.2.0-rc.1", 7],
    ["1.2.0-rc.2", 8],
    ["1.2.0-rc.3", 8],
    ["1.2.0", 8],
    ["1.3.0-rc.1", 9],
    ["1.3.0-rc.2", 9],
    ["1.3.0-rc.3", 9],
    ["1.3.0-rc.4", 9],
  ])("maps %s to chatDb %s", (version, chatDb) => {
    expect(storeFormatsFromReleasedTable(version)).toEqual({
      kind: "known",
      formats: { chatDb },
    });
  });

  it.each(["1.3.0", "1.4.0"])(
    "does not guess a format above the table ceiling for %s",
    (version) => {
      expect(storeFormatsFromReleasedTable(version)).toEqual({
        kind: "unknown",
        reason: "above-table-ceiling",
      });
    },
  );

  it.each([
    ["a local-file install stamp", "local-abc"],
    ["a desktop build stamp", "production.1757000000000.abc1234"],
    ["the source-tree sentinel", SOURCE_TREE_HOST_VERSION],
  ])("does not vouch for %s", (_label, version) => {
    expect(storeFormatsFromReleasedTable(version)).toEqual({
      kind: "unknown",
      reason: "not-a-released-version",
    });
    expect(isReleasedHostVersion(version)).toBe(false);
  });

  it("treats a tagged release as on the ladder", () => {
    expect(isReleasedHostVersion("1.3.0-rc.4")).toBe(true);
    expect(isReleasedHostVersion("0.0.1")).toBe(true);
  });

  it("keeps the exact rc.1/rc.2 boundary", () => {
    expect(storeFormatsFromReleasedTable("1.2.0-rc.1")).toEqual({
      kind: "known",
      formats: { chatDb: 7 },
    });
    expect(storeFormatsFromReleasedTable("1.2.0-rc.2")).toEqual({
      kind: "known",
      formats: { chatDb: 8 },
    });
  });
});

describe("resolveHostStoreFormats", () => {
  it("prefers a published format over the fixed table", () => {
    expect(resolveHostStoreFormats("1.2.0", { chatDb: 42 })).toEqual({
      kind: "known",
      formats: { chatDb: 42 },
    });
  });

  it("falls back to the table for a null published format", () => {
    expect(resolveHostStoreFormats("1.2.0", null)).toEqual({
      kind: "known",
      formats: { chatDb: 8 },
    });
  });
});

describe("store floor format helpers", () => {
  const declared = { chatDb: 9 };
  const buildStamp = "production.1757000000000.abc1234";

  it.each([
    ["downgrade", "1.1.0", "1.2.0", null, { applies: true }],
    [
      "upgrade",
      "1.3.0-rc.1",
      "1.2.0",
      null,
      { applies: false, reason: "target-not-older" },
    ],
    [
      "same version",
      "1.2.0",
      "1.2.0",
      null,
      { applies: false, reason: "target-not-older" },
    ],
    ["no installed version", "1.2.0", null, null, { applies: true }],
    [
      "released target over a local install",
      "1.2.0",
      "local-x",
      null,
      { applies: true },
    ],
    [
      "released target over a build stamp",
      "1.2.0",
      buildStamp,
      null,
      { applies: true },
    ],
    [
      "undeclared build stamp over a release",
      buildStamp,
      "1.3.0-rc.4",
      null,
      { applies: false, reason: "target-off-ladder" },
    ],
    [
      "undeclared build stamp over another",
      buildStamp,
      "production.1756000000000.def5678",
      null,
      { applies: false, reason: "target-off-ladder" },
    ],
    [
      "undeclared build stamp onto an empty machine",
      buildStamp,
      null,
      null,
      { applies: false, reason: "target-off-ladder" },
    ],
    [
      "undeclared source-tree build over a release",
      SOURCE_TREE_HOST_VERSION,
      "1.3.0-rc.4",
      null,
      { applies: false, reason: "target-off-ladder" },
    ],
    [
      "declared build stamp over a release",
      buildStamp,
      "1.3.0-rc.4",
      declared,
      { applies: true },
    ],
    [
      "declared build stamp over another",
      buildStamp,
      "production.1756000000000.def5678",
      declared,
      { applies: true },
    ],
    [
      "declared build stamp onto an empty machine",
      buildStamp,
      null,
      declared,
      { applies: true },
    ],
  ])("applicability: %s", (_label, target, installed, formats, expected) => {
    expect(storeFloorApplicability(target, installed, formats)).toEqual(
      expected,
    );
  });

  const clearanceCases: ReadonlyArray<
    [string, HostStoreFormatsKnowledge, HostStoreFormatsKnowledge, boolean]
  > = [
    [
      "known target at least as new",
      { kind: "known", formats: { chatDb: 9 } },
      { kind: "known", formats: { chatDb: 8 } },
      true,
    ],
    [
      "known target below installed",
      { kind: "known", formats: { chatDb: 7 } },
      { kind: "known", formats: { chatDb: 8 } },
      false,
    ],
    [
      "unknown target",
      { kind: "unknown", reason: "above-table-ceiling" },
      { kind: "known", formats: { chatDb: 8 } },
      false,
    ],
    [
      "unknown installed",
      { kind: "known", formats: { chatDb: 9 } },
      { kind: "unknown", reason: "not-a-released-version" },
      false,
    ],
  ];

  it.each(clearanceCases)(
    "format clearance: %s",
    (_label, target, installed, expected) => {
      expect(storeFloorClearedByFormats(target, installed)).toBe(expected);
    },
  );
});

describe("decideStoreFormatFloor", () => {
  const failure = { epicId: "epic-failed", reason: "read failed" };
  const readingAbove = { epicId: "epic-new", schemaVersion: 9 };

  it("returns target-format-unknown and carries survey failures", () => {
    expect(
      decideStoreFormatFloor(
        { kind: "unknown", reason: "above-table-ceiling" },
        { readings: [], failures: [failure] },
      ),
    ).toEqual({
      kind: "indeterminate",
      reason: "target-format-unknown",
      failures: [failure],
    });
  });

  it("blocks on readings above target, even when failures are present", () => {
    expect(
      decideStoreFormatFloor(
        { kind: "known", formats: { chatDb: 8 } },
        { readings: [readingAbove], failures: [failure] },
      ),
    ).toEqual({
      kind: "blocked",
      targetChatDb: 8,
      epics: [readingAbove],
    });
  });

  it("reports failures when no reading proves the floor unsafe", () => {
    expect(
      decideStoreFormatFloor(
        { kind: "known", formats: { chatDb: 8 } },
        { readings: [], failures: [failure] },
      ),
    ).toEqual({
      kind: "indeterminate",
      reason: "unreadable-stores",
      failures: [failure],
    });
  });

  it.each([
    ["empty survey", { readings: [], failures: [] }],
    [
      "at target",
      { readings: [{ epicId: "epic", schemaVersion: 8 }], failures: [] },
    ],
  ])("clears for %s", (_label, survey) => {
    expect(
      decideStoreFormatFloor({ kind: "known", formats: { chatDb: 8 } }, survey),
    ).toEqual({ kind: "clear" });
  });

  it("clears an empty survey even when the target format is unknown", () => {
    expect(
      decideStoreFormatFloor(
        { kind: "unknown", reason: "above-table-ceiling" },
        { readings: [], failures: [] },
      ),
    ).toEqual({ kind: "clear" });
  });

  it("blocks any reading for a target with NO_CHAT_STORE", () => {
    expect(
      decideStoreFormatFloor(
        { kind: "known", formats: { chatDb: NO_CHAT_STORE } },
        { readings: [{ epicId: "epic", schemaVersion: 1 }], failures: [] },
      ),
    ).toEqual({
      kind: "blocked",
      targetChatDb: NO_CHAT_STORE,
      epics: [{ epicId: "epic", schemaVersion: 1 }],
    });
  });
});

it("uses the dedicated fatal code for a host older than its data", () => {
  expect(HOST_OLDER_THAN_DATA_FATAL_CODE).toBe("HOST_OLDER_THAN_DATA");
});
