/**
 * The right-click menu for the sidebar file tree's rows.
 *
 * Pierre renders its rows inside a shadow root, so there is no per-row element
 * to hang a menu on: the whole tree container is the trigger and the row is
 * recovered from the event's composed path.
 *
 * Radix opens the menu from two events - `contextMenu` for a mouse, and a
 * 700ms long-press timer armed on a touch or pen `pointerDown` - so the row
 * has to be captured on both or a long-press opens the root with no content
 * mounted. Both handlers are composed with Radix's own through
 * `composeEventHandlers`, which skips a default-prevented event: calling
 * `preventDefault()` when the press hit no row is what keeps an empty menu
 * from opening over the tree's blank space.
 *
 * The items live in a child mounted only while a row is captured, keeping the
 * menu's host-scoped data hooks off the panel's render path.
 */
import {
  useCallback,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Copy, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import type { OpenPathsTarget } from "@traycer/protocol/host/editor/unary-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  extractPierreItemPathFromEvent,
  type PierreActivationEvent,
} from "@/components/epic-canvas/pierre-tree-adapter";
import {
  EDITOR_ICONS,
  resolveEditorState,
} from "@/lib/editor/editor-menu-catalog";
import { useEditorAvailability } from "@/hooks/editor/use-editor-availability-query";
import { useEditorOpenFeedback } from "@/hooks/editor/use-editor-open-feedback";
import { useEditorOpenForClient } from "@/hooks/editor/use-editor-open-mutation";
import { useFinderOpenAvailability } from "@/hooks/editor/use-finder-open-availability";
import { useOfferableEditors } from "@/hooks/editor/use-offerable-editors";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { resolveAbsolutePath } from "@/lib/path/cross-platform-path";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

const COPY_FEEDBACK_RESET_MS = 2000;

/** The row a right-click landed on, as the menu needs to describe it. */
interface FileTreeContextMenuRow {
  /** Workspace-relative tree path; directory rows keep their trailing `/`. */
  readonly treePath: string;
  readonly isDirectory: boolean;
}

export interface FileTreeRowContextMenuProps {
  readonly hostId: string | null;
  readonly workspacePath: string;
  /** Openable file rows; a tree path absent here is a directory row. */
  readonly fileNameByPath: ReadonlyMap<string, string>;
  /** The tree container, which becomes the menu's trigger. */
  readonly children: ReactNode;
}

function reportCopyFailure(): void {
  reportableErrorToast("Couldn't copy path to clipboard.", undefined, {
    title: "Could not copy path",
    message: null,
    code: null,
    source: "File tree",
  });
}

export function FileTreeRowContextMenu(props: FileTreeRowContextMenuProps) {
  const { fileNameByPath } = props;
  const [row, setRow] = useState<FileTreeContextMenuRow | null>(null);

  const captureRow = useCallback(
    (event: PierreActivationEvent & { preventDefault: () => void }) => {
      const treePath = extractPierreItemPathFromEvent(event);
      if (treePath === null) {
        event.preventDefault();
        setRow(null);
        return;
      }
      // Two independent tells for a directory: the live listings mark folders
      // with a trailing separator, and every source omits them from the
      // openable file map. Either is sufficient.
      setRow({
        treePath,
        isDirectory: treePath.endsWith("/") || !fileNameByPath.has(treePath),
      });
    },
    [fileNameByPath],
  );

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      captureRow(event);
    },
    [captureRow],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      // Mouse presses reach the menu through `contextMenu`; only the
      // touch/pen long-press arm needs the row captured here.
      if (event.pointerType === "mouse") return;
      captureRow(event);
    },
    [captureRow],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
      >
        {props.children}
      </ContextMenuTrigger>
      {row === null ? null : (
        <FileTreeRowContextMenuContent
          row={row}
          hostId={props.hostId}
          workspacePath={props.workspacePath}
        />
      )}
    </ContextMenu>
  );
}

interface FileTreeRowContextMenuContentProps {
  readonly row: FileTreeContextMenuRow;
  readonly hostId: string | null;
  readonly workspacePath: string;
}

