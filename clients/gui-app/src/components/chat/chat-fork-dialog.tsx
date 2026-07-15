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
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCreateChatForHost } from "@/hooks/epic/use-epic-chat-mutations";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { openCreatedChatWhenProjectedWithNavigation } from "@/lib/commands/actions/new-chat";
import {
  pendingForkChatStagingKey,
  type WorktreeStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import type { ChatForkMode } from "@/components/chat/chat-message";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import type { SeedIntentOverride } from "@/lib/worktree/worktree-intent-seeding";
import { readSeededLaunchWorkspace } from "@/lib/worktree/seeded-launch-worktree-intent";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";

const activeChatForkWorkspaceOwnerByKey = new Map<string, symbol>();

export interface ChatForkDialogTarget {
  readonly sourceChatId: string;
  readonly sourceChatTitle: string;
  readonly assistantMessageId: string;
  // Q&A forks identify the exact interview block within an assistant row;
  // ordinary message-level forks leave this null and retain the whole row.
  readonly interviewBlockId: string | null;
  readonly parentId: string | null;
  readonly settingsSeed: ChatRunSettings;
  // The full seed (intent + folder snapshot) projected from the source chat's
  // visible workspace. The dialog applies it through the same seedIntent ->
  // seedEntryForFolder path the terminal-agent launcher uses.
  readonly workspaceSeed: ForkWorkspaceSeed;
  /**
   * Pre-selection applied on top of the seed's folders: `"worktree-carry"`
   * for an A/B fork (new worktrees off each folder's working tree, carrying
   * uncommitted + staged changes). `null` seeds the source binding verbatim —
   * a Cross Question fork uses this so the fork lands on the chat's own
   * working copy (local folders stay local, an existing worktree is adopted).
   */
  readonly seedIntentOverride: SeedIntentOverride | null;
  /**
   * What the fork does with questions still pending at the boundary:
   * `"settled"` (Cross Question) closes them as inline reference so the
   * fork's composer is immediately free; `"pending"` (A/B Fork) re-opens them
   * as an answerable card. Sent to the host in `forkSource`.
   */
  readonly carriedInterviews: "pending" | "settled";
  /**
   * The fork mode the user chose; drives presentation defaults (the "Cross
   * Question - …" / "A/B Fork - …" title prefix). The workspace and
   * carried-question behavior ride the dedicated fields above.
   */
  readonly forkMode: ChatForkMode;
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

// Coordinates dialog lifecycle, toolbar state, staged worktree state, seeded-
// profile validation, and the fork mutation in one fixed hook order (mirrors
// terminal-agent-fork-dialog.tsx's identical structure). Splitting this body
// risks hiding the cross-field submit invariants without reducing user-facing
// behavior.
// eslint-disable-next-line complexity
function ChatForkDialogBody(props: ChatForkDialogProps) {
  const { epicId, onOpenChange, open, tabId, target } = props;
  const stagingKey = useMemo(() => pendingForkChatStagingKey(epicId), [epicId]);
  const [titleState, setTitleState] = useState(() => ({ open, title: "" }));
  const titleInputId = useId();
  const tabHostId = useTabHostId();
  // The fork's `createChat` call runs on the TAB's host (see
  // `useEpicCreateChatForHost` -> `useTabHostClient`), so the seeded-profile
  // validation below must read that SAME host's `providers.list`, not the
  // app-wide active host - they can genuinely diverge for a tab bound to a
  // non-default host.
  const tabHostClient = useTabHostClient();
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
    target === null
      ? ""
      : `${forkModeTitlePrefix(target.forkMode)} - ${displayChatTitle(target.sourceChatTitle)}`;

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

  // A fork dialog has no send-time reauth gate of its own (unlike the main
  // composer), so a source chat's profileId that was tombstoned since the
  // chat last ran must be caught before it reaches `createChat`.
  // `useComposerToolbarStore` now validates every seed it receives against
  // the SAME host's live `providers.list` (passing `tabHostClient` here -
  // this fork's `createChat` call runs on the tab's host, per
  // `useEpicCreateChatForHost` -> `useTabHostClient`), so no separate
  // resolution is needed at this call site. Never authoritative (`fallback`/
  // `none`): this dialog has no reauth gate of its own, so a genuinely-
  // tombstoned source profile must be corrected to ambient here rather than
  // silently submitted to `createChat`.
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(target?.settingsSeed ?? null, tabHostClient),
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
  const stagedIntentForKey = useWorktreeIntentStagingStore(
    (state) => state.intentByKey[worktreeStagingKeyString(stagingKey)] ?? null,
  );
  const canSubmit = canSubmitFork({
    target,
    trimmedTitle,
    modelResolved,
    hasStagedPreselection: stagedIntentForKey !== null,
    createPending: createChat.isPending,
  });
  const activeWorkspaceTarget = open ? target : null;

  useEffect(() => {
    if (activeWorkspaceTarget === null) return;
    const stagingKeyId = worktreeStagingKeyString(stagingKey);
    const owner = Symbol(activeWorkspaceTarget.assistantMessageId);
    activeChatForkWorkspaceOwnerByKey.set(stagingKeyId, owner);
    return () => {
      if (activeChatForkWorkspaceOwnerByKey.get(stagingKeyId) !== owner) {
        return;
      }
      activeChatForkWorkspaceOwnerByKey.delete(stagingKeyId);
      clearChatForkWorkspace(stagingKey);
    };
  }, [activeWorkspaceTarget, stagingKey]);

  const close = useCallback(() => {
    if (createChat.isPending) return;
    clearChatForkWorkspace(stagingKey);
    onOpenChange(false);
  }, [createChat.isPending, onOpenChange, stagingKey]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && createChat.isPending) return;
      if (!nextOpen) {
        clearChatForkWorkspace(stagingKey);
      }
      onOpenChange(nextOpen);
    },
    [createChat.isPending, onOpenChange, stagingKey],
  );

  const submit = useCallback(() => {
    if (!canSubmit || target === null) return;
    const chatId = uuidv4();
    const hostId = tabHostId;
    const launchWorkspace = readSeededLaunchWorkspace({
      stagingKey,
      seedIntent: target.workspaceSeed.intent,
      fallbackWorkspace: target.workspaceSeed.workspace,
    });
    const workspaceMode = deriveWorkspaceMode(
      launchWorkspace.folderCount,
      launchWorkspace.worktreeIntent,
    );
    const worktreeIntent = launchWorkspace.worktreeIntent;
    if (worktreeIntent !== null) {
      useWorktreeIntentMemoryStore
        .getState()
        .setEpicIntent(epicId, worktreeIntent, Date.now());
    }
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
          interviewBlockId: target.interviewBlockId,
          carriedInterviews: target.carriedInterviews,
        },
      },
      {
        onSuccess: (result) => {
          clearChatForkWorkspace(stagingKey);
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
                createProfileHostId={tabHostId}
                runTargetHostId={tabHostId}
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
            seedIntentOverride={target?.seedIntentOverride ?? null}
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

function clearChatForkWorkspace(stagingKey: WorktreeStagingKey): void {
  useWorktreeIntentStagingStore.getState().clear(stagingKey);
  useSeededWorkspaceSnapshotStore.getState().clear(stagingKey);
}

function displayChatTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length === 0 ? "Untitled chat" : trimmed;
}

// Whether the Fork dialog can submit. Extracted from the component to keep its
// cyclomatic complexity down. An A/B fork's workspace pre-selection is staged
// asynchronously by the picker (it needs the folder summaries round-trip);
// submitting before it lands would fall back to the source binding verbatim —
// silently adopting the origin worktree instead of creating a new one (wrong
// working copy, no setup script). So an override fork waits for the staged
// pre-selection; verbatim (plain / cross-question) forks need no gate.
function canSubmitFork(input: {
  readonly target: ChatForkDialogTarget | null;
  readonly trimmedTitle: string;
  readonly modelResolved: boolean;
  readonly hasStagedPreselection: boolean;
  readonly createPending: boolean;
}): boolean {
  if (input.target === null) return false;
  if (input.trimmedTitle.length === 0) return false;
  if (!input.modelResolved) return false;
  if (input.createPending) return false;
  if (
    input.target.seedIntentOverride !== null &&
    !input.hasStagedPreselection
  ) {
    return false;
  }
  return true;
}

function forkModeTitlePrefix(mode: ChatForkMode): string {
  if (mode === "cross-question") return "Cross Question";
  if (mode === "ab-worktree") return "A/B Fork";
  return "Fork";
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
    seed.profileId ?? "",
  ].join("\u0000");
}
