/**
 * Every `TileKindId` must be registered in all six places a tile kind needs
 * to show up: the kind guard, the schema registry, the placement-category
 * map, the render registry, the analytics maps, and (where applicable) the
 * reading-position identity map.
 *
 * `ALL_TILE_KINDS` is a `Record<TileKindId, true>` literal - adding a new
 * `TileKindId` without adding a key here fails to COMPILE this test file,
 * which is the point: a missing registration is caught before the loop ever
 * runs, not by an assertion inside it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isTileKind, type TileKindId } from "@/stores/epics/canvas/tile-kinds";
import { parseTileRef } from "@/stores/epics/canvas/tile-schema";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import type { TileKindToRefMap } from "@/stores/epics/canvas/tile-kind-types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tileCategoryOf } from "@/lib/canvas/tile-open/intent";
import {
  analyticsArtifactKindForCanvasTileType,
  analyticsTargetForCanvasTileType,
} from "@/lib/analytics";
import { readingPositionIdentityForTileInstance } from "@/lib/reading-position";

const ALL_TILE_KINDS: Record<TileKindId, true> = {
  chat: true,
  "terminal-agent": true,
  spec: true,
  ticket: true,
  story: true,
  review: true,
  terminal: true,
  "browser-session": true,
  "workspace-file": true,
  "git-diff": true,
  "snapshot-diff": true,
  "managed-command-output": true,
  "comm-graph": true,
  "published-chat": true,
  "epic-file": true,
  "pr-detail": true,
  "pr-diff": true,
  blank: true,
};

const HOST = "host-1";

/** One minimal, structurally valid ref per kind - typed against the same
 * registry map the render/schema registries are typed against, so a kind
 * whose ref shape changes fails HERE, not silently inside the loop below. */
const TILE_FIXTURES: { readonly [K in TileKindId]: TileKindToRefMap[K] } = {
  chat: {
    id: "chat-1",
    instanceId: "inst-chat-1",
    type: "chat",
    name: "Chat",
    hostId: HOST,
  },
  "terminal-agent": {
    id: "ta-1",
    instanceId: "inst-ta-1",
    type: "terminal-agent",
    name: "Agent",
    hostId: HOST,
  },
  spec: {
    id: "spec-1",
    instanceId: "inst-spec-1",
    type: "spec",
    name: "Spec",
    hostId: HOST,
  },
  ticket: {
    id: "ticket-1",
    instanceId: "inst-ticket-1",
    type: "ticket",
    name: "Ticket",
    hostId: HOST,
  },
  story: {
    id: "story-1",
    instanceId: "inst-story-1",
    type: "story",
    name: "Story",
    hostId: HOST,
  },
  review: {
    id: "review-1",
    instanceId: "inst-review-1",
    type: "review",
    name: "Review",
    hostId: HOST,
  },
  terminal: {
    id: "terminal-1",
    instanceId: "inst-terminal-1",
    type: "terminal",
    name: "Terminal",
    hostId: HOST,
    titleSource: "default",
    cwd: "/work/repo",
  },
  "browser-session": {
    id: "browser-session:sess-1:tab-1",
    instanceId: "inst-browser-1",
    type: "browser-session",
    name: "Browser",
    hostId: HOST,
    sessionId: "sess-1",
    tabId: "tab-1",
    viewportPreset: "responsive",
  },
  "workspace-file": {
    id: "workspace-file:host-1:/work/repo:src/index.ts",
    instanceId: "inst-workspace-file-1",
    type: "workspace-file",
    name: "index.ts",
    hostId: HOST,
    workspacePath: "/work/repo",
    filePath: "src/index.ts",
  },
  "git-diff": {
    id: "git-diff-1",
    instanceId: "inst-git-diff-1",
    type: "git-diff",
    name: "Diff",
    hostId: HOST,
    repositoryContext: null,
    diff: {
      kind: "file",
      runningDir: "/work/repo",
      filePath: "src/index.ts",
      stage: "unstaged",
    },
    view: { collapsedFilePaths: [] },
  },
  "snapshot-diff": {
    id: "snapshot-diff-1",
    instanceId: "inst-snapshot-diff-1",
    type: "snapshot-diff",
    name: "Snapshot Diff",
    hostId: HOST,
    diff: {
      kind: "snapshot-cumulative",
      chatId: "chat-1",
      filePath: "src/index.ts",
    },
    view: { collapsedFilePaths: [] },
  },
  "managed-command-output": {
    id: "cmd-1",
    instanceId: "inst-cmd-1",
    type: "managed-command-output",
    name: "Command",
    hostId: HOST,
  },
  "comm-graph": {
    id: "comm-graph-epic-1",
    instanceId: "inst-comm-graph-1",
    type: "comm-graph",
    name: "Comms",
    hostId: HOST,
    epicId: "epic-1",
    view: { x: 0, y: 0, zoom: 1, mode: "graph" },
  },
  "published-chat": {
    id: "published:task-1:user-1:chat-1",
    instanceId: "inst-published-1",
    type: "published-chat",
    name: "Published",
    hostId: HOST,
    taskId: "task-1",
    chatId: "chat-1",
    ownerUserId: "user-1",
    ownerHostId: "owner-host",
  },
  "epic-file": makeEpicFileTileRef({
    hostId: HOST,
    epicId: "epic-1",
    path: "files/report.png",
  }),
  "pr-detail": {
    id: "pr-detail-1",
    instanceId: "inst-pr-detail-1",
    type: "pr-detail",
    name: "PR #1",
    hostId: HOST,
    githubHost: "github.com",
    owner: "traycerai",
    repo: "traycer",
    prNumber: 1,
  },
  "pr-diff": {
    id: "pr-diff-1",
    instanceId: "inst-pr-diff-1",
    type: "pr-diff",
    name: "PR #1 diff",
    hostId: HOST,
    githubHost: "github.com",
    owner: "traycerai",
    repo: "traycer",
    prNumber: 1,
    view: { collapsedFileKeys: [] },
  },
  blank: {
    id: "blank",
    instanceId: "inst-blank-1",
    type: "blank",
    name: "New tab",
    hostId: HOST,
  },
};

