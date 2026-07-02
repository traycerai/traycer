/**
 * Submodule-aware `git.*@1.1` compatibility + schema tests.
 *
 * Covers the three ticket verifications:
 *  1. Registry validation - `listChangedFiles`/`getFileDiff`/`getFileDiffs@1.1`
 *     carry an upgrade path and NO same-major downgrade path.
 *  2. Transport skew - new-GUI/old-host upgrades to `submodules: []` /
 *     `gitlink: null` and projects `compareFromSha` off the wire; old-GUI/
 *     new-host strips the v1.1 fields.
 *  3. Stream no-leak - `subscribeStatus@1.0` frames stay parse-equivalent to
 *     today and carry no `gitlink`, even when a domain file carries one.
 */
import { describe, it, expect } from "vitest";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  commitAheadFileSchema,
  gitChangedFileV10Schema,
  gitChangedFileV11Schema,
  gitGetFileDiffRequestSchema,
  gitGetFileDiffRequestSchemaV11,
  gitGetFileDiffsRequestSchema,
  gitGetFileDiffsRequestSchemaV11,
  gitListChangedFilesRequestSchemaV11,
  gitListChangedFilesResponseSchema,
  gitListChangedFilesResponseSchemaV11,
  gitSubscribeStatusEventSchema,
  submoduleChangesetSchema,
  submodulePointerSchema,
  submoduleRelationSchema,
  type GitChangedFileV10,
  type GitGetFileDiffRequest,
  type GitGetFileDiffsRequest,
  type GitListChangedFilesResponse,
} from "@traycer/protocol/host/git-schemas";
import { DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET } from "@traycer/protocol/host/git-constants";

const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;

// A plain v1.0 file row (no gitlink).
const v10File: GitChangedFileV10 = {
  path: "authn-v3/src/routes/session.ts",
  previousPath: null,
  status: "modified",
  stage: "unstaged",
  isBinary: false,
  insertions: 12,
  deletions: 3,
  sizeBytes: 2048,
  stagedOid: null,
  worktreeOid: "wt-oid",
};

// The parent's view of an ordinary (non-conflicted) dirty gitlink.
const gitlinkDescriptor = {
  kind: "normal" as const,
  recordedPinSha: "a1b2c3",
  stagedPinSha: "a1b2c3",
  commitChanged: true,
  modifiedContent: false,
  untrackedContent: false,
};

// A fully-populated v1.1 submodule section: ahead-of-pin with committed files.
// A changeset always carries a computed `relation` (never a conflict).
const aheadChangeset = {
  repoRoot: "/repo/traycer",
  parentPath: "traycer",
  branch: null,
  repoState: { kind: "clean" as const },
  relation: {
    state: "ahead" as const,
    recordedPinSha: "a1b2c3",
    submoduleHeadSha: "d4e5f6",
    commitsAhead: {
      count: 2,
      files: [
        {
          path: "clients/gui-app/src/lib/foo.ts",
          previousPath: null,
          status: "modified" as const,
          isBinary: false,
          insertions: 40,
          deletions: 5,
        },
      ],
    },
  },
  files: [{ ...v10File, path: "clients/gui-app/src/app.tsx", gitlink: null }],
};

const v10Response: GitListChangedFilesResponse = {
  runningDir: "/repo",
  headSha: "head-sha",
  branch: "development",
  files: [v10File],
  fingerprint: "fp",
  repoMode: "normal",
  repoState: { kind: "clean" },
};

