import { useMemo, type RefObject } from "react";
import { FirstTaskCoachmark } from "./first-task-coachmark";
import { SessionImportOpenTaskButton } from "@/components/session-import/session-import-open-task-button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  firstTaskImports,
  firstTaskImportPending,
  useFirstTaskGuideStore,
} from "@/stores/onboarding/first-task-guide-store";

export function FirstTaskLandingGuide(props: {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly workspaceFolders: readonly string[] | null;
}) {
  const hostId = useComposerSurfaceHostPin().resolvedHostId;
  const globalFolders = useWorkspaceFoldersStore(
    (state) => selectWorkspaceFoldersBucket(state, hostId).folders,
  );
  const hasWorkspace = (props.workspaceFolders ?? globalFolders).length > 0;
  const imports = useFirstTaskGuideStore((state) => state.imports);
  const reviewed = useFirstTaskGuideStore((state) => state.workspaceReviewed);
  const tasks = useMemo(() => firstTaskImports(imports), [imports]);
  const pending = firstTaskImportPending(imports);

  if (tasks.length > 0)
    return (
      <div className="mt-5 flex min-h-0 flex-col pb-3">
        <div
          data-first-task-imports
          className="grid min-h-0 max-h-[min(30vh,18rem)] gap-2 overflow-y-auto rounded-xl p-1 sm:grid-cols-2"
        >
          {tasks.map((task) => (
            <SessionImportOpenTaskButton
              key={`${task.hostId}:${task.chatId}`}
              target={{
                kind: "already_in_traycer",
                epicId: task.epicId,
                chatId: task.chatId,
              }}
              title={task.title}
              targetHostId={task.hostId}
              presentation="card"
              onTaskOpened={() => undefined}
              onBeforeTaskOpen={null}
            />
          ))}
        </div>
        {pending ? (
          <p
            role="status"
            className="mt-2 flex items-center gap-2 text-ui-xs text-muted-foreground"
          >
            <MutedAgentSpinner />
            Importing remaining tasks…
          </p>
        ) : null}
        <FirstTaskCoachmark
          step="imported"
          rootRef={props.rootRef}
          selector="[data-first-task-imports]"
        />
      </div>
    );

  if (pending)
    return (
      <div className="mt-5 flex items-center justify-between gap-3 text-ui-sm text-muted-foreground">
        <p role="status" className="flex items-center gap-2">
          <MutedAgentSpinner />
          Importing tasks…
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useFirstTaskGuideStore.getState().dismiss()}
        >
          Dismiss
        </Button>
      </div>
    );

  let step: "folder" | "workspace" | "prompt" = "folder";
  if (hasWorkspace) step = reviewed ? "prompt" : "workspace";
  const selector = {
    folder: '[data-testid="folder-add"]',
    workspace: '[data-testid="workspace-summary-trigger"]',
    prompt: "[data-composer-shell]",
  }[step];
  return (
    <>
      {imports.size > 0 ? (
        <p role="status" className="mt-3 text-ui-xs text-muted-foreground">
          No tasks imported. Start a new task.
        </p>
      ) : null}
      <FirstTaskCoachmark
        step={step}
        rootRef={props.rootRef}
        selector={selector}
      />
    </>
  );
}

export function FirstTaskChatGuide(props: {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly hostId: string | null;
  readonly chatId: string;
}) {
  const imports = useFirstTaskGuideStore((state) => state.imports);
  const imported = firstTaskImports(imports).some(
    (task) => task.hostId === props.hostId && task.chatId === props.chatId,
  );
  if (!imported) return null;
  return (
    <FirstTaskCoachmark
      step="continue"
      rootRef={props.rootRef}
      selector="[data-composer-shell]"
    />
  );
}
