import { useMemo, useRef, type ReactNode, type RefObject } from "react";
import { FirstTaskCoachmark } from "./first-task-coachmark";
import { SessionImportOpenTaskButton } from "@/components/session-import/session-import-open-task-button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { useAmbientHistorySearchState } from "@/hooks/home/use-history-search-state";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
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
  // Mounted by form factor, matching the shell: `AppShell` renders the
  // navigation drawer this branch is about on the mobile VIEWPORT, so a narrow
  // desktop window is on this branch too, and the installed app is not a
  // separate case.
  const isMobile = useIsMobileViewport();
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
            Importing your tasks…
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
          Importing your tasks…
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

  // `reviewWorkspace()` can fire while the folder picker is still open (opening
  // the location menu counts as reviewing), so `prompt` can become the current
  // step a frame before the popover unmounts. There is no popover-open state on
  // this side of the tree to gate on; the coachmark engine already withholds a
  // card whose target sits outside an open overlay, which is the same gate.
  let step: "folder" | "workspace" | "prompt" = "folder";
  if (hasWorkspace) step = reviewed ? "prompt" : "workspace";
  const selector = {
    folder: '[data-testid="folder-add"]',
    workspace: '[data-testid="workspace-summary-trigger"]',
    prompt: "[data-composer-shell]",
  }[step];
  const folderFlow = (
    <FirstTaskCoachmark
      step={step}
      rootRef={props.rootRef}
      selector={selector}
    />
  );
  if (!isMobile) return folderFlow;
  return <MobileTasksGuide fallback={folderFlow} />;
}

const TASKS_SELECTORS = {
  "tasks-menu": '[data-testid="mobile-nav-trigger"]',
  // The first row rather than the list around it: the list's own first
  // focusable control is its sticky header's "View all" link, and "Show me"
  // has to put a TASK under the finger.
  "tasks-pick": '[data-testid="mobile-nav-task-row"]',
} as const;

/**
 * The mobile branch for an account that already has tasks: the phone's landing
 * page has no task list on it, so the first thing to teach is where they went -
 * the hamburger drawer - rather than how to start another one.
 *
 * Both steps are derived from the drawer's open state, so opening it by any
 * route advances and closing it without picking returns to step 1. Opening a
 * task from the drawer is what ends the guide.
 *
 * The count comes from the drawer's own query, not a second one: the same key,
 * so this is a cache read wherever the drawer has already asked. While it is
 * still outstanding this renders NOTHING rather than the folder flow - a guide
 * that starts teaching "add a folder" and swaps mid-sentence is worse than one
 * that arrives a beat late. An error or an empty list falls through to the
 * folder flow, which is what a user with no tasks needs either way.
 */
function MobileTasksGuide(props: { readonly fallback: ReactNode }) {
  const { search } = useAmbientHistorySearchState();
  const history = useHistoryQuery({ search, nowMs: null });
  const drawerOpen = useMobileNavStore((state) => state.open);
  // The hamburger lives in the app header and the drawer portals to the body,
  // so neither target is under the landing surface the rest of this guide is
  // scoped to.
  const documentRef = useRef<HTMLElement | null>(document.body);
  const loading = history.isPending || history.cloudPagePending;
  // Optimistic while the list loads: on a fresh install the history query
  // waits on cloud authorization and then on the first page, which is many
  // seconds, and a guide that draws nothing for that long is one the user has
  // already walked past by opening the menu themselves. Nearly everyone on
  // this branch has tasks (they ran the desktop app first), so the menu step
  // shows at once and only a settled answer of "none" or an error falls back
  // to the add-folder flow.
  const settledEmpty = !loading && (history.data?.items.length ?? 0) === 0;
  if (history.error !== null || settledEmpty) return props.fallback;
  const step = drawerOpen ? "tasks-pick" : "tasks-menu";
  return (
    <FirstTaskCoachmark
      step={step}
      rootRef={documentRef}
      selector={TASKS_SELECTORS[step]}
    />
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
