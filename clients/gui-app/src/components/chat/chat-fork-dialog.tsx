import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { AgentModeToggle } from "@/components/home/pickers/agent-mode-toggle";
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCreateChatForHost } from "@/hooks/epic/use-epic-chat-mutations";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { openCreatedChatWhenProjectedWithNavigation } from "@/lib/commands/actions/new-chat";
import {
  pendingForkChatStagingKey,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import { readSeededLaunchWorktreeIntent } from "@/lib/worktree/seeded-launch-worktree-intent";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";

export interface ChatForkDialogTarget {
  readonly sourceChatId: string;
  readonly sourceChatTitle: string;
  readonly assistantMessageId: string;
  readonly parentId: string | null;
  readonly settingsSeed: ChatRunSettings;
  // The full seed (intent + folder snapshot) projected from the source chat's
  // visible workspace. The dialog applies it through the same seedIntent ->
  // seedEntryForFolder path the terminal-agent launcher uses.
  readonly workspaceSeed: ForkWorkspaceSeed;
}

interface ChatForkDialogProps {
  readonly open: boolean;
  readonly target: ChatForkDialogTarget | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function ChatForkDialog(props: ChatForkDialogProps) {
  // The dialog stays mounted per chat tile; gate the toolbar store's catalog
  // queries on `open` so a closed dialog holds no harness/model subscription
  // (the same semantics the old `activityEnabled` flag carried).
  return (
    <SurfaceActivityProvider active={props.open}>
      <ChatForkDialogBody {...props} />
    </SurfaceActivityProvider>
  );
}

function ChatForkDialogBody(props: ChatForkDialogProps) {
  const { epicId, onOpenChange, open, tabId, target } = props;
  const stagingKey = useMemo(() => pendingForkChatStagingKey(epicId), [epicId]);
  const [titleState, setTitleState] = useState(() => ({ open, title: "" }));
  const titleInputId = useId();
  const tabHostId = useTabHostId();
  const createChat = useEpicCreateChatForHost();
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  const openCancelsRef = useRef<Set<() => void> | null>(null);

  useEffect(() => {
    const openCancels = new Set<() => void>();
    openCancelsRef.current = openCancels;
    return () => {
      for (const cancel of openCancels) cancel();
      openCancels.clear();
      openCancelsRef.current = null;
    };
  }, []);

  const defaultTitle =
    target === null ? "" : `Fork - ${displayChatTitle(target.sourceChatTitle)}`;

  if (open !== titleState.open) {
    setTitleState({
      open,
      title: open && target !== null ? defaultTitle : titleState.title,
    });
  }
  const title = titleState.title;
  const setTitle = useCallback((nextTitle: string): void => {
    setTitleState((current) => ({ ...current, title: nextTitle }));
  }, []);

  const toolbarStore = useComposerToolbarStore(
    null,
    target?.settingsSeed ?? null,
    null,
    false,
  );
  const modelResolved = useStore(
    toolbarStore,
    (s) => s.selection.modelSlug.length > 0,
  );
  const agentMode = useStore(toolbarStore, (s) => s.agentMode);
  const setAgentMode = useStore(toolbarStore, (s) => s.setAgentMode);
  const modelPickerKey =
    target === null ? "fork-dialog-closed" : forkDialogModelPickerKey(target);
  const trimmedTitle = title.trim();
  const canSubmit =
    target !== null &&
    trimmedTitle.length > 0 &&
    modelResolved &&
    !createChat.isPending;

  const close = useCallback(() => {
    if (createChat.isPending) return;
    onOpenChange(false);
  }, [createChat.isPending, onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && createChat.isPending) return;
      onOpenChange(nextOpen);
    },
    [createChat.isPending, onOpenChange],
  );

  const submit = useCallback(() => {
    if (!canSubmit) return;
    const chatId = uuidv4();
    const hostId = tabHostId;
    const worktreeIntent = readSeededLaunchWorktreeIntent({
      stagingKey,
      fallbackIntent: target.workspaceSeed.intent,
    });
    const workspaceMode = deriveWorkspaceMode(
      target.workspaceSeed.workspace.folders.length,
      worktreeIntent,
    );
    if (worktreeIntent !== null) {
      useWorktreeIntentMemoryStore
        .getState()
        .setEpicIntent(epicId, worktreeIntent, Date.now());
    }
    useWorktreeIntentStagingStore.getState().clear(stagingKey);
    const toolbar = toolbarStore.getState();
    const settings = buildChatRunSettings({
      selection: toolbar.selection,
      permission: toolbar.permission,
      reasoning: toolbar.reasoning,
      serviceTier: toolbar.serviceTier,
      agentMode: toolbar.agentMode,
    });
    createChat.mutate(
      {
        epicId,
        parentId: target.parentId,
        title: trimmedTitle,
        chatId,
        settings,
        workspaceMode,
        worktreeIntent,
        initialMessage: null,
        forkSource: {
          sourceChatId: target.sourceChatId,
          assistantMessageId: target.assistantMessageId,
        },
      },
      {
        onSuccess: (result) => {
          const cancel = openCreatedChatWhenProjectedWithNavigation({
            intent: {
              kind: "active-tile",
              epicId,
              tabId,
              chatId: result.chatId,
              hostId,
            },
            navigateNestedFocus,
          });
          const openCancels = openCancelsRef.current;
          if (openCancels === null) {
            cancel();
          } else {
            openCancels.add(cancel);
          }
          onOpenChange(false);
        },
      },
    );
  }, [
    canSubmit,
    createChat,
    epicId,
    navigateNestedFocus,
    onOpenChange,
    stagingKey,
    tabHostId,
    tabId,
    target,
    toolbarStore,
    trimmedTitle,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(94vw,32rem)] gap-2 sm:max-w-[min(94vw,34rem)]">
        <DialogHeader>
          <DialogTitle>Fork chat</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={titleInputId} className="flex min-w-0 flex-col gap-2">
            <span className="px-0 py-0 font-sans text-overline font-medium uppercase text-muted-foreground/70">
              Title
            </span>
            <Input
              id={titleInputId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              disabled={createChat.isPending}
              aria-label="Fork chat title"
            />
          </label>
          <section className="flex min-w-0 flex-col gap-2">
            <div className="px-0 py-0 font-sans text-overline font-medium uppercase text-muted-foreground/70">
              Harness
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <HarnessModelPicker
                key={modelPickerKey}
                store={toolbarStore}
                withServiceTier
                tuiOnly={false}
                lockedHarnessId={null}
                disabled={createChat.isPending}
                registerActivation={false}
              />
              <div className="shrink-0">
                <AgentModeToggle
                  value={agentMode}
                  disabled={createChat.isPending}
                  showTooltip={false}
                  onChange={setAgentMode}
                />
              </div>
            </div>
          </section>
          <ActiveHostWorkspaceControls
            stagingKey={stagingKey}
            layout="stacked"
            workspaceSeed={target?.workspaceSeed.workspace ?? null}
            seedIntent={target?.workspaceSeed.intent ?? null}
            hostScope={{ kind: "active" }}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={createChat.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {createChat.isPending ? (
              <AgentSpinningDots
                className="text-current"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Fork
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function displayChatTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length === 0 ? "Untitled chat" : trimmed;
}

function forkDialogModelPickerKey(target: ChatForkDialogTarget): string {
  const seed = target.settingsSeed;
  return [
    target.sourceChatId,
    target.assistantMessageId,
    seed.harnessId,
    seed.model,
    seed.permissionMode,
    seed.reasoningEffort ?? "",
    seed.serviceTier ?? "",
    seed.agentMode,
  ].join("\u0000");
}
