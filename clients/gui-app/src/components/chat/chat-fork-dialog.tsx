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
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useFocusedPaneModalOpen } from "@/components/epic-tabs/pane-visibility-context";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import { useCloneSourceOwnerUserId } from "@/hooks/chats/use-clone-source-owner";
import { useChatPublicationState } from "@/hooks/chats/use-chat-publication-state-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostClient } from "@/lib/host";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { openCreatedChatWhenProjectedWithNavigation } from "@/lib/commands/actions/new-chat";
import {
  pendingForkChatStagingKey,
  type WorktreeStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { clearChatForkWorkspace } from "@/lib/worktree/chat-fork-workspace-staging";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import type { ChatForkMode } from "@/components/chat/chat-message";
import {
  chatForkHostRefusals,
  chatForkTargetSupport,
  chatForkRemoteClassState,
  chatForkTargetVerdict,
  remoteClassIsUnreachable,
  remoteClassNotice,
  verdictAllowsSubmit,
  type ChatForkTargetVerdict,
  CROSS_HOST_CARRY_CHANGES_NOTICE,
  CROSS_HOST_SHALLOW_FORK_NOTICE,
  CROSS_HOST_WORKSPACE_NOTICE,
  type ChatForkTargetSupport,
} from "@/components/chat/chat-fork-target";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import type { SeedIntentOverride } from "@/lib/worktree/worktree-intent-seeding";
import { readSeededLaunchWorkspace } from "@/lib/worktree/seeded-launch-worktree-intent";
import {
  emptyLandingDraftWorkspaceSnapshot,
  type LandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";

const activeChatForkWorkspaceOwnerByKey = new Map<string, symbol>();

/**
 * The seed for a cross-host target this dialog has not retained a workspace for
 * yet. One shared instance on purpose: the picker keys its re-seed on identity,
 * and every host with nothing staged has the same nothing to show.
 */
const EMPTY_CROSS_HOST_WORKSPACE: LandingDraftWorkspaceSnapshot =
  emptyLandingDraftWorkspaceSnapshot();

/**
 * The scratch slots one open fork dialog owns.
 *
 * There is one per target host now (see `pendingForkChatStagingKey`), so a
 * dialog that retargets picks up slots as it goes and has to give all of them
 * back when it closes — not just the one it happens to be sitting on. The owner
 * symbol is what keeps a closing dialog from clearing a slot a second dialog
 * (another tile, another split pane) has since claimed.
 */
interface ForkWorkspaceStagingSession {
  readonly owner: symbol;
  readonly touched: Map<string, WorktreeStagingKey>;
}

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
  /**
   * The host the picker starts on when the dialog opens: the host the user
   * picked in the gesture that opened it (the composer's host switcher), or
   * `null` to start on the source chat's own (tab) host — every per-message
   * fork entry point. A preselection is a starting point only; the user can
   * still retarget inside the dialog, and every cross-host gate (build
   * version, publication) applies to it exactly as to a hand-picked host.
   */
  readonly initialHostId: string | null;
}

interface ChatForkDialogProps {
  readonly open: boolean;
  readonly target: ChatForkDialogTarget | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function ChatForkDialog(props: ChatForkDialogProps) {
  const presentedOpen = useFocusedPaneModalOpen(props.open);
  // The dialog stays mounted per chat tile; gate the toolbar store's catalog
  // queries on `presentedOpen` - open AND pane-focused - so a closed dialog,
  // or one belonging to a background split pane, holds no harness/model
  // subscription (the same semantics the old `activityEnabled` flag carried).
  return (
    <SurfaceActivityProvider active={presentedOpen}>
      <ChatForkDialogBody {...props} />
    </SurfaceActivityProvider>
  );
}

// Coordinates dialog lifecycle, the dialog-local target host, toolbar state,
// staged worktree state, seeded-profile validation, and the fork mutation in
// one fixed hook order (mirrors terminal-agent-fork-dialog.tsx's identical
// structure). Splitting this body risks hiding the cross-field submit
// invariants without reducing user-facing behavior.
// eslint-disable-next-line complexity
function ChatForkDialogBody(props: ChatForkDialogProps) {
  const { epicId, onOpenChange, open, tabId, target } = props;
  const activityEnabled = useSurfaceActivity();
  const titleInputId = useId();
  // The host the SOURCE chat lives on. It seeds the picker and is the one host
  // a fork can always be served by, since a same-host fork needs no cross-host
  // contract from the target at all.
  const tabHostId = useTabHostId();
  const [dialogState, setDialogState] = useState(() => ({
    open,
    title: "",
    hostId: tabHostId,
  }));
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  const openCancelsRef = useRef<Set<() => void> | null>(null);
  const stagingSessionRef = useRef<ForkWorkspaceStagingSession | null>(null);

  useEffect(() => {
    const openCancels = new Set<() => void>();
    openCancelsRef.current = openCancels;
    return () => {
      for (const cancel of openCancels) cancel();
      openCancels.clear();
      openCancelsRef.current = null;
    };
  }, []);

  // The rare case where the source itself is still untitled: there is no name
  // to inherit, so the dialog defaults to EMPTY instead of baking the
  // "Untitled agent" render fallback into a permanent stored title. An empty
  // submit stores "" and the fork is AI-titled from its first message, same
  // as the automatic fork paths; the input's placeholder says what happens.
  const sourceUntitled =
    target !== null && target.sourceChatTitle.trim().length === 0;
  const defaultTitle =
    target === null || sourceUntitled
      ? ""
      : `${forkModeTitlePrefix(target.forkMode)} - ${displayChatTitle(target.sourceChatTitle)}`;

  // Opening resets BOTH the title and the target host: a dialog reopened on a
  // different message must not inherit the last fork's machine any more than it
  // inherits the last fork's name. A target carrying an `initialHostId` (the
  // host-switch gesture) starts on that host instead of the tab's.
  if (open !== dialogState.open) {
    setDialogState({
      open,
      title: open && target !== null ? defaultTitle : dialogState.title,
      hostId: open ? (target?.initialHostId ?? tabHostId) : dialogState.hostId,
    });
  }
  const title = dialogState.title;
  const selectedHostId = dialogState.hostId;
  const setTitle = useCallback((nextTitle: string): void => {
    setDialogState((current) => ({ ...current, title: nextTitle }));
  }, []);
  const selectHostId = useCallback((nextHostId: string): void => {
    setDialogState((current) => ({ ...current, hostId: nextHostId }));
  }, []);
  // A cross-host fork is a different operation: it cannot carry the source
  // machine's working tree, its folder paths, or the provider's on-disk
  // session. Everything below that changes shape keys on this one fact.
  const isCrossHost = selectedHostId !== tabHostId;
  // The target only exists as far as this dialog is concerned while it is
  // OPEN. `target` outlives a close (the opener keeps the last one), so every
  // read that costs something - the owner resolution's cloud-chat list, the
  // staging-slot ownership below - hangs off this rather than off `target`,
  // which would leave a closed dialog holding a query per chat tile.
  const activeWorkspaceTarget = open ? target : null;

  // EVERY host-derived read in this dialog hangs off this one client - the
  // create call, the harness/model catalog, seeded-profile validation, folder
  // resolution and worktree metadata - so a fork can never be configured
  // against one machine and submitted to another. It is resolved from the
  // dialog's OWN selection and never from the app-wide active host: routing the
  // picker through `directory.selectById` is what made choosing a host here
  // silently rebind the whole window while the fork still went to the tab's
  // host.
  const selectedHostClient = useHostClientForHostId(selectedHostId);
  const createChat = useEpicCreateChatForHostClient(selectedHostClient);
  const stagingKey = useMemo(
    () => pendingForkChatStagingKey(selectedHostId, epicId),
    [epicId, selectedHostId],
  );

  // Host rows are gated on the target's negotiated `epic.createChat` minor: a
  // same-major downgrade Zod-strips the cross-host owner hint in silence, so a
  // build that predates it would take the fork and quietly lose the transcript.
  // The directory is the right list to ask about - a host with no directory
  // entry has no route this client can dial, and its row is already inert for
  // that reason rather than for its build.
  const directoryList = useHostDirectoryList();
  const directoryHostIds = useMemo(
    () => (directoryList.data ?? []).map((entry) => entry.hostId),
    [directoryList.data],
  );
  const createChatVersions = useHostNegotiatedMethodVersions(
    directoryHostIds,
    "epic.createChat",
  );
  const hostRefusals = useMemo(
    () =>
      chatForkHostRefusals({
        versionByHostId: createChatVersions,
        sourceHostId: tabHostId,
      }),
    [createChatVersions, tabHostId],
  );
  // Asked again for the SELECTED host rather than read off the map: the map
  // exempts the source host (a same-host fork needs no contract), and a host
  // picked before its first handshake is `unknown` here — permissive, and it
  // resolves itself once its client answers anything at all.
  const selectedHostSupport: ChatForkTargetSupport = isCrossHost
    ? chatForkTargetSupport(createChatVersions.get(selectedHostId) ?? null)
    : { kind: "supported" };

  // Is there any host this fork could go to OTHER than the source? Read from
  // the same directory the version gate uses: a host with no directory entry
  // has no route this client can dial, so it is not a fork target either.
  const hasRemoteHostOption = useMemo(
    () => directoryHostIds.some((hostId) => hostId !== tabHostId),
    [directoryHostIds, tabHostId],
  );
  // Layer 1: does the SOURCE chat's publication let ANY remote host serve this
  // fork? Read through the TAB client, which addresses the owning host by
  // construction - the dialog lives inside the source chat's tile - so this is
  // one fresh RPC on a connection already held, never a replicated value.
  //
  // It is deliberately NOT part of `hostRefusals`: publication is a fact about
  // the chat, identical for every remote row and unchanged by picking a
  // different machine. Routing it through the per-row refusal seam would stamp
  // one chat problem onto four hosts and invite a retry that cannot help.
  const tabHostClient = useTabHostClient();
  const publication = useChatPublicationState({
    client: tabHostClient,
    hostId: tabHostId,
    epicId,
    chatId: activeWorkspaceTarget?.sourceChatId ?? null,
    boundaryMessageId: activeWorkspaceTarget?.assistantMessageId ?? null,
    // Asked on OPEN, not on selection.
    //
    // Publication is a fact about the SOURCE CHAT, so gating the read on
    // whether a cross-host target is currently highlighted would key it to a
    // different subject entirely. The cost of that mismatch is user-visible and
    // worse than latency: the user picks host B and only THEN do the rows go
    // inert with a notice, which reads as "my click broke it". The answer is
    // knowable the moment the dialog opens and should be true on first paint,
    // so nobody reaches for a host that could never have worked.
    //
    // Still not unconditional: an account with no remote host has no row this
    // could gate, so asking would be pure waste for the single-host case. One
    // RPC on a surface that already issues catalog and profile reads on open.
    enabled: activeWorkspaceTarget !== null && hasRemoteHostOption,
  });
  // ONE verdict from BOTH gates, so the nine (version x publication) cells and
  // their precedence live in one place instead of at each render site.
  const targetVerdict: ChatForkTargetVerdict = chatForkTargetVerdict({
    isCrossHost,
    version: createChatVersions.get(selectedHostId) ?? null,
    publication,
  });
  // Read from the CLASS resolver, not from the selection verdict: publication
  // is a fact about the source chat, so it must be true on first paint rather
  // than waiting for the user to highlight a remote host. Deriving it from the
  // selected target is what made picking a host look like the thing that broke
  // the picker - the read was moved to dialog open, but the presentation was
  // still keyed to the selection.
  const remoteClass = chatForkRemoteClassState(publication);
  const publicationNotice = remoteClassNotice(remoteClass);
  // The remote CLASS goes unselectable on the DURABLE answers - a chat that has
  // never been published, and one the host has called definitively over - since
  // no remote host can serve either, while the rows themselves stay silent. A
  // boundary that is merely still syncing is not one of them: it blocks submit
  // but keeps the rows live, because the wait is seconds long and the rows are
  // where the fork is configured meanwhile.
  const remoteRowsUnselectable = remoteClassIsUnreachable(remoteClass);

  // A REFUSAL parks this dialog's host reads, which is the one consumer shape
  // the manifest registry cannot heal on its own.
  //
  // The registry is written only by a completed handshake and never cleared, so
  // a stale verdict normally dies on the surface's next RPC. Here there is no
  // next RPC: the refusal disables create, the cross-host workspace is empty so
  // folder resolution is disabled, and the toolbar's provider read and model
  // catalogs answer from cache. A host upgraded in place under the same id
  // would keep its "needs update" row for the whole session while the update it
  // is asking for has already happened. This is exactly the deadlock
  // `negotiated-manifest-registry.ts` documents, and the probe is the mechanism
  // it names: one bounded read of a released-floor method, re-issued when the
  // host's own incarnation changes, purely so the transport records a fresh
  // manifest as a side effect. The response is deliberately unused.
  // Every candidate whose verdict is not already `supported` — NOT just the
  // selected one.
  //
  // A refused row is `aria-disabled` (`isHostOptionSelectable` requires an
  // `available` surface state), so picking it is not a way it becomes
  // `selectedHostId` — the one way in is a host-switch preselection
  // (`initialHostId`), which this probe set covers just the same. A probe
  // gated on the selected host's refusal would still be wrong for the picked
  // case: it could only ever re-ask about the source host, while the target
  // wearing the "needs update" word is precisely the one it never touches.
  // Updating that host in place would leave its verdict stale indefinitely,
  // because the reads that would re-handshake are the ones its own refusal
  // turned off — the deadlock `use-host-capability-probe.ts` documents, arrived
  // at from the other side.
  //
  // `unknown` is included as well as `refused`, and that is what keeps a
  // cached-`supported` host honest too: a target rolled back or reinstalled at
  // an older build under the same `hostId` changes the version the directory
  // reports, which is part of each probe's incarnation, so the re-handshake
  // happens on the incarnation change rather than waiting for `epic.createChat`
  // itself to discover the downgrade.
  //
  // The source host is exempt for the same reason it is exempt from
  // `hostRefusals`: a same-host fork needs no V12 at all.
  const capabilityProbeEntries = useMemo(
    () =>
      (directoryList.data ?? []).filter(
        (entry) =>
          entry.hostId !== tabHostId &&
          chatForkTargetSupport(createChatVersions.get(entry.hostId) ?? null)
            .kind !== "supported",
      ),
    [createChatVersions, directoryList.data, tabHostId],
  );

  // A fork dialog has no send-time reauth gate of its own (unlike the main
  // composer), so a source chat's profileId that was tombstoned since the
  // chat last ran must be caught before it reaches `createChat` - and a
  // cross-host fork widens that from "tombstoned" to "never existed on this
  // machine". `useComposerToolbarStore` validates every seed it receives
  // against the SELECTED host's live `providers.list` and corrects a dead
  // profile to ambient, and reads the harness/model catalog through the same
  // client, so the fork offers the target host's harnesses and models.
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(target?.settingsSeed ?? null, selectedHostClient),
    null,
    // `hostId` is the same target host as `hostClient` - the SELECTED host,
    // not the tab's. The per-host last-used buckets it keys describe the
    // machine the fork will run on, so a cross-host fork must read and write
    // the target's bucket, never the source tab's.
    { hostClient: selectedHostClient, hostId: selectedHostId, tuiOnly: false },
  );
  // Cross-host asks the STRONGER question, and only cross-host.
  //
  // The toolbar store retains the previous host's slug across a retarget while
  // the new target's harness/model queries load, so a bare slug-length check
  // leaves Fork enabled long enough to submit a model the selected host may not
  // provide. `selectionCatalogConfirmed` is false until the catalog for this
  // `catalog.hostId` actually covers the resolved slug.
  //
  // Same-host keeps the length check every sibling surface uses (the composer's
  // own Send, `terminal-agent-fork-dialog`), because there the slug came from
  // THIS host's memory and the memory write gate is itself
  // `selectionCatalogConfirmed` - a persisted slug was catalog-confirmed when it
  // was recorded. Applying the strong form here too would buy nothing and cost
  // real availability: the flag also goes false on an UNLOAD (the models query
  // detaches, `modelsLoaded: false`), so a transient detach would disable a
  // same-host fork with nothing on screen to explain it and no action that
  // reopens it. Cross-host has a producer for that state - pick another host -
  // and a host whose catalog cannot be read is one this fork should not target.
  const catalogConfirmed = useStore(
    toolbarStore,
    (s) => s.selectionCatalogConfirmed,
  );
  const modelSlugPresent = useStore(
    toolbarStore,
    (s) => s.selection.modelSlug.length > 0,
  );
  const modelResolved = isCrossHost ? catalogConfirmed : modelSlugPresent;
  const modelPickerKey =
    target === null
      ? "fork-dialog-closed"
      : forkDialogModelPickerKey(target, selectedHostId);
  const trimmedTitle = title.trim();
  const stagedIntentForKey = useWorktreeIntentStagingStore(
    (state) => state.intentByKey[worktreeStagingKeyString(stagingKey)] ?? null,
  );
  // The owner this dialog is RENDERING for the source chat - the host's
  // anti-squatting expectation when it holds no registry facts of its own,
  // which is exactly the cross-host case. Read through the app-wide client so
  // it shares the cloud-chat list's query key with the sidebar and tab group;
  // `null` when this client genuinely does not know, never a guess, because the
  // host TRUSTS a value it is given.
  const appWideClient = useHostClient();
  const sourceOwnerUserId = useCloneSourceOwnerUserId({
    client: appWideClient,
    epicId,
    chatId: activeWorkspaceTarget?.sourceChatId ?? null,
  });
  // Cross-host, the workspace section resets to the target's own folder catalog
  // with NO seed: the source chat's paths name directories on another machine,
  // and submitting them would hand host B a tree it does not have.
  //
  // An EMPTY snapshot, not `null`: `null` drops the picker onto the app-wide
  // global folder store (`useHomeWorkspaceSource`'s `usingSeededWorkspace`
  // conjunct), which is the source machine's folder list AND shared app state
  // this dialog has no business editing.
  //
  // The seed is READ BACK from the host-scoped snapshot store first, for EVERY
  // target including the source host. That store already retains exactly this
  // per (epic, host) — it is what `useHomeWorkspaceSource` mirrors its live
  // folder state into, and what the staging session clears on close — so what a
  // return to a host restores is that host's actual FOLDERS, not merely a
  // stable identity.
  //
  // Retention has to be uniform, and the seeding rule below is only the
  // FALLBACK for a host nothing has been staged against yet. A `useMemo`
  // cannot do this job and a shared constant cannot either: the picker
  // re-seeds on the seed's IDENTITY, so a memo (single-slot, recomputed on
  // every dependency change) hands a host a *new* empty object each time the
  // user comes back to it — B -> C -> B would reset B's live workspace and
  // overwrite its snapshot with the empty one, silently deleting folders B
  // already had — while one shared constant fails the opposite way, letting
  // B's folders ride into C.
  //
  // Splitting the rule so only cross-host targets retained would have made
  // A -> B -> A discard edits the user made on A while B kept its own, and
  // would have left the session invariant below ("switching back returns to
  // the picks you made there") true of most hosts rather than all of them.
  // Re-deriving the source host's seed on every return buys nothing to pay for
  // that: the source chat's workspace does not meaningfully change during the
  // seconds this dialog is open, so it fetches nothing fresher and only
  // discards the user's input.
  //
  // `EMPTY_CROSS_HOST_WORKSPACE` is safe to share across hosts precisely
  // because it is only ever the seed for a host with nothing retained, and
  // "nothing" is the same value on every machine.
  const retainedWorkspace = useSeededWorkspaceSnapshotStore(
    (state) =>
      state.snapshotByKey[worktreeStagingKeyString(stagingKey)] ?? null,
  );
  const workspaceSeed: LandingDraftWorkspaceSnapshot | null =
    retainedWorkspace ??
    (isCrossHost
      ? EMPTY_CROSS_HOST_WORKSPACE
      : (target?.workspaceSeed.workspace ?? null));
  const seedIntent = isCrossHost
    ? null
    : (target?.workspaceSeed.intent ?? null);
  // "Carry changes" is withdrawn cross-host rather than reinterpreted: the
  // uncommitted work it forks off lives on the source machine's disk.
  const seedIntentOverride = isCrossHost
    ? null
    : (target?.seedIntentOverride ?? null);
  const canSubmit = canSubmitFork({
    target,
    trimmedTitle,
    sourceUntitled,
    modelResolved,
    hasStagedPreselection: stagedIntentForKey !== null,
    createPending: createChat.isPending,
    hostClientResolved: selectedHostClient !== null,
    // Not a host-build fact any more, and the name says so. This one boolean
    // now carries the SOURCE CHAT's publication too - a frozen publication and
    // a boundary the published head does not cover both hold Fork shut, the
    // second of them transiently and with a poll lane behind it that reopens
    // the button on its own.
    verdictAllowsSubmit: verdictAllowsSubmit(targetVerdict),
    // The A/B pre-selection gate waits for a staging round-trip that only
    // happens when there IS a seed to override. Cross-host there is none, so
    // keeping the gate would leave Fork permanently disabled.
    requiresStagedPreselection:
      target !== null && target.seedIntentOverride !== null && !isCrossHost,
  });

  // A new fork target is a new question, so it must not inherit the previous
  // one's answer. `reset` is constructor-bound on the mutation observer and the
  // observer is held in state, so this is a stable reference and the effect
  // runs on a genuine target change rather than on every render.
  const resetCreateChat = createChat.reset;
  useEffect(() => {
    resetCreateChat();
  }, [activeWorkspaceTarget, resetCreateChat]);

  // One session per open dialog: it owns every per-host scratch slot the dialog
  // stages into, and hands them all back together.
  useEffect(() => {
    if (activeWorkspaceTarget === null) return;
    const session: ForkWorkspaceStagingSession = {
      owner: Symbol(activeWorkspaceTarget.assistantMessageId),
      touched: new Map(),
    };
    stagingSessionRef.current = session;
    return () => {
      stagingSessionRef.current = null;
      releaseForkWorkspaceSession(session);
    };
  }, [activeWorkspaceTarget]);

  // Claim the selected host's slot as the dialog moves onto it. Retargeting
  // does NOT clear the slot being left: each host keeps its own staged folders
  // for as long as this dialog is open, which — together with the uniform
  // snapshot read above, on which this claim depends — is what makes switching
  // back return to the picks you made there, on every host and not merely on
  // the ones this dialog reached second.
  useEffect(() => {
    const session = stagingSessionRef.current;
    if (session === null) return;
    const stagingKeyId = worktreeStagingKeyString(stagingKey);
    session.touched.set(stagingKeyId, stagingKey);
    activeChatForkWorkspaceOwnerByKey.set(stagingKeyId, session.owner);
  }, [activeWorkspaceTarget, stagingKey]);

  const clearForkWorkspaces = useCallback((): void => {
    const session = stagingSessionRef.current;
    if (session === null) return;
    releaseForkWorkspaceSession(session);
  }, []);

  const close = useCallback(() => {
    if (createChat.isPending) return;
    clearForkWorkspaces();
    onOpenChange(false);
  }, [clearForkWorkspaces, createChat.isPending, onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && createChat.isPending) return;
      if (!nextOpen) {
        clearForkWorkspaces();
      }
      onOpenChange(nextOpen);
    },
    [clearForkWorkspaces, createChat.isPending, onOpenChange],
  );

  const submit = useCallback(() => {
    if (!canSubmit || target === null) return;
    // Read back from the CLIENT, not from the picker's state: the request's
    // `hostId` and the machine it travels to have to be the same fact, which is
    // the invariant `useEpicCreateChatForHostClient`'s preflight enforces.
    const hostId = selectedHostClient?.getActiveHostId() ?? null;
    if (hostId === null) return;
    const chatId = uuidv4();
    const launchWorkspace = readSeededLaunchWorkspace({
      stagingKey,
      seedIntent,
      // The same snapshot the picker was given, so a cross-host submit that
      // never touched the folder rows resolves to the empty workspace rather
      // than falling through to this machine's global folder list.
      fallbackWorkspace: workspaceSeed,
      // The launch host, so the global fallback below this one reads the
      // TARGET machine's folder bucket. Folder paths are host-local; the
      // source tab's bucket would seed paths that need not exist there.
      hostId,
    });
    const workspaceMode = deriveWorkspaceMode(
      launchWorkspace.folderCount,
      launchWorkspace.worktreeIntent,
    );
    const worktreeIntent = launchWorkspace.worktreeIntent;
    // Same-host only. The per-epic memory is keyed by workspace PATH and holds
    // no host of its own, so remembering a cross-host pick would offer another
    // machine's branch/worktree choice to any later surface on this one that
    // happens to have a folder at the same absolute path - two checkouts under
    // the same `/home/user/project` is not an exotic case. The memory is a
    // convenience; carrying one machine's answer onto another is not a trade
    // worth making for it.
    if (worktreeIntent !== null && !isCrossHost) {
      useWorktreeIntentMemoryStore
        .getState()
        .setEpicIntent(epicId, hostId, worktreeIntent, Date.now());
    }
    const toolbar = toolbarStore.getState();
    const settings = buildChatRunSettings({
      selection: toolbar.selection,
      permission: toolbar.permission,
      reasoning: toolbar.reasoning,
      serviceTier: toolbar.serviceTier,
    });
    createChat.mutate(
      {
        epicId,
        // The host the user picked in THIS dialog, which is the machine the
        // fork is created on and the one the forked chat is bound to for life.
        hostId,
        parentId: target.parentId,
        title: trimmedTitle,
        chatId,
        settings,
        workspaceMode,
        worktreeIntent,
        initialMessage: null,
        forkSource: {
          boundary: "assistantMessage",
          sourceChatId: target.sourceChatId,
          assistantMessageId: target.assistantMessageId,
          interviewBlockId: target.interviewBlockId,
          carriedInterviews: target.carriedInterviews,
          // The owner this dialog renders for the source chat (V12's hint), or
          // `null` when it does not know. A target host with no registry facts
          // of its own - the cross-host case - has nothing else to check the
          // cloud publication's owner against, and treats a supplied value as
          // the expectation, so it must never be invented.
          sourceOwnerUserId,
        },
      },
      {
        onSuccess: (result) => {
          Analytics.getInstance().track(AnalyticsEvent.ChatForked, {
            source: "direct_ui",
            include_history: true,
          });
          clearForkWorkspaces();
          const cancel = openCreatedChatWhenProjectedWithNavigation({
            intent: {
              kind: "active-tile",
              epicId,
              tabId,
              chatId: result.chatId,
              // The host the fork was actually created on. Binding the new tab
              // to the ACTIVE host instead would leave it addressing a machine
              // that has never heard of this chat, and waiting out the whole
              // cross-host replication before anything appeared.
              hostId,
              source: "direct_ui",
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
    clearForkWorkspaces,
    createChat,
    epicId,
    navigateNestedFocus,
    onOpenChange,
    seedIntent,
    selectedHostClient,
    sourceOwnerUserId,
    stagingKey,
    tabId,
    target,
    toolbarStore,
    trimmedTitle,
    workspaceSeed,
    isCrossHost,
  ]);
  usePrimaryActionShortcut(activityEnabled, submit);

  const workspaceHostScope = useMemo<HostWorkspaceControlsHostScope>(
    () => ({
      kind: "selected",
      hostId: selectedHostId,
      hostClient: selectedHostClient,
      onSelect: selectHostId,
      refusalByHostId: hostRefusals,
      // The remote CLASS, not a per-row word: an unpublished or definitively
      // unavailable source chat is one fact about the chat, so the rows stay
      // silent and the dialog says it once below. `sourceHostId` is what tells
      // the picker which row is exempt — a same-host fork needs no publication
      // at all.
      unselectableExceptHostId: remoteRowsUnselectable ? tabHostId : null,
    }),
    [
      hostRefusals,
      remoteRowsUnselectable,
      selectHostId,
      selectedHostClient,
      selectedHostId,
      tabHostId,
    ],
  );

  // The retry prompt belongs to the REQUEST that was refused, not to the dialog.
  //
  // `ChatForkDialogBody` stays mounted for the life of the chat tile and the
  // mutation key is constant, so `error` and `variables` outlive every
  // transition this ticket made variable: retargeting to another host, and
  // reopening the dialog on a different assistant message. Scoping by host
  // alone fixed the first and left the second — turn M1's refusal rendering as
  // "M2 is still syncing" before M2 had been attempted at all. So the notice
  // asks the whole question: does the retained failure describe a request for
  // exactly the (host, source chat, boundary) currently on screen?
  //
  // The mutation is also reset when the dialog moves to a new target below, so
  // a fresh session never opens holding a previous one's evidence.
  const failedForkSource = createChat.variables?.forkSource ?? null;
  const boundaryNotPublished =
    createChat.error?.code === "E_FORK_BOUNDARY_NOT_PUBLISHED" &&
    createChat.variables?.hostId === selectedHostId &&
    failedForkSource?.boundary === "assistantMessage" &&
    failedForkSource.sourceChatId === target?.sourceChatId &&
    failedForkSource.assistantMessageId === target.assistantMessageId;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="w-[min(94vw,32rem)] gap-2 sm:max-w-[min(94vw,34rem)]"
        // Same portal rule as the worktree pickers: the host switcher's list
        // mounts outside this dialog, so a click in it reads as an interaction
        // from outside. Dismissing on that would throw away the form someone is
        // in the middle of filling, for the crime of choosing a host in it.
        onInteractOutside={(event) => {
          if (isHostSwitcherListInteraction(event.target)) {
            event.preventDefault();
          }
        }}
      >
        {/*
          Mounted INSIDE `DialogContent` so the probes live exactly as long as
          the dialog is on screen. `selectedHostId` and this body both survive a
          close, so hanging the reads off either would leave one mounted per chat
          tile for a dialog nobody is looking at.
        */}
        {capabilityProbeEntries.map((entry) => (
          <ChatForkHostCapabilityProbe key={entry.hostId} entry={entry} />
        ))}
        <DialogHeader>
          <DialogTitle>Fork agent</DialogTitle>
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
              aria-label="Fork agent title"
              placeholder={sourceUntitled ? "Untitled agent" : ""}
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
                createProfileHostId={selectedHostId}
                runTargetHostId={selectedHostId}
                profileAdmission={null}
              />
            </div>
          </section>
          <ActiveHostWorkspaceControls
            // Locked while the create is in flight, like every other control in
            // this dialog. The host picker is LIVE here (`kind: "selected"`), so
            // an unlocked retarget would move `selectedHostId` out from under a
            // request already dispatched to the previous client - and the
            // refusal notice below, which asks whether the retained failure
            // describes the target currently on screen, would then answer "no"
            // and render nothing at all. The user would see the fork fail
            // silently.
            disabled={createChat.isPending}
            stagingKey={stagingKey}
            layout="stacked"
            workspaceSeed={workspaceSeed}
            seedIntent={seedIntent}
            seedIntentOverride={seedIntentOverride}
            hostScope={workspaceHostScope}
          />
          <ChatForkTargetNotices
            isCrossHost={isCrossHost}
            carriesChanges={
              target !== null && target.seedIntentOverride !== null
            }
            support={selectedHostSupport}
            boundaryNotPublished={boundaryNotPublished}
            publicationNotice={publicationNotice}
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
          <Button
            type="button"
            aria-label="Fork"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={!canSubmit}
            onClick={submit}
          >
            {createChat.isPending ? (
              <AgentSpinningDots
                className="text-current"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Fork
            <PrimaryActionShortcutHint />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything the dialog has to SAY about the target it is pointed at: what a
 * cross-host fork gives up, why a host row is refused, and the one refusal that
 * is a "try again in a moment" rather than a failure.
 *
 * Grouped in one place under the workspace section because they are all answers
 * to the same question — what happens if I press Fork now — and because a
 * cross-host fork can legitimately show several at once.
 */
function ChatForkTargetNotices(props: {
  readonly isCrossHost: boolean;
  /**
   * The Layer-1 sentence about the SOURCE CHAT, rendered once for the whole
   * dialog rather than per host row — see `chatForkTargetVerdict`.
   */
  readonly publicationNotice: string | null;
  /** The chosen fork mode forks off the source working tree ("A/B Fork"). */
  readonly carriesChanges: boolean;
  readonly support: ChatForkTargetSupport;
  readonly boundaryNotPublished: boolean;
}) {
  const { support } = props;
  if (
    !props.isCrossHost &&
    !props.boundaryNotPublished &&
    props.publicationNotice === null
  ) {
    return null;
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="chat-fork-target-notices"
    >
      {props.publicationNotice === null ? null : (
        <p
          className="text-ui-xs text-foreground/80"
          data-testid="chat-fork-publication-notice"
        >
          {props.publicationNotice}
        </p>
      )}
      {props.boundaryNotPublished ? (
        <p
          className="text-ui-xs text-foreground/80"
          data-testid="chat-fork-boundary-not-published"
        >
          Still syncing this turn to the cloud — retry shortly.
        </p>
      ) : null}
      {support.kind === "refused" ? (
        <p
          className="text-ui-xs text-foreground/80"
          data-testid="chat-fork-target-refused"
        >
          {support.detail}
        </p>
      ) : null}
      {props.isCrossHost ? (
        <p className="text-ui-xs text-muted-foreground">
          {CROSS_HOST_WORKSPACE_NOTICE}
        </p>
      ) : null}
      {props.isCrossHost && props.carriesChanges ? (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="chat-fork-carry-changes-disabled"
        >
          {CROSS_HOST_CARRY_CHANGES_NOTICE}
        </p>
      ) : null}
      {props.isCrossHost ? (
        <p className="text-ui-xs text-muted-foreground">
          {CROSS_HOST_SHALLOW_FORK_NOTICE}
        </p>
      ) : null}
    </div>
  );
}

function releaseForkWorkspaceSession(
  session: ForkWorkspaceStagingSession,
): void {
  for (const [stagingKeyId, stagingKey] of session.touched) {
    // A slot a LATER dialog has claimed is that dialog's to clear. Without this
    // check a background tile closing its fork dialog would wipe the folders
    // someone is choosing in the foreground one.
    if (activeChatForkWorkspaceOwnerByKey.get(stagingKeyId) !== session.owner) {
      continue;
    }
    activeChatForkWorkspaceOwnerByKey.delete(stagingKeyId);
    clearChatForkWorkspace(stagingKey);
  }
  session.touched.clear();
}

function displayChatTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length === 0 ? "Untitled agent" : trimmed;
}

// Whether the Fork dialog can submit. Extracted from the component to keep its
// cyclomatic complexity down. An A/B fork's workspace pre-selection is staged
// asynchronously by the picker (it needs the folder summaries round-trip);
// submitting before it lands would fall back to the source binding verbatim —
// silently adopting the origin worktree instead of creating a new one (wrong
// working copy, no setup script). So an override fork waits for the staged
// pre-selection; verbatim (plain / cross-question) forks need no gate, and
// neither does a cross-host fork, which has no seed to override in the first
// place (see `requiresStagedPreselection`).
/**
 * One mounted capability probe for one host the dialog cannot select.
 *
 * A component rather than a loop because `useHostClientForHostId` and
 * `useHostCapabilityProbe` are hooks: mounting one of these per candidate is the
 * only way to hold N clients at once, and it makes the candidate set itself the
 * gate — a host that becomes `supported` stops being rendered, which unmounts
 * its read. `useHostQueries` is not an alternative here; it batches N requests
 * to ONE client, and this needs one request to each of N clients.
 *
 * Renders nothing. The handshake the read provokes is the entire point, exactly
 * as `use-host-capability-probe.ts` describes — the response is unused.
 */
function ChatForkHostCapabilityProbe(props: {
  readonly entry: HostDirectoryEntry;
}): null {
  const client = useHostClientForHostId(props.entry.hostId);
  useHostCapabilityProbe({
    client,
    // Unconditional: this component is only rendered for a host whose verdict is
    // not `supported`, so being mounted IS the staleness condition.
    stale: true,
    incarnation: [
      props.entry.hostId,
      props.entry.version,
      props.entry.transportDialability,
    ],
  });
  return null;
}

function canSubmitFork(input: {
  readonly target: ChatForkDialogTarget | null;
  readonly trimmedTitle: string;
  /** The source chat's stored title is empty - the one case an empty title
   *  field may submit: it stores "" and the fork is AI-titled on its first
   *  send, instead of freezing the "Untitled agent" render fallback. */
  readonly sourceUntitled: boolean;
  readonly modelResolved: boolean;
  readonly hasStagedPreselection: boolean;
  readonly createPending: boolean;
  /** The selected host resolved to a client this app can actually dial. */
  readonly hostClientResolved: boolean;
  /**
   * The combined Layer-1 verdict allows a submit - see `chat-fork-target`. It
   * spans BOTH subjects the dialog gates on: the selected host's build, and the
   * source chat's publication (never backed up, frozen, or not yet covering the
   * chosen boundary).
   */
  readonly verdictAllowsSubmit: boolean;
  readonly requiresStagedPreselection: boolean;
}): boolean {
  if (input.target === null) return false;
  if (input.trimmedTitle.length === 0 && !input.sourceUntitled) return false;
  if (!input.modelResolved) return false;
  if (input.createPending) return false;
  if (!input.hostClientResolved) return false;
  if (!input.verdictAllowsSubmit) return false;
  if (input.requiresStagedPreselection && !input.hasStagedPreselection) {
    return false;
  }
  return true;
}

function forkModeTitlePrefix(mode: ChatForkMode): string {
  if (mode === "cross-question") return "Cross Question";
  if (mode === "ab-worktree") return "A/B Fork";
  return "Fork";
}

// Includes the selected host: the picker's harness/model choices are resolved
// against THAT host's catalog, so retargeting has to remount it rather than
// leave the previous machine's selection standing in a picker that can no
// longer justify it.
function forkDialogModelPickerKey(
  target: ChatForkDialogTarget,
  selectedHostId: string,
): string {
  const seed = target.settingsSeed;
  // JSON, not a joined string: every part here is free-form (host ids, model
  // slugs, profile ids), so any single-character separator is one some value
  // could contain — and two different seeds collapsing onto one key would
  // leave the picker mounted on a selection it can no longer justify.
  return JSON.stringify([
    target.sourceChatId,
    target.assistantMessageId,
    selectedHostId,
    seed.harnessId,
    seed.model,
    seed.permissionMode,
    seed.reasoningEffort ?? "",
    seed.serviceTier ?? "",
    seed.agentMode,
    seed.profileId ?? "",
  ]);
}
