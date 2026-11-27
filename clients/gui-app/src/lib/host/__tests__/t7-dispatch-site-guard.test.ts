import { globSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type DispatchSite = {
  readonly id: number;
  readonly name: string;
  readonly source: string;
  readonly evidence: string;
  readonly relatedEvidence?: ReadonlyArray<string>;
  readonly route: string;
  readonly exceptionReason: string | null;
};

type SourceFile = { readonly path: string; readonly contents: string };
const appRoot = resolve(import.meta.dirname, "../../../../");

const censusRows: ReadonlyArray<{
  readonly firstId: number;
  readonly route: string;
  readonly exceptionReason?: string;
  readonly sites: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly evidence: string;
    readonly relatedEvidence?: ReadonlyArray<string>;
  }>;
}> = [
  {
    firstId: 1,
    route: "history-row-peer",
    sites: [
      {
        name: "Desktop History Pin",
        source: "src/components/epics/epics-list-panel.tsx",
        evidence: "historyRowPeerId(hostId, servingPeerId, row, false)",
      },
      {
        name: "Phone History Pin",
        source: "src/components/epics/mobile/mobile-history-row.tsx",
        evidence: "args.onSetPinned(item.epicId, !item.isPinned)",
      },
    ],
  },
  {
    firstId: 3,
    route: "current-tasks-row-evidence",
    sites: [
      {
        name: "Home Current Tasks Pin",
        source: "src/components/home/current-tasks-section.tsx",
        evidence:
          "historyRowPeerId(listPeerId, peerId, historyRowEvidence(item), false)",
      },
    ],
  },
  {
    firstId: 4,
    route: "accepted-history-rows",
    sites: [
      {
        name: "Desktop History row Delete",
        source: "src/components/epics/epics-list-panel.tsx",
        evidence:
          "historyRowPeerId(listPeerId, peerId, pendingRows.get(id), false)",
        relatedEvidence: ["const deleteMutation = useEpicBatchDelete()"],
      },
      {
        name: "Desktop History bulk Delete",
        source: "src/components/epics/epics-list-panel.tsx",
        evidence: "acceptedRows: pendingRows",
      },
      {
        name: "Phone History row Delete",
        source: "src/components/epics/mobile/mobile-history-row.tsx",
        evidence: "args.onRequestDelete([item.epicId])",
      },
    ],
  },
  {
    firstId: 7,
    route: "computer-worktree-census-and-cleanup",
    sites: [
      {
        name: "Worktree census",
        source: "src/components/epics/epics-list-panel.tsx",
        evidence:
          "useTaskDeleteWorktreeCandidates(worktreeDeleteIds, worktreeHostId)",
      },
      {
        name: "Post-delete worktree cleanup",
        source: "src/lib/epics/run-worktree-cleanup.ts",
        evidence: "export async function runWorktreeCleanup(",
      },
    ],
  },
  {
    firstId: 9,
    route: "named-creation-host",
    sites: [
      {
        name: "Landing Send empty-task discard",
        source: "src/components/home/hooks/use-landing-composer-actions.ts",
        evidence: "discardCreatedIfEmpty({ epicId, hostId })",
      },
    ],
  },
  {
    firstId: 10,
    route: "task-session-peer",
    sites: [
      {
        name: "Open-task Pin",
        source: "src/components/layout/tabs/tab-strip-context-menu.tsx",
        evidence: "const reading = usePoolTaskPinReading(props.tab.epicId);",
      },
      {
        name: "Open-task Pin Undo",
        source: "src/components/layout/tabs/tab-strip-controller.tsx",
        evidence: "setEpicPinned(variables,",
      },
    ],
  },
  {
    firstId: 12,
    route: "window-client-exception",
    exceptionReason:
      "History title edits intentionally use the window client; the row peer helper governs Pin and Delete only.",
    sites: [
      {
        name: "Desktop History Rename",
        source: "src/components/epics/epics-list-panel.tsx",
        evidence: "renameEpicTitle({",
      },
      {
        name: "Phone History Rename",
        source: "src/components/epics/mobile/mobile-history-row.tsx",
        evidence: "renameEpicTitle({",
      },
    ],
  },
  {
    firstId: 14,
    route: "task-session-queue-with-window-fallback",
    exceptionReason:
      "A live task write queue uses its session requester; the declared fallback uses the window title hook.",
    sites: [
      {
        name: "Desktop tab Rename",
        source: "src/components/layout/tabs/use-strip-tab-item.ts",
        evidence: "enqueueWriteCommand({",
      },
      {
        name: "Phone header Rename",
        source:
          "src/components/epic-canvas/mobile/epic-mobile-header-actions.tsx",
        evidence: "enqueueWriteCommand({",
      },
    ],
  },
  {
    firstId: 16,
    route: "task-session-sharing-client",
    sites: [
      {
        name: "Desktop Sharing",
        source:
          "src/components/epic-canvas/panels/epic-sharing/use-controller.ts",
        evidence: "grantAccess.mutate(",
      },
      {
        name: "Phone Sharing",
        source: "src/components/epic-canvas/mobile/switcher-panel-embed.tsx",
        evidence: "<SharingPanel epicId={epicId} />",
      },
    ],
  },
  {
    firstId: 18,
    route: "task-session-comment-client",
    sites: [
      {
        name: "Desktop sidebar thread actions",
        source: "src/components/epic-canvas/sidebar/epic-sidebar.tsx",
        evidence: "<CommentSidebarPanel\n",
      },
      {
        name: "Phone switcher thread actions",
        source: "src/components/epic-canvas/mobile/switcher-comments-list.tsx",
        evidence:
          "<CommentSidebarPanel epicId={epicId} activeArtifactId={artifactId} />",
      },
    ],
  },
  {
    firstId: 20,
    route: "task-session-comment-creation",
    sites: [
      {
        name: "Rich-document selection thread creation",
        source: "src/components/epic-canvas/renderers/collab-tile-body.tsx",
        evidence: "<FloatingDraftPopover\n                epicId={epicId}",
      },
      {
        name: "Canvas anchored thread creation",
        source: "src/components/canvas-artifact/canvas-selection-provider.tsx",
        evidence:
          "renderCommentDraft: () =>\n        props.viewOnly === true ? null : (\n          <AnchoredDraftPopover",
      },
    ],
  },
  {
    firstId: 22,
    route: "task-session-artifact-create",
    sites: [
      {
        name: "Desktop root artifact create",
        source: "src/components/epic-canvas/sidebar/epic-sidebar.tsx",
        evidence: "const createArtifact = useEpicCreateArtifact();",
      },
      {
        name: "Nested tree artifact create",
        source:
          "src/components/epic-canvas/sidebar/epic-sidebar-artifact-tree.tsx",
        evidence: "const createArtifact = useEpicCreateArtifact();",
      },
      {
        name: "Phone switcher artifact create",
        source:
          "src/components/epic-canvas/mobile/use-switcher-create-artifact.ts",
        evidence: "const createArtifact = useEpicCreateArtifact();",
      },
    ],
  },
  {
    firstId: 25,
    route: "task-session-queue",
    sites: [
      {
        name: "Tree artifact Rename",
        source:
          "src/components/epic-canvas/sidebar/epic-sidebar-artifact-tree.tsx",
        evidence: "useEpicRenameArtifact(nodeId, true)",
      },
      {
        name: "Canvas tab Rename",
        source: "src/components/epic-canvas/canvas/use-rename-canvas-tab.ts",
        evidence: "useEpicRenameArtifact(null, true)",
      },
      {
        name: "Phone switcher Rename",
        source: "src/components/epic-canvas/mobile/use-switcher-rename.ts",
        evidence: "renameArtifact.mutate(",
        relatedEvidence: ["useEpicRenameArtifact(null, true)"],
      },
      {
        name: "Automatic document heading follow Rename",
        source:
          "src/components/epic-canvas/renderers/use-artifact-doc-title-follow.ts",
        evidence: "persistRename({ epicId, artifactId, title })",
      },
    ],
  },
  {
    firstId: 29,
    route: "task-session-reparent",
    sites: [
      {
        name: "Root/sidebar drag reparent",
        source: "src/components/epic-canvas/dnd/root-dnd-commits.ts",
        evidence: ".reparentArtifact(input.sourceNodeId, input.newParentId);",
        relatedEvidence: ["enqueueWriteCommand({"],
      },
    ],
  },
  {
    firstId: 30,
    route: "task-session-queue",
    sites: [
      {
        name: "Story status control",
        source: "src/components/epic-canvas/renderers/story-tile.tsx",
        evidence: "updateStatus.mutate({",
      },
      {
        name: "Ticket status control",
        source: "src/components/epic-canvas/renderers/ticket-tile.tsx",
        evidence: "updateStatus.mutate({",
      },
    ],
  },
  {
    firstId: 32,
    route: "task-session-queue-confirmed-delete",
    sites: [
      {
        name: "Tree artifact Delete",
        source:
          "src/components/epic-canvas/sidebar/epic-sidebar-artifact-tree.tsx",
        evidence: "deleteArtifact.mutate(",
      },
      {
        name: "Sidebar batch artifact Delete",
        source: "src/components/epic-canvas/sidebar/epic-sidebar.tsx",
        evidence: "deleteArtifact.mutateAsync({",
      },
      {
        name: "Phone switcher artifact Delete",
        source: "src/components/epic-canvas/mobile/switcher-row-actions.tsx",
        evidence: "deleteArtifact.mutate(",
      },
    ],
  },
  {
    firstId: 35,
    route: "task-session-image-finish",
    sites: [
      {
        name: "Editor image paste",
        source: "src/hooks/artifacts/use-artifact-image-paste.ts",
        evidence: "operations.commit",
        relatedEvidence: ["operations.prepareBytes"],
      },
    ],
  },
  {
    firstId: 36,
    route: "task-session-stream",
    sites: [
      {
        name: "Document stream update",
        source: "../shared/host-transport/artifact-stream-client.ts",
        evidence:
          "applyUpdate(docGuid: string, updateBytes: Uint8Array): void {",
      },
      {
        name: "Canvas stream update",
        source: "../shared/host-transport/artifact-stream-client.ts",
        evidence:
          "applyUpdate(docGuid: string, updateBytes: Uint8Array): void {",
      },
    ],
  },
  {
    firstId: 38,
    route: "task-session-queue",
    sites: [
      {
        name: "Epic sidebar column Rename",
        source: "src/components/epic-canvas/sidebar/epic-sidebar-column.tsx",
        evidence: "enqueueWriteCommand({",
      },
    ],
  },
];

