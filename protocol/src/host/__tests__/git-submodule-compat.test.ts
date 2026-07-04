/**
 * Submodule-aware `git.*@1.1` compatibility + schema tests (v2 - simplified).
 *
 * Covers the ticket verifications for the de-implemented v1.1 schema:
 *  1. Registry validation - `listChangedFiles@1.1` carries an upgrade path and
 *     NO same-major downgrade path; `getFileDiff`/`getFileDiffs` stay v1.0-only
 *     (their no-op v1.1 bump was dropped).
 *  2. Transport skew - new-GUI/old-host upgrades a v1.0 listChangedFiles response
 *     to `submodules: []` / `gitlink: null`; old-GUI/new-host strips the v1.1
 *     response fields, and a v1.0 listChangedFiles request upgrades with
 *     `includeSubmodules: false` (parent-only, no fan-out).
 *  3. Stream no-leak - `subscribeStatus@1.0` frames stay parse-equivalent to
 *     today and carry no `gitlink` / `submodules`, even when a domain value does.
 *  4. Simplified shapes - the minimal `submodulePointer` (pin equality via
 *     `diverged` + dirty/conflicted flags, no merge-base direction) and the
 *     working-tree-only `submoduleChangeset` (files + a `pointer`, no
 *     commits-ahead expansion).
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
  gitChangedFileV10Schema,
  gitChangedFileV11Schema,
  gitListChangedFilesResponseSchema,
  gitListChangedFilesResponseSchemaV11,
  gitSubscribeStatusEventSchema,
  submoduleAvailabilitySchema,
  submoduleChangesetSchema,
  submodulePointerSchema,
  type GitChangedFileV10,
  type GitListChangedFilesRequest,
  type GitListChangedFilesResponse,
} from "@traycer/protocol/host/git-schemas";

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

// The parent's view of an ordinary (non-conflicted) dirty gitlink - the minimal
// pointer: recorded pin vs submodule HEAD equality via `diverged`, plus the
// dirty flags. NO ahead/behind direction, NO staged index pin.
const gitlinkDescriptor = {
  kind: "normal" as const,
  recordedPinSha: "a1b2c3",
  submoduleHeadSha: "d4e5f6",
  diverged: true,
  commitChanged: true,
  modifiedContent: false,
  untrackedContent: false,
};

// A working-tree-only v1.1 submodule section: WT files + the minimal pointer
// (no commits-ahead expansion).
const submoduleChangeset = {
  repoRoot: "/repo/traycer",
  parentPath: "traycer",
  branch: null,
  repoState: { kind: "clean" as const },
  files: [{ ...v10File, path: "clients/gui-app/src/app.tsx", gitlink: null }],
  pointer: gitlinkDescriptor,
  availability: { state: "ok" as const },
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
  it("validates: only listChangedFiles bumps to v1.1; diff methods stay v1.0-only", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();

    // listChangedFiles is the sole minor bump - v1.1 carries the nested snapshot.
    const listLine = hostRpcRegistry["git.listChangedFiles"][1];
    expect(listLine.latestMinor).toBe(1);
    expect(listLine.versions[0].upgradeFromPreviousVersion).toBeNull();
    expect(listLine.versions[1].upgradeFromPreviousVersion).not.toBeNull();
    // Same-major minors never need a downgrade bridge.
    expect(listLine.downgradePathsFromLatest).toEqual({});

    // getFileDiff / getFileDiffs reverted to v1.0-only: no v1.1 registered.
    for (const method of ["git.getFileDiff", "git.getFileDiffs"] as const) {
      const line = hostRpcRegistry[method][1];
      expect(line.latestMinor).toBe(0);
      expect(Object.keys(line.versions)).toEqual(["0"]);
      expect(line.versions[0].upgradeFromPreviousVersion).toBeNull();
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
});

describe("transport skew - old GUI (v1.0) against new host (v1.1)", () => {
  it("upgrades a v1.0 listChangedFiles request to includeSubmodules: false", () => {
    const v10ListRequest: GitListChangedFilesRequest = {
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

    // A v1.0 caller never asks for the submodule fan-out - the upgrade pins
    // `includeSubmodules: false` so the host serves the cheap parent-only view.
    expect(upgraded).toEqual({ ...v10ListRequest, includeSubmodules: false });
  });

  it("strips submodules[] and gitlink when downgrading a v1.1 response", () => {
    const v11Response = {
      ...v10Response,
      files: [
        { ...v10File, gitlink: null },
        { ...v10File, path: "traycer", gitlink: gitlinkDescriptor },
      ],
      submodules: [submoduleChangeset],
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
      submodules: [submoduleChangeset],
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
      submodules: [submoduleChangeset],
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

describe("v1.1 simplified schema shapes", () => {
  it("gitlink is additive: a v1.0 file parses as v1.1 with gitlink:null", () => {
    const parsed = gitChangedFileV11Schema.parse(v10File);
    expect(parsed.gitlink).toBeNull();
    // The frozen v1.0 schema never gains the field.
    expect("gitlink" in gitChangedFileV10Schema.parse(v10File)).toBe(false);
  });

  it("models the gitlink descriptor as a minimal normal|conflicted union", () => {
    const normal = submodulePointerSchema.parse({
      kind: "normal",
      recordedPinSha: "a1b2c3",
      submoduleHeadSha: "d4e5f6",
      diverged: true,
      commitChanged: true,
      modifiedContent: false,
      untrackedContent: false,
    });
    // The parsed normal pointer carries exactly the minimal fields and nothing
    // more - no conflict SHAs, and none of the legacy pin/ahead fields.
    expect(normal).toEqual({
      kind: "normal",
      recordedPinSha: "a1b2c3",
      submoduleHeadSha: "d4e5f6",
      diverged: true,
      commitChanged: true,
      modifiedContent: false,
      untrackedContent: false,
    });

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
      expect("diverged" in conflicted).toBe(false);
    }
  });

  it("nulls both pins on a normal pointer for added/removed gitlink edges", () => {
    const parsed = submodulePointerSchema.parse({
      kind: "normal",
      recordedPinSha: null,
      submoduleHeadSha: null,
      diverged: false,
      commitChanged: true,
      modifiedContent: false,
      untrackedContent: false,
    });
    if (parsed.kind === "normal") {
      expect(parsed.recordedPinSha).toBeNull();
      expect(parsed.submoduleHeadSha).toBeNull();
      expect(parsed.diverged).toBe(false);
    } else {
      expect.fail("expected normal");
    }
  });

  it("submodule changeset carries a pointer, not a relation", () => {
    const parsed = submoduleChangesetSchema.parse(submoduleChangeset);
    expect(submoduleChangesetSchema.parse(parsed)).toEqual(parsed);
    expect("relation" in parsed).toBe(false);
    expect(parsed.pointer.kind).toBe("normal");
    expect(parsed.parentPath).toBe("traycer");
  });

  it("models availability as ok | unavailable{reason} and defaults to ok", () => {
    // Additive: a changeset without `availability` parses to `ok`.
    const { availability: _omitted, ...withoutAvailability } =
      submoduleChangeset;
    const defaulted = submoduleChangesetSchema.parse(withoutAvailability);
    expect(defaulted.availability).toEqual({ state: "ok" });

    // The unavailable variant carries a coarse reason and no `ok`-only shape.
    const unavailable = submoduleAvailabilitySchema.parse({
      state: "unavailable",
      reason: "git-error",
    });
    expect(unavailable).toEqual({ state: "unavailable", reason: "git-error" });
  });

  it("tolerates unknown/missing reason values, degrading them to git-error", () => {
    // A future host emitting a reason value this GUI does not know must NOT
    // hard-fail parsing: `.catch("git-error")` degrades unknown enum VALUES in
    // the retained `reason` field to the known default. Minor-skew projection
    // strips unknown KEYS, never unknown VALUES, so the bare enum was a trap.
    const futureReason = submoduleAvailabilitySchema.parse({
      state: "unavailable",
      reason: "timeout",
    });
    expect(futureReason).toEqual({ state: "unavailable", reason: "git-error" });

    // The same tolerance absorbs a MISSING reason (deliberate `.catch` side
    // effect): it defaults to `git-error` instead of rejecting the payload.
    const missingReason = submoduleAvailabilitySchema.parse({
      state: "unavailable",
    });
    expect(missingReason).toEqual({ state: "unavailable", reason: "git-error" });

    // End to end: an unknown reason on a nested submodule degrades in place and
    // does NOT fail the whole listChangedFiles@1.1 response.
    const response = {
      ...v10Response,
      files: [{ ...v10File, gitlink: null }],
      submodules: [
        {
          ...submoduleChangeset,
          availability: { state: "unavailable", reason: "timeout" },
        },
      ],
    };
    const parsed = gitListChangedFilesResponseSchemaV11.parse(response);
    expect(parsed.submodules[0].availability).toEqual({
      state: "unavailable",
      reason: "git-error",
    });
  });

  it("round-trips a full v1.1 listChangedFiles response with a submodule", () => {
    const response = {
      ...v10Response,
      files: [
        { ...v10File, gitlink: null },
        { ...v10File, path: "traycer", gitlink: gitlinkDescriptor },
      ],
      submodules: [submoduleChangeset],
    };

    const parsed = gitListChangedFilesResponseSchemaV11.parse(response);
    const reparsed = gitListChangedFilesResponseSchemaV11.parse(parsed);
    expect(reparsed).toEqual(parsed);
    expect(parsed.submodules[0].parentPath).toBe("traycer");
    expect(parsed.submodules[0].pointer.kind).toBe("normal");
  });
});
