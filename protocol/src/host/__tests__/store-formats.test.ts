import { describe, expect, it } from "vitest";
import {
  HOST_OLDER_THAN_DATA_FATAL_CODE,
  NO_CHAT_STORE,
  SOURCE_TREE_HOST_VERSION,
  decideStoreFormatFloor,
  isReleasedHostVersion,
  isValidStoreFormatVersion,
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
    // R4: this one already passes via incomparability (`compareHostVersions`
    // cannot order a released target against a build stamp at all), which is
    // a different path than the sentinel row below (which passes because
    // `isReleasedHostVersion` names it explicitly, not because it is
    // incomparable - `0.0.0-dev` DOES compare, and orders below every
    // release). Pinned so a future "simplify" collapsing the two into one
    // rule cannot silently make the sentinel case the only thing holding
    // this one up.
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
    // R4: `SOURCE_TREE_HOST_VERSION` parses as SemVer and sorts below every
    // release, so ordering ALONE would call a released target an upgrade
    // over it and skip the floor - while a source build writes today's
    // format. `isReleasedHostVersion` has to name the sentinel explicitly
    // for the installed side, not merely rely on `compareHostVersions`. The
    // build-stamped-installed sibling above already covers the same shape
    // via incomparability - pinning the sentinel here separately means a
    // future "simplify" that special-cases the sentinel cannot break this
    // one while leaving that one green.
    [
      "released target over the source-tree sentinel installed",
      "1.2.0",
      SOURCE_TREE_HOST_VERSION,
      null,
      { applies: true },
    ],
  ])("applicability: %s", (_label, target, installed, formats, expected) => {
    expect(storeFloorApplicability(target, installed, formats)).toEqual(
      expected,
    );
  });

  // R-bot: the rule SemVer precedence ignores build metadata, so `2.0.0+a`
  // and `2.0.0+b` compare EQUAL while being different artifacts with possibly
  // different chatDb formats - the install path itself treats that move as a
  // DOWNGRADE needing `--allow-downgrade`, so the floor must not skip it
  // either. No existing test pinned this before the bot round landed it - the
  // suite passed 54/54 straight through the change, which was its own
  // finding.
  it.each([
    [
      "different build metadata, same SemVer precedence",
      "2.0.0+old",
      "2.0.0+new",
      null,
      { applies: true },
    ],
    [
      "identical string (same released build)",
      "2.0.0",
      "2.0.0",
      null,
      { applies: false, reason: "target-not-older" },
    ],
    [
      "strictly newer released target",
      "2.1.0",
      "2.0.0",
      null,
      { applies: false, reason: "target-not-older" },
    ],
    [
      "strictly older released target",
      "1.2.0",
      "1.3.0",
      null,
      { applies: true },
    ],
    [
      "strictly newer rc target",
      "1.3.0-rc.4",
      "1.3.0-rc.1",
      null,
      { applies: false, reason: "target-not-older" },
    ],
    [
      "off-ladder target with a declaration, over a release",
      "local-x",
      "1.3.0",
      { chatDb: 9 },
      { applies: true },
    ],
    // Codex + CodeRabbit: a version string is identity for a REGISTRY
    // artifact, whose caller passes no declaration and keeps both shortcuts
    // (the undeclared rows above). A declaring target is a local archive that
    // can claim ANY string - identical or newer - while declaring an OLDER
    // format, so with a declaration neither string shortcut applies.
    [
      "identical string, WITH an older declaration - the finding: no longer skipped",
      "1.3.0",
      "1.3.0",
      { chatDb: 8 },
      { applies: true },
    ],
    [
      "identical string, WITH a matching declaration - applies too; the format comparison decides",
      "1.3.0",
      "1.3.0",
      { chatDb: 9 },
      { applies: true },
    ],
    [
      "strictly newer string, WITH an older declaration - a repackaged local archive: evaluates",
      "1.4.0",
      "1.3.0",
      { chatDb: 8 },
      { applies: true },
    ],
    [
      "strictly newer string, WITH a matching declaration - evaluates too; formats clear it",
      "1.4.0",
      "1.3.0",
      { chatDb: 9 },
      { applies: true },
    ],
  ] as const)(
    "applicability (build-metadata / precedence): %s",
    (_label, target, installed, formats, expected) => {
      expect(storeFloorApplicability(target, installed, formats)).toEqual(
        expected,
      );
    },
  );

  // An identical RELEASED string with no declaration stands aside (the row
  // above); an identical UNRELEASED string never does. Two arms each make
  // that so on their own, and the rows below pass through the first one they
  // meet: an unreleased target must declare a format to get past the
  // off-ladder guard at all, and a present declaration then evaluates before
  // either string arm is reached. Were the declaration arm ever removed, the
  // installed-side guard (`!isReleasedHostVersion(installedVersion)`) would
  // send the same rows to `applies: true` next - that guard is pinned on its
  // own by the "released target over the source-tree sentinel installed" row.
  // So these rows pin the OUTCOME the team's daily local rebuilds depend on,
  // two builds sharing a string and differing in format, and do not single
  // out which arm provides it. The fix for a failure here is NOT an
  // `isReleasedHostVersion(targetVersion)` test on the exact-match arm: the
  // off-ladder guard already sends every unreleased target out before it.
  it.each([
    [
      "the source-tree sentinel repeated on both sides",
      SOURCE_TREE_HOST_VERSION,
      SOURCE_TREE_HOST_VERSION,
    ],
    [
      "a repeated desktop build stamp",
      "production.1757000000000.abc1234",
      "production.1757000000000.abc1234",
    ],
    [
      "a repeated local-file install stamp",
      "local-host.tar.gz-x",
      "local-host.tar.gz-x",
    ],
  ] as const)(
    "applies (never stands aside) for an identical UNRELEASED string: %s",
    (_label, target, installed) => {
      expect(storeFloorApplicability(target, installed, { chatDb: 9 })).toEqual(
        { applies: true },
      );
    },
  );

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
  const failure = {
    epicId: "epic-failed",
    reason: "unreadable-chat-db" as const,
  };
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

  it("blocks on readings above target, even when failures are present, and carries both", () => {
    // `blocked` outranks `indeterminate` - the proven reading is the more
    // useful refusal to lead with - but the unreadable store is still a
    // store the verdict cannot speak for, and dropping it would
    // under-report what the user was about to lose.
    expect(
      decideStoreFormatFloor(
        { kind: "known", formats: { chatDb: 8 } },
        { readings: [readingAbove], failures: [failure] },
      ),
    ).toEqual({
      kind: "blocked",
      targetChatDb: 8,
      epics: [readingAbove],
      failures: [failure],
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
      failures: [],
    });
  });
});

it("uses the dedicated fatal code for a host older than its data", () => {
  expect(HOST_OLDER_THAN_DATA_FATAL_CODE).toBe("HOST_OLDER_THAN_DATA");
});

describe("isValidStoreFormatVersion", () => {
  // The single predicate behind the manifest parser, the archive
  // declaration and the store row - its edges are worth pinning once here
  // rather than three times downstream.
  it.each([1, 9])("accepts %s", (value) => {
    expect(isValidStoreFormatVersion(value)).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["a negative integer", -1],
    ["a fractional number", 1.5],
    ["NaN", Number.NaN],
    ["one past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
    ["a numeric string", "9"],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isValidStoreFormatVersion(value)).toBe(false);
  });
});