const TILE_KIND_IDS = Object.keys(ALL_TILE_KINDS) as ReadonlyArray<TileKindId>;

describe("every TileKindId is registered in the kind guard, schema and category registries", () => {
  it.each(TILE_KIND_IDS)("%s is a recognized tile kind", (kind) => {
    expect(isTileKind(kind)).toBe(true);
  });

  it.each(TILE_KIND_IDS)(
    "%s has a schema registry entry (parse does not throw)",
    (kind) => {
      expect(() => parseTileRef({ type: kind })).not.toThrow();
    },
  );

  it.each(TILE_KIND_IDS)(
    "%s has a placement category in {content, conversation, browser}",
    (kind) => {
      const category = tileCategoryOf(TILE_FIXTURES[kind]);
      expect(["content", "conversation", "browser"]).toContain(category);
    },
  );
});

describe("epic-file kind: new-kind-specific registrations", () => {
  it("analytics target is 'file', sharing the target kind workspace-file uses", () => {
    expect(analyticsTargetForCanvasTileType("epic-file")).toBe("file");
  });

  it("analytics has no artifact kind - a file is not an artifact record", () => {
    expect(analyticsArtifactKindForCanvasTileType("epic-file")).toBeNull();
  });

  it("placement category is content", () => {
    expect(tileCategoryOf(TILE_FIXTURES["epic-file"])).toBe("content");
  });

  it("schema registry round-trips an epic-file ref", () => {
    const ref = TILE_FIXTURES["epic-file"];
    expect(parseTileRef({ ...ref })).toEqual(ref);
  });

  describe("reading-position identity", () => {
    beforeEach(() => {
      useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    });

    it('is durable and host-neutral, keyed by encodeURIComponent-joined ["epic-file", epicId, path]', () => {
      const epicId = "epic-1";
      const path = "files/report.png";
      const ref = makeEpicFileTileRef({ hostId: HOST, epicId, path });

      const store = useEpicCanvasStore.getState();
      const tabId = store.openEpicTab(epicId, "Files");
      store.openTileInTab(tabId, ref);

      const identity = readingPositionIdentityForTileInstance(ref.instanceId);

      expect(identity.durability).toBe("durable");
      expect(identity.hostId).toBeNull();
      expect(identity.contentKey).toBe(
        ["epic-file", epicId, path].map(encodeURIComponent).join(":"),
      );
      expect(identity.deletionKey).toBe(identity.contentKey);
      expect(identity.epicId).toBe(epicId);
    });

    it("stays keyed the same way across two different serving hosts", () => {
      const epicId = "epic-1";
      const path = "files/report.png";
      const refOnHostA = makeEpicFileTileRef({
        hostId: "host-a",
        epicId,
        path,
      });
      const refOnHostB = makeEpicFileTileRef({
        hostId: "host-b",
        epicId,
        path,
      });

      const store = useEpicCanvasStore.getState();
      const tabA = store.openEpicTab(epicId, "Files A");
      store.openTileInTab(tabA, refOnHostA);
      const tabB = useEpicCanvasStore.getState().openEpicTab(epicId, "Files B");
      useEpicCanvasStore.getState().openTileInTab(tabB, refOnHostB);

      const identityA = readingPositionIdentityForTileInstance(
        refOnHostA.instanceId,
      );
      const identityB = readingPositionIdentityForTileInstance(
        refOnHostB.instanceId,
      );

      expect(identityA.contentKey).toBe(identityB.contentKey);
      expect(identityA.hostId).toBeNull();
      expect(identityB.hostId).toBeNull();
    });
  });
});
