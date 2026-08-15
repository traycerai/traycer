import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTwoFilesPatch } from "diff";
import type { EditorOptions } from "@pierre/diffs/edit";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type GitChangedFile,
  type GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { FileDiffContent } from "@/components/epic-canvas/git-diff/file-diff-content";
import { useGitDiffEditing } from "@/components/epic-canvas/git-diff/git-diff-editing";
import { DiffWorkerPoolProvider } from "@/components/diff-worker-pool-provider";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { DEFAULT_THEME_PRESET } from "@/lib/theme-presets";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";

const FILE_NAME = "src/wrapped-lines.ts";
const RUNNING_DIR = "/work/repo";
const OLD_CONTENT = createFileContents(false);
const NEW_CONTENT = createFileContents(true);
const PATCH = createTwoFilesPatch(
  FILE_NAME,
  FILE_NAME,
  OLD_CONTENT,
  NEW_CONTENT,
  "",
  "",
  { context: 80 },
);
const DIFF: GitGetFileDiffResponse = {
  filePath: FILE_NAME,
  headSha: "head",
  stagedOid: "staged",
  worktreeOid: "worktree",
  patch: PATCH,
  isTruncated: false,
  truncatedAfterBytes: null,
  isBinary: false,
};
const FILE: GitChangedFile = {
  path: FILE_NAME,
  previousPath: null,
  status: "modified",
  stage: "unstaged",
  insertions: 1,
  deletions: 1,
  isBinary: false,
  sizeBytes: NEW_CONTENT.length,
  stagedOid: "staged",
  worktreeOid: "worktree",
};

function createFileContents(changed: boolean): string {
  return Array.from({ length: 80 }, (_, index) => {
    const lineNumber = index + 1;
    if (lineNumber === 24) {
      return changed
        ? "const editedValue = 'new value';"
        : "const editedValue = 'old value';";
    }
    if (lineNumber >= 16 && lineNumber <= 23) {
      return `const wrappedValue${lineNumber} = '${"wrapped segment ".repeat(12)}';`;
    }
    return `const value${lineNumber} = ${lineNumber};`;
  }).join("\n");
}

const harness = {
  version: 0,
  comparisonIdentity: "cmp-1",
  worktreeContent: NEW_CONTENT,
  contentsSettledCount: 0,
  writeCount: 0,
  listeners: new Set<() => void>(),
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  },
  notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  },
};

let requestSeq = 0;
const queryClient = createAppQueryClient();
const hostClient = new HostClient({
  registry: hostRpcRegistry,
  invalidator: createHostQueryInvalidator(queryClient),
  messenger: new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => `diff-edit-browser-${++requestSeq}`,
    handlers: {
      "git.getFileContents": async () => {
        const response = {
          runningDir: RUNNING_DIR,
          filePath: FILE_NAME,
          oldFile: { name: FILE_NAME, contents: OLD_CONTENT },
          newFile: { name: FILE_NAME, contents: harness.worktreeContent },
          worktreeFile: { name: FILE_NAME, contents: harness.worktreeContent },
          error: null,
        };
        await Promise.resolve();
        harness.contentsSettledCount += 1;
        harness.notify();
        return response;
      },
      "workspace.writeFile": (params) => {
        harness.worktreeContent = params.content;
        harness.comparisonIdentity = "cmp-2";
        harness.writeCount += 1;
        harness.notify();
        return {
          status: "saved" as const,
          workspacePath: params.workspacePath,
          filePath: params.filePath,
          revision: `rev-${harness.writeCount}`,
        };
      },
    },
  }),
});
hostClient.bind(mockLocalHostEntry);
hostClient.setRequestContext(
  createRendererContextFixture({ bearerToken: "token" }),
);
recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
  "git.getFileContents",
  "workspace.writeFile",
]);

