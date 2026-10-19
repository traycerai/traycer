import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { MessageSquarePlus } from "lucide-react";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { HtmlArtifactFrameContext } from "@/components/html-artifact/html-artifact-frame";
import {
  useHtmlSelectionStore,
  type HtmlSelection,
} from "@/components/html-artifact/html-selection-store";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useArtifactObjectTextQuery } from "@/hooks/files/use-artifact-object-text-query";
import { useActivateCommentThread } from "@/hooks/comments/use-activate-comment-thread";
import { useFrameCommentThreads } from "@/hooks/comments/use-frame-comment-threads";
import { useFrameCommentsEnabled } from "@/hooks/comments/use-frame-comments-enabled";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import { Button } from "@/components/ui/button";
import { useAnchoredDraftStore } from "@/stores/comments/anchored-draft-store";
import { useAnchorPositionsStore } from "@/stores/comments/anchor-positions-store";
import { openFrameCommentDraft } from "@/lib/comments/open-frame-comment-draft";
import { resolveHtmlCommentArtboard } from "@/lib/comments/frame-comment-anchor";
import { deriveFrameCommentPositions } from "@/lib/comments/frame-comment-positions";
import { registerCommentEditor } from "@/lib/comments/comment-editor-registry";
import { AnchoredDraftPopover } from "./anchored-draft-popover";
import { FrameCommentPins } from "./frame-comment-pins";
import { FrameCommentsToolbar } from "./frame-comments";
import { useOrderedFrameThreads } from "./use-ordered-frame-threads";

export interface HtmlCommentScope {
  readonly epicId: string;
  readonly artifactId: string;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly hostId: string;
  readonly rootPath: string;
  readonly rootArtboard: string;
  readonly source: SandboxSource;
}
export function HtmlArtifactCommentsToolbar(props: {
  readonly scope: HtmlCommentScope | null;
}) {
  if (props.scope === null) return null;
  return <FrameCommentsToolbar {...props.scope} artifactType="html" />;
}

export function HtmlArtifactCommentAction(props: {
  readonly scope: HtmlCommentScope;
  readonly context: HtmlArtifactFrameContext;
  readonly selection: HtmlSelection;
}) {
  const { scope, context, selection } = props;
  const enabled = useFrameCommentsEnabled();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  if (!enabled) return null;
  const open = (): void => {
    const { frame, bridge } = context;
    if (frame === null || bridge === null) return;
    if (selection.kind === "page") {
      const rect = frame.getBoundingClientRect();
      useAnchoredDraftStore.getState().setDraft(scope.epicId, {
        draftId: crypto.randomUUID(),
        tileId: scope.tileId,
        artifactId: scope.artifactId,
        artifactType: "html",
        anchor: { kind: "artifact" },
        quotedText: "",
        selection: null,
        retargeted: false,
        rect: { x: rect.x, y: rect.y, width: 0, height: 0 },
      });
      return;
    }
    if (selection.servedSha256 === null) return;
    const generation = useHtmlSelectionStore
      .getState()
      .byArtifact.get(scope.artifactId)?.generation;
    void openFrameCommentDraft({
      epicId: scope.epicId,
      tileId: scope.tileId,
      artifactType: "html",
      selection: {
        artifactId: scope.artifactId,
        boardPath: scope.rootArtboard,
        page: null,
        servedSha256: selection.servedSha256,
        element: selection.element,
        textRange: selection.kind === "text" ? selection.range : null,
      },
      bridge,
      frame,
      source: scope.source,
      queryClient,
      isCurrent: () =>
        useHtmlSelectionStore.getState().byArtifact.get(scope.artifactId)
          ?.generation === generation,
    })
      .then(setMessage)
      .catch(() => setMessage("The page changed. Select the element again."));
  };
  return (
    <>
      <Button size="sm" variant="outline" onClick={open}>
        <MessageSquarePlus />
        Comment
      </Button>
      {message === null ? null : (
        <span
          role="status"
          className="rounded-md border bg-popover p-2 text-ui-xs text-popover-foreground"
        >
          {message}
        </span>
      )}
    </>
  );
}