describe("git.*@1.1 registry", () => {
  it("validates: minor upgrade present, no same-major downgrade path", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();

    for (const method of [
      "git.listChangedFiles",
      "git.getFileDiff",
      "git.getFileDiffs",
    ] as const) {
      const line = hostRpcRegistry[method][1];
      expect(line.latestMinor).toBe(1);
      expect(line.versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(line.versions[1].upgradeFromPreviousVersion).not.toBeNull();
      // Same-major minors never need a downgrade bridge.
      expect(line.downgradePathsFromLatest).toEqual({});
    }
  });

  it("leaves git.subscribeStatus frozen at v1.0 (stream, only version 0)", () => {
    // subscribeStatus is a stream method - it must never gain a minor. Absence
    // from the unary registry is not enough; assert the stream line itself.
    expect("git.subscribeStatus" in hostRpcRegistry).toBe(false);

    const streamLine = hostStreamRpcRegistry["git.subscribeStatus"][1];
    expect(streamLine.latestMinor).toBe(0);
    expect(Object.keys(streamLine.versions)).toEqual(["0"]);
  });
});

describe("transport skew - new GUI (v1.1) against old host (v1.0)", () => {
  it("upgrades a v1.0 listChangedFiles response to submodules:[] / gitlink:null", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["git.listChangedFiles"],
      V10,
      V11,
      v10Response,
    );

    expect(upgraded.submodules).toEqual([]);
    expect(upgraded.files).toHaveLength(1);
    expect(upgraded.files[0].gitlink).toBeNull();
    // The bridged result is a valid v1.1 response.
    expect(gitListChangedFilesResponseSchemaV11.parse(upgraded)).toEqual(
      upgraded,
    );
  });

  it("strips compareFromSha off the wire when projecting onto a v1.0 host", () => {
    const v11Request = {
      hostId: "h",
      runningDir: "/repo/traycer",
      filePath: "clients/gui-app/src/lib/foo.ts",
      previousPath: null,
      stage: "unstaged" as const,
      ignoreWhitespace: false,
      byteBudget: null,
      compareFromSha: "a1b2c3",
    };

    const onWire = gitGetFileDiffRequestSchema.parse(v11Request);
    expect("compareFromSha" in onWire).toBe(false);
  });

  it("strips per-file compareFromSha from a v1.0 getFileDiffs batch", () => {
    const v11Batch = {
      hostId: "h",
      runningDir: "/repo/traycer",
      files: [
        {
          filePath: "clients/gui-app/src/lib/foo.ts",
          previousPath: null,
          stage: "unstaged" as const,
          compareFromSha: "a1b2c3",
        },
      ],
      ignoreWhitespace: false,
      byteBudget: DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
    };

    const onWire = gitGetFileDiffsRequestSchema.parse(v11Batch);
    expect("compareFromSha" in onWire.files[0]).toBe(false);
  });
});

describe("transport skew - old GUI (v1.0) against new host (v1.1)", () => {
  it("upgrades a v1.0 listChangedFiles request to refreshRelations:false", () => {
    const v10ListRequest = {
      hostId: "h",
      runningDir: "/repo",
      ignoreWhitespace: false,
    };

    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["git.listChangedFiles"],
      V10,
      V11,
      v10ListRequest,
    );

    expect(upgraded.refreshRelations).toBe(false);
  });

  it("upgrades a v1.0 getFileDiff request to compareFromSha:null", () => {
    const v10Request: GitGetFileDiffRequest = {
      hostId: "h",
      runningDir: "/repo",
      filePath: "authn-v3/src/routes/session.ts",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
      byteBudget: null,
    };

    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["git.getFileDiff"],
      V10,
      V11,
      v10Request,
    );

    expect(upgraded.compareFromSha).toBeNull();
  });

  it("upgrades a v1.0 getFileDiffs batch to per-file compareFromSha:null", () => {
    const v10Batch: GitGetFileDiffsRequest = {
      hostId: "h",
      runningDir: "/repo",
      files: [
        {
          filePath: "authn-v3/src/routes/session.ts",
          previousPath: null,
          stage: "unstaged",
        },
      ],
      ignoreWhitespace: false,
      byteBudget: DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
    };

    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["git.getFileDiffs"],
      V10,
      V11,
      v10Batch,
    );

    expect(upgraded.files[0].compareFromSha).toBeNull();
  });

  it("strips submodules[] and gitlink when downgrading a v1.1 response", () => {
    const v11Response = {
      ...v10Response,
      files: [
        { ...v10File, gitlink: null },
        { ...v10File, path: "traycer", gitlink: gitlinkDescriptor },
      ],
      submodules: [aheadChangeset],
    };

    const onWire = gitListChangedFilesResponseSchema.parse(v11Response);
    expect("submodules" in onWire).toBe(false);
    expect(onWire.files.every((file) => !("gitlink" in file))).toBe(true);
  });
});

