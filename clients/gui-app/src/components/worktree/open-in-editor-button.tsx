import type { ReactNode } from "react";
import { ChevronDown, Code, Copy, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import type { EditorEntry, EditorId } from "@traycer/protocol/host";
import type { OpenPathsTarget } from "@traycer/protocol/host/editor/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useEditorOpenForClient } from "@/hooks/editor/use-editor-open-mutation";
import { useEditorOpenFeedback } from "@/hooks/editor/use-editor-open-feedback";
import { useEditorAvailability } from "@/hooks/editor/use-editor-availability-query";
import { useFinderOpenAvailability } from "@/hooks/editor/use-finder-open-availability";
import { useOfferableEditors } from "@/hooks/editor/use-offerable-editors";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  EDITOR_ICONS,
  resolveEditorState,
  type EditorIconComponent,
} from "@/lib/editor/editor-menu-catalog";

export interface OpenInEditorButtonProps {
  readonly openTarget: {
    readonly workspacePath: string;
    readonly hostId: string;
  } | null;
  /**
   * The panel's OWN client (its surface pin's resolved client, or the tab's),
   * never the app-wide one: `editor.openPaths` resolves the path on the host
   * the request is SENT to, and an Epic-scoped panel's `openTarget` names its
   * own surface pin, not whatever the app-wide effective host happens to be.
   * See {@link useEditorOpenForClient}.
   */
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}

