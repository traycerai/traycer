import { describe, expect, it } from "vitest";
import {
  isTileRefRecordBacked,
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  gitDiffTileId,
  makeGitBundleDiffTile,
  makeGitFileDiffTile,
} from "@/lib/git/git-diff-tile";
import { makePrDetailTile } from "@/lib/pr/pr-detail-tile";
import { makePrDiffTile } from "@/lib/pr/pr-diff-tile";
import {
  parsePrDiffTileViewState,
  serializePrDiffTileViewState,
} from "@/stores/epics/canvas/tile-schema/diff-tile-view";
import { prDiffTileSchema } from "@/stores/epics/canvas/tile-schema/pr-diff-tile";
import type {
  EpicArtifactRef,
  EpicTerminalRef,
  GitDiffTileRef,
  PrDetailTileRef,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";
import {
  parseReleasedTerminalRef,
  serializeReleasedTerminalRef,
} from "@/stores/epics/canvas/__tests__/fixtures/released-terminal-ref-reader";

const HOST = "host-1";

describe("gitDiffTileId", () => {
  it("is stable for the same host + payload", () => {
    const payload = {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
    } as const;
    expect(gitDiffTileId(HOST, payload)).toBe(gitDiffTileId(HOST, payload));
  });

  it("differs across payloads, stages, hosts, and kinds", () => {
    const fileA = gitDiffTileId(HOST, {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
    });
    const fileAStaged = gitDiffTileId(HOST, {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "staged",
    });
    const fileB = gitDiffTileId(HOST, {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/b.ts",
      stage: "unstaged",
    });
    const otherHost = gitDiffTileId("host-2", {
      kind: "file",
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
    });
    const bundle = gitDiffTileId(HOST, {
      kind: "bundle",
      runningDir: "/repo",
      bundleGroup: "changes",
    });
    expect(new Set([fileA, fileAStaged, fileB, otherHost, bundle]).size).toBe(
      5,
    );
  });
});

describe("parseTileRef / serializeTileRef", () => {
  it("round-trips a chat artifact ref", () => {
    const ref: EpicArtifactRef = {
      id: "art-1",
      instanceId: "inst-art-1",
      type: "chat",
      name: "Chat",
      hostId: HOST,
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
  });

  it("keeps terminal-agent refs on the record-backed schema unchanged", () => {
    const ref: EpicArtifactRef = {
      id: "terminal-agent-1",
      instanceId: "inst-terminal-agent-1",
      type: "terminal-agent",
      name: "Agent",
      hostId: HOST,
    };
    const serialized = serializeTileRef(ref);

    expect(serialized).toEqual({
      id: ref.id,
      instanceId: ref.instanceId,
      type: ref.type,
      name: ref.name,
      hostId: ref.hostId,
    });
    expect(parseTileRef(serialized)).toEqual(ref);
    expect(isTileRefRecordBacked(ref)).toBe(true);
  });

  it("round-trips a terminal ref with a cwd", () => {
    const withCwd: EpicTerminalRef = {
      id: "term-1",
      instanceId: "inst-term-1",
      type: "terminal",
      name: "wt-a",
      titleSource: "default",
      hostId: HOST,
      cwd: "/repo/wt-a",
    };
    expect(parseTileRef(serializeTileRef(withCwd))).toEqual(withCwd);
  });

  it("round-trips a canonical pointer with released-reader compatibility fields", () => {
    const canonical: EpicTerminalRef = {
      id: "term-canonical",
      instanceId: "inst-term-canonical",
      type: "terminal",
      name: "Local presentation",
      hostId: HOST,
      authority: "host",
      legacyFallback: {
        name: "Fallback title",
        titleSource: "manual",
        cwd: "/repo",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
    };

    const serialized = serializeTileRef(canonical);
    expect(serialized).toMatchObject({
      authority: "host",
      cwd: "/repo",
      titleSource: "manual",
    });
    expect(parseReleasedTerminalRef(serialized)).toMatchObject({
      id: canonical.id,
      instanceId: canonical.instanceId,
      name: canonical.name,
      hostId: canonical.hostId,
      cwd: "/repo",
      titleSource: "manual",
    });
    expect(parseTileRef(serialized)).toEqual(canonical);
  });

  it("preserves an unknown authority without promoting rollback evidence", () => {
    const persisted = {
      id: "term-future",
      instanceId: "inst-term-future",
      type: "terminal",
      name: "Local presentation",
      hostId: HOST,
      authority: "host-v2",
      cwd: "/compatible",
      titleSource: "manual",
      legacyFallback: {
        name: "Nested fallback",
        cwd: "/nested",
        titleSource: "default",
      },
    };

    const parsed = parseTileRef(persisted);
    expect(parsed).toEqual({
      id: "term-future",
      instanceId: "inst-term-future",
      type: "terminal",
      name: "Local presentation",
      hostId: HOST,
      authority: "unsupported",
      rawAuthority: "host-v2",
      legacyFallback: {
        name: "Local presentation",
        cwd: "/compatible",
        titleSource: "manual",
      },
    });
    if (parsed === null) throw new Error("current reader dropped future ref");
    const serialized = serializeTileRef(parsed);
    expect(serialized).toMatchObject({
      authority: "host-v2",
      cwd: "/compatible",
      titleSource: "manual",
    });
    expect(parseReleasedTerminalRef(serialized)).not.toBeNull();
    expect(parseTileRef(serialized)).toEqual(parsed);
  });

  it("round-trips an unknown structured authority payload verbatim", () => {
    const authority = {
      kind: "host-v3",
      version: 3,
      features: ["remote-owner", { lease: true }],
    };
    const parsed = parseTileRef({
      id: "term-future-structured",
      instanceId: "inst-term-future-structured",
      type: "terminal",
      name: "Future terminal",
      hostId: HOST,
      authority,
      cwd: "/rollback",
      titleSource: "default",
    });
    expect(parsed).toMatchObject({
      authority: "unsupported",
      rawAuthority: authority,
    });
    if (parsed === null) throw new Error("current reader dropped future ref");

    const serialized = serializeTileRef(parsed);
    expect(serialized).toMatchObject({ authority });
    expect(parseTileRef(serialized)).toEqual(parsed);
  });

  it("survives current-write, released-read/write, and current-upgrade parsing", () => {
    const canonical: EpicTerminalRef = {
      id: "term-downgrade",
      instanceId: "inst-term-downgrade",
      type: "terminal",
      name: "Local presentation",
      hostId: HOST,
      authority: "host",
      legacyFallback: {
        name: "Fallback title",
        titleSource: "default",
        cwd: "/repo/downgrade",
      },
      origin: "shell",
    };
    const released = parseReleasedTerminalRef(serializeTileRef(canonical));
    if (released === null) throw new Error("released reader dropped the ref");
    expect(parseTileRef(serializeReleasedTerminalRef(released))).toEqual({
      id: canonical.id,
      instanceId: canonical.instanceId,
      type: "terminal",
      name: canonical.name,
      hostId: canonical.hostId,
      cwd: "/repo/downgrade",
      titleSource: "default",
      origin: "shell",
    });
  });

  it("round-trips a setup terminal ref's origin", () => {
    const setupTerminal: EpicTerminalRef = {
      id: "term-setup",
      instanceId: "inst-term-setup",
      type: "terminal",
      name: "Setup: repo main",
      titleSource: "manual",
      hostId: HOST,
      cwd: "/worktrees/repo",
      origin: "setup",
    };
    expect(parseTileRef(serializeTileRef(setupTerminal))).toEqual(
      setupTerminal,
    );
  });

  it("round-trips a provider-login terminal ref's origin and originProviderId", () => {
    const signInTerminal: EpicTerminalRef = {
      id: "term-signin",
      instanceId: "inst-term-signin",
      type: "terminal",
      name: "Copilot sign-in",
      titleSource: "manual",
      hostId: HOST,
      cwd: "~",
      origin: "provider-login",
      originProviderId: "copilot",
    };
    expect(parseTileRef(serializeTileRef(signInTerminal))).toEqual(
      signInTerminal,
    );
  });

  it("round-trips manager lifecycleOwner without origin enrichment", () => {
    const managerTerminal: EpicTerminalRef = {
      id: "term-manager",
      instanceId: "inst-term-manager",
      type: "terminal",
      name: "manager row",
      titleSource: "manual",
      hostId: HOST,
      cwd: "/worktrees/repo",
      lifecycleOwner: "manager",
    };
    expect(parseTileRef(serializeTileRef(managerTerminal))).toEqual(
      managerTerminal,
    );
  });

  it("drops origin and originProviderId for an ordinary shell ref (undefined, not omitted)", () => {
    const shellTerminal: EpicTerminalRef = {
      id: "term-shell",
      instanceId: "inst-term-shell",
      type: "terminal",
      name: "shell",
      titleSource: "manual",
      hostId: HOST,
      cwd: "/repo",
    };
    const roundTripped = parseTileRef(serializeTileRef(shellTerminal));
    expect(roundTripped).toEqual(shellTerminal);
    if (roundTripped === null || roundTripped.type !== "terminal") {
      throw new Error("expected a terminal ref");
    }
    expect(roundTripped.origin).toBeUndefined();
    expect(roundTripped.originProviderId).toBeUndefined();
  });

  it("derives terminal title source for legacy refs", () => {
    expect(
      parseTileRef({
        id: "term-default",
        instanceId: "inst-term-default",
        type: "terminal",
        name: "New Terminal",
        hostId: HOST,
        cwd: "/repo",
      }),
    ).toMatchObject({ titleSource: "default" });
    expect(
      parseTileRef({
        id: "term-manual",
        instanceId: "inst-term-manual",
        type: "terminal",
        name: "shell",
        hostId: HOST,
        cwd: "/repo",
      }),
    ).toMatchObject({ titleSource: "manual" });
  });

  it("rejects a terminal ref without a cwd key", () => {
    const legacy = {
      id: "term-legacy",
      instanceId: "inst-term-legacy",
      type: "terminal",
      name: "Terminal",
      hostId: HOST,
    };
    expect(parseTileRef(legacy)).toBeNull();
  });

  it("rejects a malformed terminal cwd", () => {
    const base = {
      id: "term-bad",
      instanceId: "inst-term-bad",
      type: "terminal",
      name: "Terminal",
      hostId: HOST,
    };
    expect(parseTileRef({ ...base, cwd: 42 })).toBeNull();
    expect(parseTileRef({ ...base, cwd: {} })).toBeNull();
    expect(parseTileRef({ ...base, cwd: "" })).toBeNull();
  });

  it("round-trips a workspace-file ref", () => {
    const ref: WorkspaceFileRef = {
      id: "workspace-file:d:w:f",
      instanceId: "inst-file",
      type: "workspace-file",
      name: "f.ts",
      hostId: HOST,
      workspacePath: "/ws",
      filePath: "src/f.ts",
    };
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
  });

  it("round-trips git-diff file and bundle tiles", () => {
    const file = makeGitFileDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: {
        workspaceLabel: "workspace",
        repositoryLabel: "packages/traycer",
      },
    });
    const bundle = makeGitBundleDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      bundleGroup: "changes",
      repositoryContext: {
        workspaceLabel: "workspace",
        repositoryLabel: "packages/traycer",
      },
    });
    expect(parseTileRef(serializeTileRef(file))).toEqual(file);
    expect(parseTileRef(serializeTileRef(bundle))).toEqual(bundle);
  });

  it("recomputes a random git-diff id on parse", () => {
    const tile = makeGitFileDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: null,
    });
    const parsed = parseTileRef({
      id: "legacy-random-uuid",
      type: "git-diff",
      name: tile.name,
      hostId: tile.hostId,
      diff: {
        kind: "file",
        runningDir: "/repo",
        filePath: "src/a.ts",
        stage: "unstaged",
      },
      view: {
        collapsedFilePaths: [],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(tile.id);
  });

  it("round-trips a pr-detail tile", () => {
    const tile = makePrDetailTile({
      hostId: HOST,
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      name: "acme/widgets#42",
    });
    expect(parseTileRef(serializeTileRef(tile))).toEqual(tile);
  });

  it("recomputes the pr-detail id on parse from host + base coordinates", () => {
    const tile = makePrDetailTile({
      hostId: HOST,
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      name: "acme/widgets#42",
    });
    const parsed = parseTileRef({
      id: "legacy-random-uuid",
      instanceId: tile.instanceId,
      type: "pr-detail",
      name: tile.name,
      hostId: tile.hostId,
      githubHost: tile.githubHost,
      owner: tile.owner,
      repo: tile.repo,
      prNumber: tile.prNumber,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(tile.id);
  });

  it("upgrades legacy Git bundle titles with the repository directory", () => {
    const parsed = parseTileRef({
      id: "legacy-random-uuid",
      type: "git-diff",
      name: "Changes",
      hostId: HOST,
      diff: {
        kind: "bundle",
        runningDir: "/worktrees/right-click-context-menu/traycer",
        bundleGroup: "changes",
      },
      view: {
        collapsedFilePaths: [],
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed === null ? null : parsed.name).toBe("traycer · Changes");
  });

  it("rejects unknown tile kinds", () => {
    expect(parseTileRef({ id: "x", type: "mystery", name: "n" })).toBeNull();
    expect(parseTileRef(null)).toBeNull();
  });

  describe("prNumber guard on the persisted pr-detail and pr-diff tiles", () => {
    const detailTile = makePrDetailTile({
      hostId: HOST,
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      name: "acme/widgets#42",
    });
    const diffTile = makePrDiffTile({
      hostId: HOST,
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });

    function withDetailPrNumber(prNumber: unknown): unknown {
      return {
        id: detailTile.id,
        instanceId: detailTile.instanceId,
        type: "pr-detail",
        name: detailTile.name,
        hostId: detailTile.hostId,
        githubHost: detailTile.githubHost,
        owner: detailTile.owner,
        repo: detailTile.repo,
        prNumber,
      };
    }

    function withDiffPrNumber(prNumber: unknown): unknown {
      return {
        id: diffTile.id,
        instanceId: diffTile.instanceId,
        type: "pr-diff",
        name: diffTile.name,
        hostId: diffTile.hostId,
        githubHost: diffTile.githubHost,
        owner: diffTile.owner,
        repo: diffTile.repo,
        prNumber,
        view: { collapsedFilePaths: [] },
      };
    }

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["zero", 0],
      ["negative", -1],
      ["fractional", 1.5],
    ])(
      "rejects a %s prNumber on both the pr-detail and pr-diff schemas",
      (_label, badPrNumber) => {
        expect(parseTileRef(withDetailPrNumber(badPrNumber))).toBeNull();
        expect(parseTileRef(withDiffPrNumber(badPrNumber))).toBeNull();
      },
    );

    it("still accepts a real positive-integer prNumber, unchanged, on both schemas", () => {
      expect(parseTileRef(withDetailPrNumber(42))).toEqual(detailTile);
      expect(parseTileRef(withDiffPrNumber(42))).toEqual(diffTile);
    });

    it("still recomputes the same tile id from a valid prNumber", () => {
      const parsedDetail = parseTileRef(withDetailPrNumber(42));
      const parsedDiff = parseTileRef(withDiffPrNumber(42));
      expect(parsedDetail?.id).toBe(detailTile.id);
      expect(parsedDiff?.id).toBe(diffTile.id);
    });
  });
});

describe("isTileRefRecordBacked", () => {
  it("is true for Y.Doc artifacts and false for renderer-local tiles", () => {
    const chat: EpicArtifactRef = {
      id: "c",
      instanceId: "inst-c",
      type: "chat",
      name: "Chat",
      hostId: HOST,
    };
    const terminal: EpicTerminalRef = {
      id: "t",
      instanceId: "inst-t",
      type: "terminal",
      name: "Terminal",
      titleSource: "manual",
      hostId: HOST,
      cwd: "/repo",
    };
    const gitDiff: GitDiffTileRef = makeGitFileDiffTile({
      hostId: HOST,
      runningDir: "/repo",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: null,
    });
    const prDetail: PrDetailTileRef = makePrDetailTile({
      hostId: HOST,
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      name: "acme/widgets#42",
    });
    expect(isTileRefRecordBacked(chat)).toBe(true);
    expect(isTileRefRecordBacked(terminal)).toBe(false);
    expect(isTileRefRecordBacked(gitDiff)).toBe(false);
    expect(isTileRefRecordBacked(prDetail)).toBe(false);
  });

  it("treats stale unknown persisted tile kinds as not record-backed", () => {
    expect(isTileRefRecordBacked({ type: "workspaces" })).toBe(false);
    expect(isTileRefRecordBacked({ type: null })).toBe(false);
  });
});

describe("parsePrDiffTileViewState / serializePrDiffTileViewState", () => {
  it("ignores a legacy collapsedFilePaths field entirely - even an entry literally spelled like a tagged key", () => {
    // `p:foo` here is a legacy BARE path (a file named "p:foo"), not a tagged
    // key - the codec must not treat it as one just because it looks like it.
    expect(
      parsePrDiffTileViewState({
        collapsedFilePaths: ["p:foo", "src/a.ts"],
      }),
    ).toEqual({ collapsedFileKeys: [] });
  });

  it("round-trips collapsedFileKeys through serialize -> parse", () => {
    const view = { collapsedFileKeys: ["p:src/a.ts", "b:AAA="] };
    expect(
      parsePrDiffTileViewState(serializePrDiffTileViewState(view)),
    ).toEqual(view);
  });
});

describe("prDiffTileSchema persisted state", () => {
  const base = makePrDiffTile({
    hostId: HOST,
    githubHost: "github.com",
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
  });

  it("hydrates a persisted tile whose view carries only legacy collapsedFilePaths with an empty collapsedFileKeys", () => {
    const legacyPersisted = {
      id: base.id,
      instanceId: base.instanceId,
      type: "pr-diff",
      name: base.name,
      hostId: base.hostId,
      githubHost: base.githubHost,
      owner: base.owner,
      repo: base.repo,
      prNumber: base.prNumber,
      view: { collapsedFilePaths: ["src/a.ts"] },
    };
    const parsed = prDiffTileSchema.parse(legacyPersisted);
    expect(parsed).not.toBeNull();
    expect(parsed?.view).toEqual({ collapsedFileKeys: [] });
  });

  it("round-trips a tile carrying tagged collapse keys through serialize -> parse", () => {
    const ref = {
      ...base,
      view: { collapsedFileKeys: ["p:src/a.ts", "b:AAA="] },
    };
    const parsed = prDiffTileSchema.parse(prDiffTileSchema.serialize(ref));
    expect(parsed).toEqual(ref);
  });
});