const dispatchSites: readonly DispatchSite[] = censusRows.flatMap((row) =>
  row.sites.map((site, index) => ({
    ...site,
    id: row.firstId + index,
    route: row.route,
    exceptionReason: row.exceptionReason ?? null,
  })),
);

const dispatchExceptions = [
  {
    name: "History navigation from the mobile drawer",
    source: "src/components/layout/shell/mobile-nav-drawer.tsx",
    evidence: "openEpicFromList(navigate, item.epicId",
    reason: "This opens a History route and dispatches no write RPC.",
  },
  {
    name: "Unmounted AddImageToArtifactButton",
    source: "src/components/artifacts/add-image-to-artifact-button.tsx",
    evidence: "operations.prepareBytes",
    reason:
      "The component has no production mount at this head, so it is not a live dispatch site.",
  },
  {
    name: "Unmounted AddImageToArtifactButton commit",
    source: "src/components/artifacts/add-image-to-artifact-button.tsx",
    evidence: "operations.commit",
    reason:
      "The component has no production mount at this head, so its image finish is not a live dispatch site.",
  },
] as const;

const directRpcCallSites = [
  {
    source: "src/components/layout/tabs/use-strip-tab-item.ts",
    method: "epic.updateTitle",
    siteName: "Desktop tab title fallback",
  },
] as const;