export function DiffEditFocusFixture() {
  const harnessVersion = useSyncExternalStore(
    (listener) => harness.subscribe(listener),
    () => harness.version,
  );
  void harnessVersion;
  const testStateRef = useRef<HTMLOutputElement | null>(null);
  const changeCountRef = useRef(0);
  const blurCountRef = useRef(0);
  const attachCountRef = useRef(0);
  const writeTestState = (): void => {
    const state = testStateRef.current;
    if (state === null) return;
    state.setAttribute("data-change-count", String(changeCountRef.current));
    state.setAttribute("data-blur-count", String(blurCountRef.current));
    state.setAttribute("data-attach-count", String(attachCountRef.current));
    state.setAttribute(
      "data-contents-settled-count",
      String(harness.contentsSettledCount),
    );
    state.setAttribute("data-write-count", String(harness.writeCount));
    state.setAttribute("data-comparison-identity", harness.comparisonIdentity);
  };
  const editing = useGitDiffEditing({
    client: hostClient,
    hostId: mockLocalHostEntry.hostId,
    runningDir: RUNNING_DIR,
    file: FILE,
    surfaceId: "diff-edit-browser-regression",
    isActive: true,
    interactionEnabled: true,
    currentDiff: DIFF,
    currentComparisonIdentity: harness.comparisonIdentity,
    resumeDetachedDraft: false,
  });
  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      ...editing.editAdapter.editorOptions,
      onAttach: (editor, fileInstance) => {
        attachCountRef.current += 1;
        writeTestState();
        editing.editAdapter.editorOptions.onAttach?.(editor, fileInstance);
      },
      onChange: (file, lineAnnotations, event) => {
        changeCountRef.current += 1;
        writeTestState();
        editing.editAdapter.editorOptions.onChange?.(
          file,
          lineAnnotations,
          event,
        );
      },
      onBlur: () => {
        blurCountRef.current += 1;
        writeTestState();
        editing.editAdapter.editorOptions.onBlur?.();
      },
    }),
    [editing.editAdapter.editorOptions],
  );
  const hookSession = editing.editSession;
  const editSession = useMemo(
    () =>
      hookSession === undefined
        ? undefined
        : {
            editorOptions,
            oldFile: hookSession.oldFile,
            newFile: hookSession.newFile,
          },
    [editorOptions, hookSession],
  );
  useLayoutEffect(() => {
    writeTestState();
    if (harness.contentsSettledCount < 2 || harness.writeCount < 1) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        const host = document.querySelector("diffs-container");
        const editable =
          host?.shadowRoot?.querySelector('[contenteditable="true"]') ?? null;
        const state = testStateRef.current;
        if (
          state !== null &&
          attachCountRef.current === 1 &&
          editable !== null
        ) {
          state.setAttribute("data-worker-quiet", "true");
        }
      });
    });
    return () => {
      cancelled = true;
    };
  });

  return (
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme: "light", themePreset: DEFAULT_THEME_PRESET }}
    >
      <DiffWorkerPoolProvider>
        <output
          ref={testStateRef}
          id="test-state"
          data-change-count="0"
          data-blur-count="0"
          data-attach-count="0"
          data-contents-settled-count="0"
          data-worker-quiet="false"
          data-write-count="0"
          data-comparison-identity={harness.comparisonIdentity}
          data-stale={editing.stale ? "true" : "false"}
          data-activation-error={editing.notice ?? ""}
        />
        <div id="tile">
          <FileDiffContent
            diff={DIFF}
            fileIdentity={null}
            isEmptyFile={false}
            mode="split"
            wordWrap
            backgrounds
            lineNumbers
            indicatorStyle="bars"
            onLoadFull={() => undefined}
            sizing="fill"
            scrollContainerRef={null}
            onScroll={null}
            editAdapter={editing.editAdapter}
            editSession={editSession}
          />
        </div>
      </DiffWorkerPoolProvider>
    </ResolvedThemeContext.Provider>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Missing browser regression root");
createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <DiffEditFocusFixture />
  </QueryClientProvider>,
);
