import { frameLocator } from "@/components/canvas-artifact/canvas-structure-identity";
import type { QueryClient } from "@tanstack/react-query";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { readCanvasBoardDocument } from "@/components/canvas-artifact/canvas-board-document";
import { canvasQueryKeys } from "@/lib/query-keys/canvas-query-keys";
import type { AnchoredCommentDraft } from "@/stores/comments/anchored-draft-store";
import type { CanvasSelection } from "@/components/canvas-artifact/canvas-selection-store";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import {
  commentAnchorForSelection,
  frameCommentScreenRect,
  literalCommentSelection,
} from "./frame-comment-anchor";
import { useAnchoredDraftStore } from "@/stores/comments/anchored-draft-store";

function matchesDraft(
  current: AnchoredCommentDraft | undefined,
  tileId: string,
  selection: CanvasSelection,
): boolean {
  return (
    current !== undefined &&
    current.tileId === tileId &&
    current.artifactId === selection.artifactId &&
    current.selection !== null &&
    current.selection.boardPath === selection.boardPath &&
    current.selection.element.marker === selection.element.marker &&
    current.selection.element.tid === selection.element.tid
  );
}

async function readCommentDraftSource(
  selection: CanvasSelection,
  source: SandboxSource | null,
  queryClient: QueryClient,
): Promise<string | null> {
  if (selection.textRange === null) return null;
  if (
    source?.kind !== "artifact" ||
    source.manifest.files[source.entryPath]?.sha256 !== selection.servedSha256
  )
    throw new Error("The page changed. Select the text again.");
  const document = await queryClient.fetchQuery({
    queryKey: canvasQueryKeys.source(
      selection.artifactId,
      selection.boardPath,
      selection.servedSha256,
      source,
    ),
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) => readCanvasBoardDocument(source, signal),
  });
  return document.text;
}

export async function openFrameCommentDraft(args: {
  readonly epicId: string;
  readonly tileId: string;
  readonly artifactType: "html" | "canvas";
  readonly selection: CanvasSelection;
  readonly bridge: SandboxBridgeHost;
  readonly frame: HTMLIFrameElement;
  readonly source: SandboxSource | null;
  readonly queryClient: QueryClient;
  readonly isCurrent: () => boolean;
}): Promise<string | null> {
  if (
    useAnchoredDraftStore.getState().byEpicId[args.epicId]?.submitting === true
  )
    return null;
  const target = await literalCommentSelection(args.selection, args.bridge);
  if (!args.isCurrent()) return null;
  if (target === null)
    return "This element has no container in the page. Comment on the whole page instead.";
  const { selection, retargeted } = target;
  const locator = frameLocator(selection.element);
  const [described, servedSource] = await Promise.all([
    locator === null ? null : args.bridge.describeElement(locator),
    readCommentDraftSource(selection, args.source, args.queryClient),
  ]);
  if (!args.isCurrent()) return null;
  const anchor = commentAnchorForSelection(
    selection,
    described?.textSnapshot?.content ?? null,
    servedSource,
  );
  const store = useAnchoredDraftStore.getState();
  const current = store.byEpicId[args.epicId];
  if (current?.submitting === true) return null;
  const sameDraft = matchesDraft(current, args.tileId, selection);
  const draft = {
    draftId:
      sameDraft && current !== undefined
        ? current.draftId
        : crypto.randomUUID(),
    tileId: args.tileId,
    artifactId: selection.artifactId,
    artifactType: args.artifactType,
    ...anchor,
    selection,
    retargeted,
    rect: frameCommentScreenRect(
      args.frame,
      selection.textRange?.rects.at(0) ?? selection.element.box,
    ),
  };
  store.setDraft(args.epicId, draft);
  return null;
}