export function HtmlArtifactComments(props: {
  readonly scope: HtmlCommentScope;
  readonly artifact: ArtifactProjection;
  readonly context: HtmlArtifactFrameContext;
  readonly viewOnly: boolean;
}) {
  const client = useTabHostClient();
  const activate = useActivateCommentThread({
    ...props.scope,
    artifactType: "html",
  });
  return (
    <>
      {props.context.servedSha256 === null ? null : (
        <HtmlCommentDocument {...props} sha256={props.context.servedSha256} />
      )}
      {props.viewOnly ? null : (
        <AnchoredDraftPopover
          epicId={props.scope.epicId}
          artifactId={props.scope.artifactId}
          tileId={props.scope.tileId}
          hostClient={client}
          onCreated={activate}
          onClosed={() => {}}
        />
      )}
    </>
  );
}
function HtmlCommentDocument(props: {
  readonly scope: HtmlCommentScope;
  readonly artifact: ArtifactProjection;
  readonly context: HtmlArtifactFrameContext;
  readonly sha256: string;
}) {
  const { scope, artifact, context, sha256 } = props;
  const query = useArtifactObjectTextQuery(scope.hostId, {
    epicId: scope.epicId,
    sha256,
  });
  const source = query.data?.kind === "text" ? query.data.text : null;
  const allThreads = useFrameCommentThreads(
    scope.epicId,
    scope.artifactId,
    "html",
  );
  const threads = useMemo(
    () =>
      allThreads?.map((thread) => ({
        ...thread,
        data: {
          ...thread.data,
          ...(thread.data.artboard === undefined
            ? {}
            : {
                artboard: resolveHtmlCommentArtboard(
                  artifact,
                  thread.data.artboard,
                ),
              }),
        },
      })) ?? [],
    [allThreads, artifact],
  );
  const rootThreads = useMemo(
    () => threads.filter((thread) => thread.data.artboard === scope.rootPath),
    [threads, scope.rootPath],
  );
  const positions = useMemo(
    () =>
      deriveFrameCommentPositions(threads, [
        { path: scope.rootPath, text: source },
      ]),
    [threads, scope.rootPath, source],
  );
  const focused = usePaneFocused();
  const ordered = useOrderedFrameThreads(
    scope.epicId,
    scope.artifactId,
    "html",
  );
  const activate = useActivateCommentThread({ ...scope, artifactType: "html" });
  useEffect(() => {
    if (focused)
      useAnchorPositionsStore
        .getState()
        .setForArtifact(scope.epicId, scope.artifactId, positions);
  }, [focused, scope.epicId, scope.artifactId, positions]);
  useEffect(
    () =>
      registerCommentEditor({
        epicId: scope.epicId,
        artifactId: scope.artifactId,
        tileId: scope.tileId,
        isActive: focused,
        reveal: (threadId) => {
          if (!focused) return false;
          const thread = threads.find(
            (candidate) => candidate.threadId === threadId,
          );
          if (thread === undefined) return false;
          if (
            thread.data.artboard === scope.rootPath &&
            thread.data.elementId !== undefined
          ) {
            if (context.bridge === null) return false;
            void context.bridge.revealElement({ tid: thread.data.elementId });
          }
          return true;
        },
      }),
    [
      scope.epicId,
      scope.artifactId,
      scope.tileId,
      scope.rootPath,
      focused,
      threads,
      context.bridge,
    ],
  );
  return (
    <FrameCommentPins
      epicId={scope.epicId}
      artifactId={scope.artifactId}
      artifactType="html"
      ordered={ordered ?? []}
      threads={rootThreads}
      source={source}
      bridge={context.bridge}
      frame={context.frame}
      onActivate={activate}
    />
  );
}