describe("subscribeStatus@1.0 no-leak", () => {
  const cleanSnapshot = {
    type: "snapshot" as const,
    runningDir: "/repo",
    headSha: "head-sha",
    branch: "development",
    files: [v10File],
    fingerprint: "fp",
    repoMode: "normal" as const,
    repoState: { kind: "clean" as const },
    pollStartedAtMs: 1_700_000_000,
  };

  it("snapshot frames stay parse-equivalent to today", () => {
    expect(gitSubscribeStatusEventSchema.parse(cleanSnapshot)).toEqual(
      cleanSnapshot,
    );
  });

  it("drops leaked gitlink AND top-level submodules from a snapshot", () => {
    const leaky = {
      ...cleanSnapshot,
      files: [{ ...v10File, gitlink: gitlinkDescriptor }],
      submodules: [aheadChangeset],
    };

    const parsed = gitSubscribeStatusEventSchema.parse(leaky);
    // Stripped back to the frozen shape - identical to the clean snapshot.
    expect(parsed).toEqual(cleanSnapshot);
    expect("submodules" in parsed).toBe(false);
    if (parsed.type === "snapshot") {
      expect(parsed.files.every((file) => !("gitlink" in file))).toBe(true);
    } else {
      expect.fail("expected snapshot");
    }
  });

  it("drops leaked gitlink AND top-level submodules from an updated frame", () => {
    const leaky = {
      type: "updated" as const,
      runningDir: "/repo",
      headSha: "head-sha",
      branch: "development",
      files: [{ ...v10File, gitlink: gitlinkDescriptor }],
      fingerprint: "fp",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
      changedPaths: [v10File.path],
      pollStartedAtMs: 1_700_000_001,
      submodules: [aheadChangeset],
    };

    const parsed = gitSubscribeStatusEventSchema.parse(leaky);
    expect("submodules" in parsed).toBe(false);
    if (parsed.type === "updated") {
      expect(parsed.files.every((file) => !("gitlink" in file))).toBe(true);
    } else {
      expect.fail("expected updated");
    }
  });
});

