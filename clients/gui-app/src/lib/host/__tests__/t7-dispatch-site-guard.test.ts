// Each audited occurrence is pinned by file, count, and surrounding text. Edits that preserve that text while changing behavior require review. Alias re-exports, runtime composition, and escaped spellings are outside the census.
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

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
    exceptionReason:
      "The creation host supplies both the emptiness proof and the discard requester.",
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
        source: "src/components/layout/tabs/tab-strip-controller.tsx",
        evidence: "setEpicPinned(variables,",
      },
    ],
  },
  {
    firstId: 11,
    route: "original-pin-requester",
    exceptionReason: "Undo keeps the peer of the original Pin write.",
    sites: [
      {
        name: "Open-task Pin Undo",
        source: "src/components/layout/tabs/tab-strip-controller.tsx",
        evidence: "setEpicPinned(undo)",
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
    route: "task-session-queue",
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
  {
    firstId: 39,
    route: "tab-requester-exception",
    exceptionReason:
      "Without a live task session, the desktop tab uses its named tab host when present and otherwise follows the window.",
    sites: [
      {
        name: "Desktop tab direct Rename fallback",
        source: "src/components/layout/tabs/use-strip-tab-item.ts",
        evidence: '.request("epic.updateTitle",',
      },
    ],
  },
  {
    firstId: 40,
    route: "window-client-exception",
    exceptionReason:
      "Without a live task session, the phone header uses the window title mutation.",
    sites: [
      {
        name: "Phone header direct Rename fallback",
        source:
          "src/components/epic-canvas/mobile/epic-mobile-header-actions.tsx",
        evidence: "void updateTitle\n        .mutateAsync({",
      },
    ],
  },
  {
    firstId: 41,
    route: "task-session-image-finish",
    sites: [
      {
        name: "Editor image paste abort",
        source: "src/hooks/artifacts/use-artifact-image-paste.ts",
        evidence:
          "(operationId: string) => operations.abort(artifactId, operationId),",
      },
      {
        name: "Session image abort dispatch",
        source: "src/hooks/artifacts/use-artifact-image-operations.ts",
        evidence: "request: { epicId, artifactId, operationId, commit: false }",
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

const t7WriteMethods = [
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
] as const;

const auditedMethods: ReadonlySet<string> = new Set(t7WriteMethods);
const oneOfEach = Object.fromEntries(
  t7WriteMethods.map((method) => [method, 1]),
);
const pinVersionProbe =
  'const version = useHostNegotiatedMethodVersion(client, "epic.setPinned");';
const methodCensus: readonly (readonly [
  path: string,
  classification: string,
  counts: Readonly<Record<string, number>>,
  nonSendingMarkers?: readonly string[],
])[] = [
  [
    "src/stores/epics/open-epic/runtime/epic-write-command-dispatch.ts",
    "Task session queue",
    {
      "epic.renameArtifact": 1,
      "epic.deleteArtifact": 1,
      "epic.reparentArtifact": 1,
      "epic.updateArtifactStatus": 1,
      "epic.updateTitle": 1,
    },
  ],
  [
    "src/hooks/epic/use-epic-collaborator-mutations.ts",
    "Task session Sharing",
    {
      "epic.grantAccess": 1,
      "epic.batchUpdateRoles": 1,
      "epic.revokeCollaborator": 1,
    },
  ],
  [
    "src/hooks/epic/use-epic-node-mutations.ts",
    "Artifact session and queue",
    {
      "epic.createArtifact": 2,
      "epic.deleteArtifact": 1,
      "epic.updateArtifactStatus": 1,
      "epic.renameArtifact": 1,
    },
  ],
  [
    "src/hooks/epic/use-epic-set-pinned-mutation.ts",
    "History row and tab session",
    { "epic.setPinned": 3 },
  ],
  [
    "src/hooks/epic/use-epic-batch-delete-mutation.ts",
    "History routing and named creation host exception",
    { "epic.batchDelete": 8 },
  ],
  [
    "src/hooks/epic/use-epic-title-mutation.ts",
    "Window-client exception",
    { "epic.updateTitle": 1 },
  ],
  [
    "src/hooks/artifacts/use-artifact-image-operations.ts",
    "Task session image operations",
    {
      "epic.prepareArtifactImage": 3,
      "epic.finishArtifactImage": 3,
    },
  ],
  [
    "src/hooks/comments/use-comment-thread-mutations.ts",
    "Task session comment mutations",
    {
      "epic.createCommentThread": 2,
      "epic.replyToCommentThread": 1,
      "epic.editComment": 1,
      "epic.deleteComment": 1,
      "epic.setCommentThreadResolved": 1,
      "epic.deleteCommentThread": 1,
    },
  ],
  [
    "src/components/layout/tabs/use-strip-tab-item.ts",
    "Tab-requester exception",
    { "epic.updateTitle": 1 },
  ],
  [
    "../shared/host-client/host-rpc-routing.ts",
    "Mention: routing policy declarations",
    oneOfEach,
    t7WriteMethods.map((method) => `"${method}": "addressed-peer",`),
  ],
  [
    "src/components/comments/anchored-draft-popover.tsx",
    "Mention: reads negotiated version",
    { "epic.createCommentThread": 1 },
    ['readNegotiatedMethodVersion(hostId, "epic.createCommentThread")'],
  ],
  [
    "src/hooks/epic/use-epic-pin-local-home-support.ts",
    "Mention: reads negotiated version",
    { "epic.setPinned": 1 },
    [pinVersionProbe],
  ],
  [
    "src/hooks/comments/use-frame-comments-enabled.ts",
    "Mention: reads negotiated version",
    { "epic.createCommentThread": 1 },
    [
      'useHostNegotiatedMethodVersion(\n    client,\n    "epic.createCommentThread",\n  )',
    ],
  ],
  [
    "src/components/epic-canvas/sidebar/epic-sidebar.tsx",
    "Mention: names methods for failure labels",
    { "epic.deleteArtifact": 2 },
    [
      '): "epic.deleteArtifact" | "epic.deleteChat" | "epic.deleteTuiAgent" {',
      'case "artifact":\n      return "epic.deleteArtifact";',
    ],
  ],
  [
    "src/lib/host-rpc-policy/host-method-policy-table.ts",
    "Mention: scheduling policy declarations",
    oneOfEach,
    t7WriteMethods.map((method) => `"${method}": {`),
  ],
  [
    "src/lib/query-keys/epic-mutation-keys.ts",
    "Mention: names mutation-cache keys",
    {
      "epic.batchDelete": 1,
      "epic.setPinned": 1,
      "epic.prepareArtifactImage": 1,
      "epic.finishArtifactImage": 1,
      "epic.deleteArtifact": 1,
    },
    [
      'batchDelete: () => ["epic.batchDelete"] as const,',
      'setPinned: () => ["epic.setPinned"] as const,',
      'prepareArtifactImage: () => ["epic.prepareArtifactImage"] as const,',
      'finishArtifactImage: () => ["epic.finishArtifactImage"] as const,',
      'deleteArtifact: () => ["epic.deleteArtifact"] as const,',
    ],
  ],
];

function readProductionSourceFiles(clientsRoot: string): SourceFile[] {
  // Protocol definitions live outside clients/. Omit tests, their fixtures,
  // and generated output so only production client sources enter the census.
  return globSync("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", {
    cwd: clientsRoot,
    exclude: [
      "**/__tests__",
      "**/browser-tests",
      "**/test-support",
      "**/test-fixtures",
      "**/fixtures",
      "**/*.test.*",
      "**/*.spec.*",
      "**/node_modules",
      "**/dist",
      "**/coverage",
    ],
  }).map((file) => {
    const absolutePath = join(clientsRoot, file);
    return {
      path: relative(join(clientsRoot, "gui-app"), absolutePath).replaceAll(
        "\\",
        "/",
      ),
      contents: readFileSync(absolutePath, "utf8"),
    };
  });
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

const expectedMarkers = new Set<string>();
const dispatchMarkers = new Set<string>();
for (const site of [...dispatchSites, ...dispatchExceptions]) {
  const related = "relatedEvidence" in site ? (site.relatedEvidence ?? []) : [];
  for (const marker of [site.evidence, ...related]) {
    expectedMarkers.add(`${site.source}\0${marker}`);
    dispatchMarkers.add(marker);
  }
}
for (const [path, , , markers] of methodCensus) {
  for (const marker of markers ?? []) {
    expectedMarkers.add(`${path}\0${marker}`);
    dispatchMarkers.add(marker);
  }
}

function unclassifiedSourceMarkers(
  files: ReadonlyMap<string, ScannedSource>,
): string[] {
  const actual = new Map<string, number>();
  for (const [file, source] of files) {
    for (const [marker, count] of source.markers)
      actual.set(`${file}\0${marker}`, count);
  }
  return [...new Set([...expectedMarkers, ...actual.keys()])]
    .filter(
      (key) => (expectedMarkers.has(key) ? 1 : 0) !== (actual.get(key) ?? 0),
    )
    .map((key) => {
      const [source, evidence] = key.split("\0");
      const expectedCount = expectedMarkers.has(key) ? 1 : 0;
      return `${source}: ${JSON.stringify(evidence)} (expected ${expectedCount}, found ${actual.get(key) ?? 0})`;
    })
    .sort();
}

function assertCompleteSourceCensus(
  files: ReadonlyMap<string, ScannedSource>,
): void {
  const differences = unclassifiedSourceMarkers(files);
  if (differences.length > 0) {
    throw new Error(
      `Unclassified T7 dispatch source markers:\n${differences.join("\n")}`,
    );
  }
  const mentions = unclassifiedMethodMentions(files);
  if (mentions.length > 0) {
    throw new Error(`Unclassified T7 method mentions:\n${mentions.join("\n")}`);
  }
}

function namedLocalExports(ast: ts.SourceFile): ReadonlySet<string> {
  const namedExports = new Set<string>();
  for (const statement of ast.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier !== undefined
    )
      continue;
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        namedExports.add((element.propertyName ?? element.name).text);
      }
    }
  }
  return namedExports;
}

function collectExportedMethods(
  ast: ts.SourceFile,
  methods: Map<string, string>,
): void {
  const namedExports = namedLocalExports(ast);
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported =
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) === true;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (!exported && !namedExports.has(declaration.name.text)) continue;
      let value = declaration.initializer;
      while (
        value !== undefined &&
        (ts.isAsExpression(value) ||
          ts.isSatisfiesExpression(value) ||
          ts.isParenthesizedExpression(value))
      ) {
        value = value.expression;
      }
      if (
        value !== undefined &&
        ts.isStringLiteralLike(value) &&
        auditedMethods.has(value.text)
      ) {
        methods.set(declaration.name.text, value.text);
      }
    }
  }
}

function methodReferences(
  ast: ts.SourceFile,
  exported: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const aliases = new Map(exported);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const { propertyName, name } of bindings.elements) {
      if (propertyName === undefined) continue;
      const method = exported.get(propertyName.text);
      if (method !== undefined) aliases.set(name.text, method);
    }
  }
  return aliases;
}

