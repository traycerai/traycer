import type { ComponentType } from "react";
import { ChevronDown, Code, Copy } from "lucide-react";
import { toast } from "sonner";
import { EDITORS, type EditorId } from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CursorIcon,
  VisualStudioCodeIcon,
  WindsurfIcon,
  ZedIcon,
  type EditorIconProps,
} from "@/components/icons/editor-icons";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useEditorOpen } from "@/hooks/editor/use-editor-open-mutation";
import { useEditorOpenFeedback } from "@/hooks/editor/use-editor-open-feedback";
import { useEditorAvailability } from "@/hooks/editor/use-editor-availability-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

type EditorIconComponent = ComponentType<EditorIconProps>;

const EDITOR_ICONS: Readonly<Record<EditorId, EditorIconComponent>> = {
  vscode: VisualStudioCodeIcon,
  cursor: CursorIcon,
  windsurf: WindsurfIcon,
  zed: ZedIcon,
};

// Resolve which editors to offer and which one the primary half opens, from the
// shell-local availability probe. Pulled out of the component to keep its
// cyclomatic complexity within the lint budget once the host guard is layered on.
function resolveEditorState(
  availableEditorIds: ReadonlyArray<EditorId> | null,
  defaultEditor: EditorId | null,
) {
  const availableEditors =
    availableEditorIds === null
      ? EDITORS
      : EDITORS.filter((editor) => availableEditorIds.includes(editor.id));
  const noEditorsAvailable =
    availableEditorIds !== null && availableEditors.length === 0;

  const firstAvailableEditorId: EditorId | null =
    availableEditors.length > 0 ? availableEditors[0].id : null;
  let primaryEditorId: EditorId | null = null;
  if (!noEditorsAvailable) {
    primaryEditorId =
      defaultEditor !== null &&
      (availableEditorIds === null ||
        availableEditorIds.includes(defaultEditor))
        ? defaultEditor
        : firstAvailableEditorId;
  }
  return { availableEditors, noEditorsAvailable, primaryEditorId };
}

export interface OpenInEditorButtonProps {
  readonly openTarget: {
    readonly workspacePath: string;
    readonly hostId: string;
  } | null;
}

export function OpenInEditorButton(props: OpenInEditorButtonProps) {
  const runnerHost = useRunnerHost();
  const activeHostId = useReactiveActiveHostId();
  const activeHostEntry = useHostDirectoryEntry(activeHostId ?? "");
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const setDefaultEditor = useSettingsStore((s) => s.setDefaultEditor);
  const mutation = useEditorOpen();
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

  const { openTarget } = props;
  // The opener dispatches on the active-host client (`useEditorOpen`) and the
  // open-in-editor surface is local-only, so it may only enable when the target
  // lives on the active host AND that active host is local (or mock, in tests).
  // Matching the active id alone is not enough: with a remote host selected,
  // both `activeHostId` and the selected row's `hostId` are the remote id, so an
  // id-only check would route `editor.openPaths` through the remote machine.
  const activeHostIsLocal =
    activeHostEntry !== null &&
    (activeHostEntry.kind === "local" || activeHostEntry.kind === "mock");
  const hostMatches =
    openTarget !== null &&
    openTarget.hostId === activeHostId &&
    activeHostIsLocal;

  // Hide editors whose URL-scheme handler is not registered on the host's
  // machine (i.e. not installed) so a user is never offered one that fails to
  // launch. While the probe is in flight (`null`) show the full catalog rather
  // than flashing an empty list. The primary half opens the user's default
  // editor when available, otherwise the first available one.
  const availableEditorIds = availability.data ?? null;
  const { availableEditors, noEditorsAvailable, primaryEditorId } =
    resolveEditorState(availableEditorIds, defaultEditor);
  const PrimaryIcon: EditorIconComponent | null =
    primaryEditorId !== null ? EDITOR_ICONS[primaryEditorId] : null;
  const PrimaryButtonIcon = PrimaryIcon ?? Code;
  const openingEditor = mutation.isPending || openFeedbackActive;

  const openInEditor = (editorId: EditorId) => {
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
        {openingEditor ? (
          <AgentSpinningDots
            className="size-3.5"
            testId="workspace-open-in-editor-spinner"
            variant={undefined}
          />
        ) : (
          <PrimaryButtonIcon className="size-3.5" aria-hidden />
        )}
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
          {availableEditors.map((editor) => {
            const Icon = EDITOR_ICONS[editor.id];
            return (
              <DropdownMenuItem
                key={editor.id}
                data-testid={`workspace-open-in-editor-${editor.id}`}
                disabled={openingEditor}
                onSelect={() => handleSelectEditor(editor.id)}
              >
                <Icon className="size-3.5" aria-hidden />
                <span>{editor.label}</span>
              </DropdownMenuItem>
            );
          })}
          {availableEditors.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            data-testid="workspace-open-in-editor-copy-path"
            onSelect={handleCopyPath}
          >
            <Copy className="size-3.5" aria-hidden />
            <span>Copy path</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
