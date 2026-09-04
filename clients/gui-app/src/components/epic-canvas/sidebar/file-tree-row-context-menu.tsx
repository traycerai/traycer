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
  type ReactElement,
} from "react";
import { Copy } from "lucide-react";
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
  OPEN_TARGET_ICONS,
  resolveOpenMenuState,
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
}

export interface FileTreeRowContextMenuProps {
  readonly hostId: string | null;
  readonly workspacePath: string;
  /**
   * The tree container, which becomes the menu's trigger. Exactly ONE element:
   * `ContextMenuTrigger asChild` merges its props onto this node through
   * Radix's `Slot`, which throws on text, `null`, or an array.
   */
  readonly children: ReactElement;
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
  const [row, setRow] = useState<FileTreeContextMenuRow | null>(null);

  const captureRow = useCallback(
    (event: PierreActivationEvent & { preventDefault: () => void }) => {
      const treePath = extractPierreItemPathFromEvent(event);
      if (treePath === null) {
        event.preventDefault();
        setRow(null);
        return;
      }
      setRow({ treePath });
    },
    [],
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
  // own machine, so the open items are local-host-only for the same reason the
  // workspace header's are (see `OpenInEditorButton`).
  const hostIsLocal =
    hostEntry !== null &&
    (hostEntry.kind === "local" || hostEntry.kind === "mock");
  // A row menu has no primary half and does not record a default, so no stored
  // target is consulted - it simply lists what this host and machine can open
  // the row with, Finder last.
  const { targets } = resolveOpenMenuState({
    catalog: offerableEditors,
    availableEditorIds: availability.data ?? null,
    finderAvailable,
    defaultTarget: null,
  });
  const openTargets = hostIsLocal ? targets : [];

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
      {openTargets.map((target) => {
        const Icon = OPEN_TARGET_ICONS[target.id];
        return (
          <ContextMenuItem
            key={target.id}
            data-testid={`epic-file-tree-row-open-${target.id}`}
            disabled={opening}
            onSelect={() => openPath(target.id)}
          >
            {opening ? (
              <AgentSpinningDots
                className="size-3.5"
                testId={`epic-file-tree-row-open-${target.id}-spinner`}
                variant={undefined}
              />
            ) : (
              <Icon className="size-3.5" aria-hidden />
            )}
            <span>{target.label}</span>
          </ContextMenuItem>
        );
      })}
      {openTargets.length > 0 ? <ContextMenuSeparator /> : null}
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
    </ContextMenuContent>
  );
}