interface ScannedSource {
  readonly contents: string;
  readonly markers: ReadonlyMap<string, number>;
  readonly methods: ReadonlyMap<string, number>;
}

function parseSource(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.contents,
    ts.ScriptTarget.Latest,
    true,
  );
}

function scanSource(
  file: SourceFile,
  parsed: ts.SourceFile | undefined,
  exported: ReadonlyMap<string, string>,
): ScannedSource {
  const markers = new Map<string, number>();
  for (const marker of dispatchMarkers) {
    const count = markerCounts(file.contents, marker);
    if (count > 0) markers.set(marker, count);
  }
  const methods = new Map<string, number>();
  const needsAst =
    /["'`]epic\./.test(file.contents) ||
    [...exported.keys()].some((name) => file.contents.includes(name));
  const ast = parsed ?? (needsAst ? parseSource(file) : null);
  if (ast !== null) countMethods(ast, methodReferences(ast, exported), methods);
  return { contents: file.contents, markers, methods };
}

function countMethods(
  ast: ts.SourceFile,
  references: ReadonlyMap<string, string>,
  methods: Map<string, number>,
): void {
  const visit = (node: ts.Node): void => {
    const parent = node.parent;
    let method: string | undefined;
    if (ts.isStringLiteralLike(node)) {
      method = node.text;
    } else if (
      ts.isIdentifier(node) &&
      !ts.isImportSpecifier(parent) &&
      (!ts.isVariableDeclaration(parent) || parent.name !== node)
    ) {
      method = references.get(node.text);
    }
    if (method !== undefined && auditedMethods.has(method)) {
      methods.set(method, (methods.get(method) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

interface SourceInventory {
  readonly sources: ReadonlyMap<string, ScannedSource>;
  readonly exported: ReadonlyMap<string, string>;
}

function buildInventory(files: readonly SourceFile[]): SourceInventory {
  const parsed = new Map<string, ts.SourceFile>();
  const exported = new Map<string, string>();
  for (const file of files) {
    if (!/["'`]epic\./.test(file.contents)) continue;
    const ast = parseSource(file);
    parsed.set(file.path, ast);
    collectExportedMethods(ast, exported);
  }
  const sources = new Map(
    files.map((file) => [
      file.path,
      scanSource(file, parsed.get(file.path), exported),
    ]),
  );
  return { sources, exported };
}

function injectSource(
  inventory: SourceInventory,
  file: SourceFile,
): ReadonlyMap<string, ScannedSource> {
  const sources = new Map(inventory.sources);
  sources.set(file.path, scanSource(file, undefined, inventory.exported));
  return sources;
}

function unclassifiedMethodMentions(
  files: ReadonlyMap<string, ScannedSource>,
): string[] {
  const actual = new Map<string, number>();
  for (const [file, source] of files) {
    for (const [method, count] of source.methods)
      actual.set(`${file}\0${method}`, count);
  }

  const expected = new Map<string, number>();
  for (const [file, , counts] of methodCensus) {
    for (const [method, count] of Object.entries(counts)) {
      expected.set(`${file}\0${method}`, count);
    }
  }
  return [...new Set([...expected.keys(), ...actual.keys()])]
    .filter((key) => (expected.get(key) ?? 0) !== (actual.get(key) ?? 0))
    .map((key) => {
      const [file, method] = key.split("\0");
      return `${file}: ${method} (expected ${expected.get(key) ?? 0}, found ${actual.get(key) ?? 0})`;
    })
    .sort();
}

describe("T7 task-write dispatch census", () => {
  let inventory: SourceInventory;
  beforeAll(() => {
    inventory = buildInventory(
      readProductionSourceFiles(resolve(appRoot, "..")),
    );
  });

  it("generates one source-checkable entry for each audited send marker", () => {
    expect(dispatchSites.map((site) => site.id)).toEqual(
      Array.from({ length: 42 }, (_, index) => index + 1),
    );

    for (const site of dispatchSites) {
      const source = inventory.sources.get(site.source)?.contents;
      expect(source, `${site.name} source`).toContain(site.evidence);
      if (
        [
          "window-client-exception",
          "tab-requester-exception",
          "named-creation-host",
          "original-pin-requester",
        ].includes(site.route)
      ) {
        expect(site.exceptionReason, site.name).not.toBeNull();
      }
    }
  });

  it("keeps each audited non-dispatch exception tied to its source and reason", () => {
    for (const exception of dispatchExceptions) {
      const source = inventory.sources.get(exception.source)?.contents;
      expect(source, exception.name).toContain(exception.evidence);
      expect(exception.reason.trim(), exception.name).not.toBe("");
    }
  });

  it("scans production src for every dispatch marker and rejects an unclassified site", () => {
    expect(unclassifiedSourceMarkers(inventory.sources)).toEqual([]);
    expect(unclassifiedMethodMentions(inventory.sources)).toEqual([]);

    const marker = dispatchSites.find(
      (site) => site.name === "Desktop History Pin",
    );
    if (marker === undefined)
      throw new Error("History Pin census marker is missing");
    expect(() =>
      assertCompleteSourceCensus(
        injectSource(inventory, {
          path: "src/__unclassified_dispatch__.tsx",
          contents: marker.evidence,
        }),
      ),
    ).toThrow(/Unclassified T7 dispatch source markers/);
  });

  it.each([
    'client.requestWithOptions("epic.setPinned", params, options);',
    'const method = "epic.setPinned"; client.request(method, params);',
    'useHostMutation({ client, method: "epic.setPinned" });',
  ])(
    "rejects a new method mention regardless of call shape: %s",
    (contents) => {
      expect(() =>
        assertCompleteSourceCensus(
          injectSource(inventory, {
            path: "src/components/new-pin-control.tsx",
            contents,
          }),
        ),
      ).toThrow(/Unclassified T7 method mentions:[\s\S]*new-pin-control/);
    },
  );

  it("rejects another occurrence in an already classified source file", () => {
    const path = "src/components/layout/tabs/use-strip-tab-item.ts";
    const contents = inventory.sources.get(path)?.contents;
    if (contents === undefined) throw new Error("Missing tab strip source");
    expect(() =>
      assertCompleteSourceCensus(
        injectSource(inventory, {
          path,
          contents:
            contents +
            '\nclient.requestWithOptions("epic.updateTitle", params, options);',
        }),
      ),
    ).toThrow(
      /use-strip-tab-item\.ts: epic\.updateTitle \(expected 1, found 2\)/,
    );
  });

  it("rejects an imported method constant used in an unclassified source file", () => {
    expect(() =>
      assertCompleteSourceCensus(
        injectSource(inventory, {
          path: "src/components/new-image-finish.ts",
          contents:
            'import { FINISH_ARTIFACT_IMAGE_METHOD as finish } from "@/hooks/artifacts/use-artifact-image-operations"; client.request(finish, params);',
        }),
      ),
    ).toThrow(
      /new-image-finish\.ts: epic\.finishArtifactImage \(expected 0, found 1\)/,
    );
  });

  it("rejects moving a negotiated version probe into a mutation method field", () => {
    const path = "src/hooks/epic/use-epic-pin-local-home-support.ts";
    const contents = inventory.sources.get(path)?.contents;
    if (contents === undefined)
      throw new Error("Missing local-home pin source");
    const sources = injectSource(inventory, {
      path,
      contents: contents.replace(
        pinVersionProbe,
        'const mutation = useHostMutation({ client, method: "epic.setPinned" });',
      ),
    });
    expect(unclassifiedMethodMentions(sources)).toEqual([]);
    expect(() => assertCompleteSourceCensus(sources)).toThrow(
      /Unclassified T7 dispatch source markers:[\s\S]*use-epic-pin-local-home-support\.ts:.*\(expected 1, found 0\)/,
    );
  });

  it("discovers audited methods in other clients on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "t7-dispatch-"));
    try {
      const outsideApp = join(root, "desktop", "src");
      mkdirSync(outsideApp, { recursive: true });
      writeFileSync(
        join(outsideApp, "new-pin.ts"),
        'const method = "epic.setPinned";',
      );
      const files = readProductionSourceFiles(root);
      expect(files).toHaveLength(1);
      const [file] = files;
      expect(() =>
        assertCompleteSourceCensus(injectSource(inventory, file)),
      ).toThrow(
        /Unclassified T7 method mentions:[\s\S]*\.\.\/desktop\/src\/new-pin\.ts: epic\.setPinned \(expected 0, found 1\)/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        "original-pin-requester",
        "tab-requester-exception",
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