const t7WriteMethods = new Set([
  "epic.batchDelete",
  "epic.batchUpdateRoles",
  "epic.createArtifact",
  "epic.createCommentThread",
  "epic.deleteArtifact",
  "epic.deleteComment",
  "epic.deleteCommentThread",
  "epic.editComment",
  "epic.finishArtifactImage",
  "epic.grantAccess",
  "epic.prepareArtifactImage",
  "epic.renameArtifact",
  "epic.reparentArtifact",
  "epic.replyToCommentThread",
  "epic.revokeCollaborator",
  "epic.setCommentThreadResolved",
  "epic.setPinned",
  "epic.updateArtifactStatus",
  "epic.updateTitle",
]);

function readProductionSourceFiles(): SourceFile[] {
  const roots = [resolve(appRoot, "src"), resolve(appRoot, "../shared")];
  const files = roots.flatMap((cwd) =>
    globSync(["**/*.ts", "**/*.tsx"], {
      cwd,
      exclude: ["**/__tests__", "**/test-support", "**/node_modules"],
    }).map((file) => {
      const absolutePath = join(cwd, file);
      return {
        path: relative(appRoot, absolutePath).replaceAll("\\", "/"),
        contents: readFileSync(absolutePath, "utf8"),
      };
    }),
  );
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function markerCounts(source: string, marker: string): number {
  let count = 0;
  for (
    let foundAt = source.indexOf(marker);
    foundAt !== -1;
    foundAt = source.indexOf(marker, foundAt + marker.length)
  ) {
    count += 1;
  }
  return count;
}

function unclassifiedSourceMarkers(
  files: readonly SourceFile[],
  sites: readonly {
    readonly source: string;
    readonly evidence: string;
    readonly relatedEvidence?: ReadonlyArray<string>;
  }[],
  exceptions: readonly {
    readonly source: string;
    readonly evidence: string;
    readonly relatedEvidence?: ReadonlyArray<string>;
  }[],
): string[] {
  const expected = new Set<string>();
  for (const { source, evidence, relatedEvidence } of [
    ...sites,
    ...exceptions,
  ]) {
    expected.add(`${source}\0${evidence}`);
    for (const related of relatedEvidence ?? []) {
      expected.add(`${source}\0${related}`);
    }
  }

  const actual = new Map<string, number>();
  const markers = new Set(
    [...sites, ...exceptions].flatMap((entry) => [
      entry.evidence,
      ...(entry.relatedEvidence ?? []),
    ]),
  );
  for (const file of files) {
    for (const marker of markers) {
      const count = markerCounts(file.contents, marker);
      if (count > 0) actual.set(`${file.path}\0${marker}`, count);
    }
  }

  const differences = new Set([...expected, ...actual.keys()]);
  return [...differences]
    .filter((key) => {
      const expectedCount = expected.has(key) ? 1 : 0;
      return expectedCount !== (actual.get(key) ?? 0);
    })
    .map((key) => {
      const [source, evidence] = key.split("\0");
      const expectedCount = expected.has(key) ? 1 : 0;
      return `${source}: ${JSON.stringify(evidence)} (expected ${expectedCount}, found ${actual.get(key) ?? 0})`;
    })
    .sort();
}

function assertCompleteSourceCensus(files: readonly SourceFile[]): void {
  const differences = unclassifiedSourceMarkers(
    files,
    dispatchSites,
    dispatchExceptions,
  );
  if (differences.length > 0) {
    throw new Error(
      `Unclassified T7 dispatch source markers:\n${differences.join("\n")}`,
    );
  }
  const directRpcCalls = unclassifiedDirectRpcCalls(files);
  if (directRpcCalls.length > 0) {
    throw new Error(
      `Unclassified direct T7 RPC calls:\n${directRpcCalls.join("\n")}`,
    );
  }
}

function unclassifiedDirectRpcCalls(files: readonly SourceFile[]): string[] {
  const expected = new Map<string, number>();
  for (const call of directRpcCallSites) {
    const key = `${call.source}\0${call.method}`;
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }

  const actual = new Map<string, number>();
  const requestPattern =
    /\.(?:request|requestWithResponseTimeout)\s*\(\s*(["'])(epic\.[A-Za-z0-9]+)\1/g;
  for (const file of files) {
    for (const match of file.contents.matchAll(requestPattern)) {
      const method = match[2];
      if (!t7WriteMethods.has(method)) continue;
      const key = `${file.path}\0${method}`;
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }
  }

  const keys = new Set([...expected.keys(), ...actual.keys()]);
  return [...keys]
    .filter((key) => (expected.get(key) ?? 0) !== (actual.get(key) ?? 0))
    .map((key) => {
      const [source, method] = key.split("\0");
      return `${source}: ${method} (expected ${expected.get(key) ?? 0}, found ${actual.get(key) ?? 0})`;
    })
    .sort();
}

describe("T7 task-write dispatch census", () => {
  it("generates one source-checkable entry for each of the 37 sites and sidebar rename", () => {
    expect(dispatchSites.map((site) => site.id)).toEqual(
      Array.from({ length: 38 }, (_, index) => index + 1),
    );

    for (const site of dispatchSites) {
      const source = readFileSync(resolve(appRoot, site.source), "utf8");
      expect(source, `${site.name} source`).toContain(site.evidence);
      if (site.route === "window-client-exception") {
        expect(site.exceptionReason, site.name).not.toBeNull();
      }
    }
  });

  it("keeps each audited non-dispatch exception tied to its source and reason", () => {
    for (const exception of dispatchExceptions) {
      const source = readFileSync(resolve(appRoot, exception.source), "utf8");
      expect(source, exception.name).toContain(exception.evidence);
      expect(exception.reason.trim(), exception.name).not.toBe("");
    }
  });

  it("scans production src for every dispatch marker and rejects an unclassified site", () => {
    const files = readProductionSourceFiles();
    expect(
      unclassifiedSourceMarkers(files, dispatchSites, dispatchExceptions),
    ).toEqual([]);
    expect(unclassifiedDirectRpcCalls(files)).toEqual([]);

    const marker = dispatchSites.find(
      (site) => site.name === "Desktop History Pin",
    );
    if (marker === undefined)
      throw new Error("History Pin census marker is missing");
    expect(() =>
      assertCompleteSourceCensus([
        ...files,
        {
          path: "src/__unclassified_dispatch__.tsx",
          contents: marker.evidence,
        },
      ]),
    ).toThrow(/Unclassified T7 dispatch source markers/);
  });

  it("rejects a new direct RPC call even when it uses an audited method", () => {
    const files = readProductionSourceFiles();
    expect(() =>
      assertCompleteSourceCensus([
        ...files,
        {
          path: "src/components/new-pin-control.tsx",
          contents:
            'client.request("epic.setPinned", { epicId, pinned: true });',
        },
      ]),
    ).toThrow(/Unclassified direct T7 RPC calls/);
  });

  it("keeps queue, stream, row-peer and named-host routes represented", () => {
    const routes = new Set(dispatchSites.map((site) => site.route));
    expect(routes).toEqual(
      new Set([
        "history-row-peer",
        "current-tasks-row-evidence",
        "accepted-history-rows",
        "computer-worktree-census-and-cleanup",
        "named-creation-host",
        "task-session-peer",
        "window-client-exception",
        "task-session-queue-with-window-fallback",
        "task-session-sharing-client",
        "task-session-comment-client",
        "task-session-comment-creation",
        "task-session-artifact-create",
        "task-session-queue",
        "task-session-reparent",
        "task-session-queue-confirmed-delete",
        "task-session-image-finish",
        "task-session-stream",
      ]),
    );
  });
});