function FileTreeRowContextMenuContent(
  props: FileTreeRowContextMenuContentProps,
) {
  const { row, hostId, workspacePath } = props;
  const hostEntry = useHostDirectoryEntry(hostId);
  const finderAvailable = useFinderOpenAvailability(hostId);
  const availability = useEditorAvailability();
  const offerableEditors = useOfferableEditors(hostId);
  const hostClient = useHostClientForHostId(hostId);
  // "file", not "workspace": a tree row is a single path, and counting it as a
  // workspace open would overstate editor workspace adoption.
  const mutation = useEditorOpenForClient(hostClient, "file");
  const { active: openFeedbackActive, trigger: triggerOpenFeedback } =
    useEditorOpenFeedback();
  const { copy: copyAbsolutePath } = useClipboardCopy({
    resetMs: COPY_FEEDBACK_RESET_MS,
    onSuccess: () => {
      toast.success("Copied path");
    },
    onError: reportCopyFailure,
  });
  const { copy: copyRelativePath } = useClipboardCopy({
    resetMs: COPY_FEEDBACK_RESET_MS,
    onSuccess: () => {
      toast.success("Copied relative path");
    },
    onError: reportCopyFailure,
  });

  // An editor launches through a URL-scheme handler registered on the host's
  // own machine, so the editor items are local-host-only for the same reason
  // the workspace header's are (see `OpenInEditorButton`).
  const hostIsLocal =
    hostEntry !== null &&
    (hostEntry.kind === "local" || hostEntry.kind === "mock");
  // A context menu has no primary half, so no default editor is consulted -
  // every editor this host will accept and this machine has installed is
  // simply listed.
  const { availableEditors } = resolveEditorState(
    offerableEditors,
    availability.data ?? null,
    null,
  );
  const editorEntries = hostIsLocal ? availableEditors : [];

  const absolutePath = resolveAbsolutePath(workspacePath, row.treePath);
  // The tree path already IS the workspace-relative path; a directory row only
  // has to shed the trailing separator the tree marks it with.
  const relativePath = row.treePath.endsWith("/")
    ? row.treePath.slice(0, -1)
    : row.treePath;

  // One launch at a time. The menu can be reopened and a target reselected
  // while a slow open is still in flight, and every mutate is queued rather
  // than coalesced, so an unguarded handler launches the same path twice.
  // The launching items swap their leading icon for the spinner and keep
  // their label, so the disabled state reads as work in progress.
  const opening = mutation.isPending || openFeedbackActive;

  const openPath = (editorId: OpenPathsTarget) => {
    if (opening) return;
    triggerOpenFeedback();
    // A directory handed to an editor opens as a folder there, which is the
    // right outcome for both row kinds.
    mutation.mutate({ editorId, paths: [absolutePath] });
  };

  return (
    <ContextMenuContent data-testid="epic-file-tree-row-menu">
      {editorEntries.map((editor) => {
        const Icon = EDITOR_ICONS[editor.id];
        return (
          <ContextMenuItem
            key={editor.id}
            data-testid={`epic-file-tree-row-open-${editor.id}`}
            disabled={opening}
            onSelect={() => openPath(editor.id)}
          >
            {opening ? (
              <AgentSpinningDots
                className="size-3.5"
                testId={`epic-file-tree-row-open-${editor.id}-spinner`}
                variant={undefined}
              />
            ) : (
              <Icon className="size-3.5" aria-hidden />
            )}
            <span>{editor.label}</span>
          </ContextMenuItem>
        );
      })}
      {editorEntries.length > 0 ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        data-testid="epic-file-tree-row-copy-path"
        onSelect={() => copyAbsolutePath(absolutePath)}
      >
        <Copy className="size-3.5" aria-hidden />
        <span>Copy Path</span>
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="epic-file-tree-row-copy-relative-path"
        onSelect={() => copyRelativePath(relativePath)}
      >
        <Copy className="size-3.5" aria-hidden />
        <span>Copy Relative Path</span>
      </ContextMenuItem>
      {finderAvailable ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            data-testid="epic-file-tree-row-finder"
            disabled={opening}
            onSelect={() => openPath("finder")}
          >
            {opening ? (
              <AgentSpinningDots
                className="size-3.5"
                testId="epic-file-tree-row-finder-spinner"
                variant={undefined}
              />
            ) : (
              <FolderOpen className="size-3.5" aria-hidden />
            )}
            {/* A folder IS the Finder window; a file is revealed selected
                inside its parent, which is a different gesture and says so. */}
            <span>
              {row.isDirectory ? "Open in Finder" : "Reveal in Finder"}
            </span>
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );
}
