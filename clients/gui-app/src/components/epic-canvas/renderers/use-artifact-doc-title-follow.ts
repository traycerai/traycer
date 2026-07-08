import type { Editor, EditorEvents } from "@tiptap/core";
import { useEffect } from "react";
import { useEpicRenameArtifact } from "@/hooks/epic/use-epic-node-mutations";
import {
  DEFAULT_EPIC_NODE_NAMES,
  isEpicArtifactKind,
} from "@/lib/artifacts/node-display";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

/**
 * Trailing debounce for the authoritative `epic.renameArtifact` persist. The
 * local Y.Doc rename below is applied per doc change so the tab / sidebar
 * title tracks typing live; the RPC only needs to land once the title
 * settles.
 */
const RENAME_PERSIST_DEBOUNCE_MS = 800;

/**
 * The document's own title: the text of a level-1 heading sitting at the very
 * top of the body, or `null` when the doc doesn't start with one. Mirrors the
 * host's disk-ingest fallback (`parseBody` in epic-file-sync), which reads a
 * leading `# ` line - not a heading further down - as the artifact title.
 */
export function leadingDocTitle(editor: Editor): string | null {
  const first = editor.state.doc.firstChild;
  if (first === null || first.type.name !== "heading") return null;
  const level: unknown = first.attrs["level"];
  if (level !== 1) return null;
  const text = first.textContent.trim();
  return text.length > 0 ? text : null;
}

/**
 * Notion-style title inheritance for hand-created artifacts: while the
 * artifact's title still *follows* the document, editing the doc's leading
 * `# ` heading renames the artifact, so the canvas tab / sidebar / breadcrumb
 * title mirrors what the author typed instead of staying "New spec".
 *
 * The title follows the doc while it is empty, still the create-flow default
 * ("New <kind>"), or equal to the heading's previous value (i.e. it was
 * derived from the doc). An explicit rename (sidebar inline rename, another
 * client) breaks the link: the follow check fails from then on, so a
 * deliberate title is never clobbered by body edits. Deleting the heading
 * keeps the last title - an artifact never renames to empty.
 *
 * Scope guards: only artifact kinds (spec/ticket/story/review), only
 * `createdManually` records (agent-created artifacts have authored titles),
 * and only for editors (the local rename action and the RPC both reject
 * viewers anyway).
 *
 * Write path matches the sidebar rename: local Y.Doc rename (live title
 * everywhere + host stream sync), tab-ref name snapshot, then the
 * authoritative `epic.renameArtifact` RPC debounced behind typing and flushed
 * on unmount. The rename touches only artifact metadata - never the body
 * fragment - so it cannot re-trigger the editor update this hook listens to.
 */
export function useArtifactDocTitleFollow(params: {
  readonly editor: Editor | null;
  readonly epicId: string;
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly editable: boolean;
}): void {
  const { editor, epicId, node, viewTabId, editable } = params;
  const artifactId = node.id;
  const nodeType = node.type;
  const handle = useOpenEpicHandle();
  const renameArtifactInTab = useEpicCanvasStore((s) => s.renameArtifactInTab);
  const renameArtifact = useEpicRenameArtifact();
  // TanStack Query keeps `mutate` referentially stable, so depending on it
  // does not re-subscribe the editor listener on every mutation state change.
  const persistRename = renameArtifact.mutate;

  useEffect(() => {
    if (editor === null || !editable) return;
    if (!isEpicArtifactKind(nodeType)) return;
    const defaultTitle = DEFAULT_EPIC_NODE_NAMES[nodeType];
    let lastDocTitle = leadingDocTitle(editor);
    let pendingPersistTitle: string | null = null;
    let persistTimer: number | null = null;

    const flushPersist = (): void => {
      persistTimer = null;
      const title = pendingPersistTitle;
      pendingPersistTitle = null;
      if (title === null) return;
      const artifacts = handle.store.getState().artifacts;
      const artifact = Object.hasOwn(artifacts.byId, artifactId)
        ? artifacts.byId[artifactId]
        : null;
      // A competing rename (sidebar, another client) superseded the debounced
      // value while it waited - that path persists its own title.
      if (artifact === null || artifact.title !== title) return;
      persistRename({ epicId, artifactId, title });
    };

    const onUpdate = ({ transaction }: EditorEvents["update"]): void => {
      if (!transaction.docChanged) return;
      const nextDocTitle = leadingDocTitle(editor);
      const prevDocTitle = lastDocTitle;
      lastDocTitle = nextDocTitle;
      if (nextDocTitle === null || nextDocTitle === prevDocTitle) return;
      const state = handle.store.getState();
      const artifact = Object.hasOwn(state.artifacts.byId, artifactId)
        ? state.artifacts.byId[artifactId]
        : null;
      if (artifact === null || !artifact.createdManually) return;
      if (artifact.title === nextDocTitle) return;
      const titleFollowsDoc =
        artifact.title.length === 0 ||
        artifact.title === defaultTitle ||
        artifact.title === prevDocTitle;
      if (!titleFollowsDoc) return;
      state.renameArtifact(artifactId, nextDocTitle);
      renameArtifactInTab(viewTabId, artifactId, nextDocTitle);
      pendingPersistTitle = nextDocTitle;
      if (persistTimer !== null) window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(
        flushPersist,
        RENAME_PERSIST_DEBOUNCE_MS,
      );
    };

    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        flushPersist();
      }
    };
  }, [
    editor,
    editable,
    nodeType,
    artifactId,
    epicId,
    viewTabId,
    handle,
    renameArtifactInTab,
    persistRename,
  ]);
}