describe("v1.1 schema shapes", () => {
  it("gitlink is additive: a v1.0 file parses as v1.1 with gitlink:null", () => {
    const parsed = gitChangedFileV11Schema.parse(v10File);
    expect(parsed.gitlink).toBeNull();
    // The frozen v1.0 schema never gains the field.
    expect("gitlink" in gitChangedFileV10Schema.parse(v10File)).toBe(false);
  });

  it("commitsAhead exists only on the ahead relation variant", () => {
    const ahead = submoduleRelationSchema.parse({
      state: "ahead",
      recordedPinSha: "a",
      submoduleHeadSha: "b",
      commitsAhead: { count: 1, files: [] },
    });
    expect(ahead.state).toBe("ahead");
    if (ahead.state === "ahead") {
      expect(ahead.commitsAhead.count).toBe(1);
    }

    // A behind relation cannot carry commitsAhead - it is stripped structurally.
    const behind = submoduleRelationSchema.parse({
      state: "behind",
      recordedPinSha: "a",
      submoduleHeadSha: "b",
      commitsAhead: { count: 9, files: [] },
    });
    expect("commitsAhead" in behind).toBe(false);
  });

  it("classifies unknown relations with a reason and nullable pins", () => {
    const parsed = submoduleRelationSchema.parse({
      state: "unknown",
      reason: "missing-pin-object",
      recordedPinSha: null,
      submoduleHeadSha: null,
    });
    expect(parsed.state).toBe("unknown");
    if (parsed.state === "unknown") {
      expect(parsed.reason).toBe("missing-pin-object");
    }
  });

  it("models the gitlink descriptor as a normal|conflicted union", () => {
    const normal = submodulePointerSchema.parse({
      kind: "normal",
      recordedPinSha: "a1b2c3",
      stagedPinSha: "a1b2c3",
      commitChanged: true,
      modifiedContent: false,
      untrackedContent: false,
    });
    expect(normal.kind).toBe("normal");
    // A normal descriptor cannot carry conflict SHAs - the mixture is stripped.
    expect("baseSha" in normal).toBe(false);

    const conflicted = submodulePointerSchema.parse({
      kind: "conflicted",
      baseSha: "base",
      oursSha: "ours",
      theirsSha: "theirs",
    });
    expect(conflicted.kind).toBe("conflicted");
    if (conflicted.kind === "conflicted") {
      expect(conflicted.theirsSha).toBe("theirs");
      // The conflicted variant carries no pins/flags.
      expect("recordedPinSha" in conflicted).toBe(false);
    }
  });

  it("round-trips a full v1.1 listChangedFiles response with a submodule", () => {
    const response = {
      ...v10Response,
      files: [
        { ...v10File, gitlink: null },
        { ...v10File, path: "traycer", gitlink: gitlinkDescriptor },
      ],
      submodules: [aheadChangeset],
    };

    const parsed = gitListChangedFilesResponseSchemaV11.parse(response);
    const reparsed = gitListChangedFilesResponseSchemaV11.parse(parsed);
    expect(reparsed).toEqual(parsed);
    expect(parsed.submodules[0].parentPath).toBe("traycer");
  });

  it("defaults refreshRelations to false and accepts an explicit true", () => {
    // Additive: a v1.1 request that omits the field parses to `false`.
    const defaulted = gitListChangedFilesRequestSchemaV11.parse({
      hostId: "h",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    expect(defaulted.refreshRelations).toBe(false);

    // An explicit manual-refresh signal round-trips.
    const refreshed = gitListChangedFilesRequestSchemaV11.parse({
      hostId: "h",
      runningDir: "/repo",
      ignoreWhitespace: false,
      refreshRelations: true,
    });
    expect(refreshed.refreshRelations).toBe(true);
  });

  it("accepts a per-file compareFromSha on v1.1 diff requests", () => {
    const single = gitGetFileDiffRequestSchemaV11.parse({
      hostId: "h",
      runningDir: "/repo/traycer",
      filePath: "clients/gui-app/src/lib/foo.ts",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
      compareFromSha: "a1b2c3",
    });
    expect(single.compareFromSha).toBe("a1b2c3");
    // Defaulted to null when omitted (additive).
    const defaulted = gitGetFileDiffRequestSchemaV11.parse({
      hostId: "h",
      runningDir: "/repo",
      filePath: "authn-v3/src/routes/session.ts",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
    });
    expect(defaulted.compareFromSha).toBeNull();

    const batch = gitGetFileDiffsRequestSchemaV11.parse({
      hostId: "h",
      runningDir: "/repo/traycer",
      files: [
        {
          filePath: "clients/gui-app/src/lib/foo.ts",
          previousPath: null,
          stage: "unstaged",
        },
      ],
      ignoreWhitespace: false,
      byteBudget: DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
    });
    expect(batch.files[0].compareFromSha).toBeNull();
  });

  it("round-trips a commit-ahead file row", () => {
    const file = commitAheadFileSchema.parse({
      path: "clients/gui-app/src/lib/bar.ts",
      previousPath: null,
      status: "added",
      isBinary: false,
      insertions: 88,
      deletions: 0,
    });
    expect(commitAheadFileSchema.parse(file)).toEqual(file);
  });

  it("round-trips a submodule changeset", () => {
    const parsed = submoduleChangesetSchema.parse(aheadChangeset);
    expect(submoduleChangesetSchema.parse(parsed)).toEqual(parsed);
  });
});