export function OpenInEditorButton(props: OpenInEditorButtonProps) {
  const runnerHost = useRunnerHost();
  const { openTarget } = props;
  // The opener dispatches on the PANEL'S OWN client now (`hostClient`), so the
  // gate is no longer "does the target match the app-wide effective host" -
  // it is local-only for a different reason: the editor URL-scheme launch
  // itself only works on THIS machine, so the target's own host (whichever
  // one the panel is pinned to) must be the local one, not merely dialable.
  // Called unconditionally, before the early return below, per Rules of Hooks.
  const openTargetHostId = openTarget?.hostId ?? null;
  const openTargetHostEntry = useHostDirectoryEntry(openTargetHostId);
  // Finder rides the same RPC but has its own, stricter gate (local host AND a
  // Mac AND a host that negotiated `editor.openPaths` 1.2). Called
  // unconditionally for the same Rules-of-Hooks reason as the lookup above.
  const finderAvailable = useFinderOpenAvailability(openTargetHostId);
  const offerableEditors = useOfferableEditors(openTargetHostId);
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const setDefaultEditor = useSettingsStore((s) => s.setDefaultEditor);
  const mutation = useEditorOpenForClient(props.hostClient, "workspace");
  const { active: openFeedbackActive, trigger: triggerOpenFeedback } =
    useEditorOpenFeedback();
  const availability = useEditorAvailability();
  const { copy } = useClipboardCopy({
    resetMs: 2000,
    onSuccess: () => {
      toast.success("Copied workspace path");
    },
    onError: () => {
      reportableErrorToast("Couldn't copy path to clipboard.", undefined, {
        title: "Could not copy workspace path",
        message: null,
        code: null,
        source: "Workspace",
      });
    },
  });

  if (!runnerHost.hasLocalHost) return null;

  const openTargetHostIsLocal =
    openTargetHostEntry !== null &&
    (openTargetHostEntry.kind === "local" ||
      openTargetHostEntry.kind === "mock");
  const hostMatches = openTarget !== null && openTargetHostIsLocal;

  // Hide editors whose URL-scheme handler is not registered on the host's
  // machine (i.e. not installed) so a user is never offered one that fails to
  // launch. While the probe is in flight (`null`) show the full catalog rather
  // than flashing an empty list. The primary half opens the user's default
  // editor when available, otherwise the first available one.
  const availableEditorIds = availability.data ?? null;
  const { availableEditors, noEditorsAvailable, primaryEditorId } =
    resolveEditorState(offerableEditors, availableEditorIds, defaultEditor);
  const PrimaryIcon: EditorIconComponent | null =
    primaryEditorId !== null ? EDITOR_ICONS[primaryEditorId] : null;
  const PrimaryButtonIcon = PrimaryIcon ?? Code;
  const openingEditor = mutation.isPending || openFeedbackActive;

  // Takes the wire target rather than `EditorId`: `"finder"` shares the whole
  // pressed-feedback / disable cycle with the editor items and differs only in
  // the literal on the wire. Choosing a DEFAULT stays editor-only below.
  const openInEditor = (editorId: OpenPathsTarget) => {
    if (openingEditor || openTarget === null) return;
    triggerOpenFeedback();
    mutation.mutate({ editorId, paths: [openTarget.workspacePath] });
  };

  const handleOpenPrimaryEditor = () => {
    if (primaryEditorId === null) return;
    openInEditor(primaryEditorId);
  };

  const handleSelectEditor = (editorId: EditorId) => {
    setDefaultEditor(editorId);
    openInEditor(editorId);
  };

  const handleCopyPath = () => {
    if (openTarget === null) return;
    copy(openTarget.workspacePath);
  };

  const handleOpenInFinder = () => {
    openInEditor("finder");
  };

  return (
    <div
      className="inline-flex shrink-0 items-center"
      data-testid="workspace-open-in-editor"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={openingEditor || noEditorsAvailable || !hostMatches}
        aria-label="Open workspace in editor"
        data-testid="workspace-open-in-editor-primary"
        className="size-7 rounded-r-none"
        onClick={handleOpenPrimaryEditor}
      >
        <PrimaryButtonGlyph
          openingEditor={openingEditor}
          icon={<PrimaryButtonIcon className="size-3.5" aria-hidden />}
        />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={openingEditor || !hostMatches}
            aria-label="Choose editor"
            data-testid="workspace-open-in-editor-chevron"
            className="size-5 rounded-l-none px-0"
          >
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[min(90vw,11rem)]"
          data-testid="workspace-open-in-editor-menu"
        >
          <EditorChooserMenuItems
            availableEditors={availableEditors}
            openingEditor={openingEditor}
            finderAvailable={finderAvailable}
            onSelectEditor={handleSelectEditor}
            onCopyPath={handleCopyPath}
            onOpenInFinder={handleOpenInFinder}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The primary half swaps its editor glyph for the pending indicator; the icon
 * arrives already rendered so this stays agnostic about which icon family it
 * was handed (an editor icon, or the generic fallback when no editor resolved).
 */
function PrimaryButtonGlyph(props: {
  readonly openingEditor: boolean;
  readonly icon: ReactNode;
}) {
  if (props.openingEditor) {
    return (
      <AgentSpinningDots
        className="size-3.5"
        testId="workspace-open-in-editor-spinner"
        variant={undefined}
      />
    );
  }
  return props.icon;
}

interface EditorChooserMenuItemsProps {
  readonly availableEditors: ReadonlyArray<EditorEntry>;
  readonly openingEditor: boolean;
  readonly finderAvailable: boolean;
  readonly onSelectEditor: (editorId: EditorId) => void;
  readonly onCopyPath: () => void;
  readonly onOpenInFinder: () => void;
}

function EditorChooserMenuItems(props: EditorChooserMenuItemsProps) {
  const { availableEditors, openingEditor } = props;
  return (
    <>
      {availableEditors.map((editor) => {
        const Icon = EDITOR_ICONS[editor.id];
        return (
          <DropdownMenuItem
            key={editor.id}
            data-testid={`workspace-open-in-editor-${editor.id}`}
            disabled={openingEditor}
            onSelect={() => props.onSelectEditor(editor.id)}
          >
            <Icon className="size-3.5" aria-hidden />
            <span>{editor.label}</span>
          </DropdownMenuItem>
        );
      })}
      {availableEditors.length > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        data-testid="workspace-open-in-editor-copy-path"
        onSelect={props.onCopyPath}
      >
        <Copy className="size-3.5" aria-hidden />
        <span>Copy path</span>
      </DropdownMenuItem>
      {props.finderAvailable ? (
        <DropdownMenuItem
          data-testid="workspace-open-in-editor-finder"
          disabled={openingEditor}
          onSelect={props.onOpenInFinder}
        >
          <FolderOpen className="size-3.5" aria-hidden />
          <span>Open in Finder</span>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
