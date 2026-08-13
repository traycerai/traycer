import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { toast } from "sonner";
import { CircleAlert } from "lucide-react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
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
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useFocusedPaneModalOpen } from "@/components/epic-tabs/pane-visibility-context";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { resolveSeededProfileId } from "@/lib/composer/resolve-seeded-profile-id";
import {
  type CreateTuiAgentStatus,
  useCreateTuiAgentForClient,
} from "@/hooks/agent/use-create-tui-agent";
import { useValidateTuiForkProfile } from "@/hooks/agent/use-validate-tui-fork-profile-mutation";
import { useTuiForkProfileSupported } from "@/hooks/agent/use-tui-fork-profile-support";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  profileCommitId,
  profileDisplayLabel,
  type ProfileRowAdmission,
} from "@/components/providers/provider-profile-model";
import {
  resolveTuiForkRejectionView,
  type TuiForkRejectionView,
} from "@/lib/tui-fork-profile-rejection";
import { displayTitle } from "@/lib/display-title";
import { readSeededLaunchWorkspace } from "@/lib/worktree/seeded-launch-worktree-intent";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import {
  pendingForkTerminalAgentStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";

// `pendingForkTerminalAgentStagingKey` is per-EPIC, so every terminal-agent
// tile in an epic shares one staging slot. Two dialog bodies can therefore be
// mounted over the same key (one unmounting as another opens), and the loser's
// teardown must not wipe the winner's freshly-seeded workspace. Whoever
// registered last owns the slot; a stale cleanup sees a different symbol and
// bails. Mirrors `chat-fork-dialog.tsx`.
const activeTerminalForkWorkspaceOwnerByKey = new Map<string, symbol>();

const EMPTY_FORK_PROFILES: ReadonlyArray<ProviderProfile> = [];
const EMPTY_FORK_ADMISSION: ReadonlyMap<string | null, ProfileRowAdmission> =
  new Map();

const CAPABILITY_LOCK_REASON =
  "Update Traycer host to continue this session under another profile.";
const ADMISSION_PENDING_REASON =
  "Checking whether this profile can continue this session…";
const ADMISSION_FAILED_REASON =
  "Couldn't confirm this profile can continue this session. Choose the current profile, or try again.";

type AdmissionOutcome =
  | {
      readonly kind: "resolved";
      readonly map: ReadonlyMap<string | null, ProfileRowAdmission>;
    }
  | { readonly kind: "failed" };

interface AdmissionResultState {
  readonly requestKey: string;
  readonly outcome: AdmissionOutcome;
}

/** Disables every profile except `sourceProfileId` with the same `reason` -
 *  the shared shape both the old-host capability lock and the bulk-admission
 *  pending/failed states use (amend-01 Fixes 1 and 3): same profile stays
 *  fully functional, every OTHER profile is unreachable through the picker. */
function lockNonSourceProfiles(
  profiles: ReadonlyArray<ProviderProfile>,
  sourceProfileId: string | null,
  reason: string,
): ReadonlyMap<string | null, ProfileRowAdmission> {
  return new Map(
    profiles
      .filter((profile) => profileCommitId(profile) !== sourceProfileId)
      .map((profile) => [profileCommitId(profile), { disabled: true, reason }]),
  );
}

/**
 * The dialog's single source of truth for `profileAdmission`, composing three
 * independent gates in priority order:
 *   1. Old-host capability lock (Fix 1) - wins regardless of intent. Exempts
 *      `capabilityLockExemptProfileId`, not the raw `sourceProfileId`: an old
 *      host has no guard, so ambient must stay reachable when the raw source
 *      is a no-longer-live profile (amend-02).
 *   2. Bulk admission unsettled/failed (Fix 3) - locks non-source profiles
 *      rather than failing open while pending or after an RPC failure.
 *   3. Bulk admission resolved - the server's per-profile verdicts.
 * Plain-fork intent on a capable host falls through to `EMPTY_FORK_ADMISSION`
 * (picker stays fully open) - sound per the T5 review: submit-time preflight
 * plus the authoritative `prepareLaunch` guard both still apply there.
 */
function resolveDialogAdmission(input: {
  readonly capabilityLockActive: boolean;
  readonly admissionActive: boolean;
  readonly admissionSettled: AdmissionOutcome | null;
  readonly sourceHarnessProfiles: ReadonlyArray<ProviderProfile>;
  readonly sourceProfileId: string | null;
  readonly capabilityLockExemptProfileId: string | null;
}): ReadonlyMap<string | null, ProfileRowAdmission> {
  if (input.capabilityLockActive) {
    return lockNonSourceProfiles(
      input.sourceHarnessProfiles,
      input.capabilityLockExemptProfileId,
      CAPABILITY_LOCK_REASON,
    );
  }
  if (!input.admissionActive) return EMPTY_FORK_ADMISSION;
  if (input.admissionSettled === null) {
    return lockNonSourceProfiles(
      input.sourceHarnessProfiles,
      input.sourceProfileId,
      ADMISSION_PENDING_REASON,
    );
  }
  if (input.admissionSettled.kind === "failed") {
    return lockNonSourceProfiles(
      input.sourceHarnessProfiles,
      input.sourceProfileId,
      ADMISSION_FAILED_REASON,
    );
  }
  return input.admissionSettled.map;
}

/**
 * `"fork"` is today's plain sibling-session fork. `"continue"` is the T5
 * intent flag riding the SAME dialog (tech plan UX package): title/CTA copy
 * change and the profile strip gets emphasis + bulk-admission row disabling,
 * but the submit path, workspace handling, and every other mechanism are
 * identical - this is a presentation flag, not a second dialog.
 */
export type TerminalAgentForkIntent = "fork" | "continue";

export interface TerminalAgentForkDialogTarget {
  readonly sourceAgent: TuiAgentProjection;
  readonly workspaceSeed: ForkWorkspaceSeed;
  readonly intent: TerminalAgentForkIntent;
}

type TerminalAgentForkStatus = "idle" | CreateTuiAgentStatus;

interface TerminalAgentForkDialogProps {
  readonly open: boolean;
  readonly target: TerminalAgentForkDialogTarget | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function TerminalAgentForkDialog(props: TerminalAgentForkDialogProps) {
  const presentedOpen = useFocusedPaneModalOpen(props.open);
  return (
    <SurfaceActivityProvider active={presentedOpen}>
      <TerminalAgentForkDialogBody {...props} />
    </SurfaceActivityProvider>
  );
}

// Coordinates dialog lifecycle, toolbar state, staged worktree state, and the
// fork mutation in one fixed hook order. Splitting this body risks hiding the
// cross-field submit invariants without reducing user-facing behavior.
// eslint-disable-next-line complexity
function TerminalAgentForkDialogBody(props: TerminalAgentForkDialogProps) {
  const { hostClient, hostId, epicId, onOpenChange, open, tabId, target } =
    props;
  const activityEnabled = useSurfaceActivity();
  const intent: TerminalAgentForkIntent = target?.intent ?? "fork";
  const titleInputId = useId();
  const argsInputId = useId();
  const profileSectionHeadingId = useId();
  const profileSectionRef = useRef<HTMLElement | null>(null);
  const [titleState, setTitleState] = useState(() => ({
    open,
    touched: false,
    draft: "",
  }));
  const stagingKey = useMemo(
    () => pendingForkTerminalAgentStagingKey(epicId),
    [epicId],
  );
  const settingsSeed = useMemo(() => {
    if (target === null) return null;
    return terminalForkSettingsSeed(target.sourceAgent);
  }, [target]);
  // A fork dialog has no send-time reauth gate of its own (unlike the main
  // composer), so a source agent's profileId that was tombstoned since it
  // last ran must be caught before it reaches `createAgent.create`.
  // `useComposerToolbarStore` now validates every seed it receives against
  // the SAME host's live `providers.list` (passing `hostClient` here - this
  // dialog's explicit prop, not necessarily the app-wide active host -
  // mirroring how the workspace controls below already query this fixed
  // host), so no separate resolution is needed at this call site. Never
  // authoritative: this dialog has no reauth gate of its own, so a
  // genuinely-tombstoned source profile must be corrected to ambient here
  // rather than silently submitted to `createAgent.create`.
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(settingsSeed, hostClient),
    null,
    true,
  );
  const createAgent = useCreateTuiAgentForClient(hostClient, hostId);
  const validateForkProfile = useValidateTuiForkProfile(hostClient);
  const validateForkProfileMutateAsync = validateForkProfile.mutateAsync;
  const forkProfileSupported = useTuiForkProfileSupported(hostId);
  const [status, setStatus] = useState<TerminalAgentForkStatus>("idle");
  const [rejection, setRejection] = useState<TuiForkRejectionView | null>(null);
  const modelResolved = useStore(
    toolbarStore,
    (s) => s.selection.modelSlug.length > 0,
  );
  const currentProfileId = useStore(toolbarStore, (s) => s.selection.profileId);

  // `providers.list` for the SOURCE harness, read from this dialog's own
  // fixed `hostClient` (never the app-wide active host - mirrors
  // `useResolvedSeededProfileId`'s host-scoping rule). Feeds three things:
  // the bulk fork-admission preflight's candidate list (continue mode), the
  // live "profile changed" default-title label, and the rejection alert's
  // {target,source}Label copy - all three need the same profile-label
  // resolution, so one query serves all of them.
  const dialogActive = open && target !== null;
  const providersQuery = useProvidersListForClient(hostClient, {
    enabled: dialogActive,
    subscribed: dialogActive,
  });
  const sourceHarnessProfiles = useMemo<ReadonlyArray<ProviderProfile>>(() => {
    if (target === null) return EMPTY_FORK_PROFILES;
    const providerId = guiHarnessIdToProviderId(target.sourceAgent.harnessId);
    if (providerId === null) return EMPTY_FORK_PROFILES;
    const provider = providersQuery.data?.providers.find(
      (candidate) => candidate.providerId === providerId,
    );
    return provider?.profiles ?? EMPTY_FORK_PROFILES;
  }, [providersQuery.data, target]);

  const sourceTuiAgentId = target?.sourceAgent.id ?? null;
  // The SOURCE profile identity, RAW and persisted - the SAME identity the
  // host's authoritative continuation-scope guard compares against (amend-02:
  // the host now mirrors on-disk storage truth for a tombstoned managed
  // profile whose layout used to share ambient storage, so raw is correct
  // here rather than a UI-local normalization that could disagree with what
  // the host actually admits). Used consistently everywhere this dialog
  // needs "the source's own profile": admission composition, the CTA's
  // locked-selection check, the default-title comparison, the cross-profile
  // Claude disclosure, and `create.sourceProfileId`.
  const providersSettled = providersQuery.data !== undefined;
  const sourceProfileId = target?.sourceAgent.profileId ?? null;
  // Old-host bypass fix (amend-01 Fix 1, blocker): negotiated capability
  // absence is no evidence the host has the new authoritative `prepareLaunch`
  // guard - it just means the host predates this package. The picker must be
  // pinned to the source's own profile in THIS case regardless of intent,
  // since the same dialog is reachable through the always-enabled primary
  // Fork button, not just the (already capability-gated) Continue menu item.
  const capabilityLockActive =
    dialogActive && !forkProfileSupported && sourceHarnessProfiles.length > 0;
  // The capability lock's exemption specifically (amend-02): an old host has
  // NO continuation-scope guard at all, so a plain fork/continue that lands
  // on ambient - `useComposerToolbarStore`'s own seed correction for a
  // tombstoned/no-longer-live raw source profile - must stay submittable
  // there exactly as it did before this feature existed. Resolved the SAME
  // way that seed correction is: live membership against this harness's
  // `providers.list`. For a still-live source profile this equals
  // `sourceProfileId` verbatim (no behavior change); it only diverges - to
  // ambient - when the raw source profile is no longer a live row.
  const capabilityLockExemptProfileId = resolveSeededProfileId(
    sourceProfileId,
    sourceHarnessProfiles,
    providersSettled,
  );
  // Only continue mode proactively disables unshared rows (tech plan UX
  // package scopes bulk-admission picker behavior to continue mode); a
  // manual cross-profile pick in plain fork mode still gets caught by
  // `use-create-tui-agent.ts`'s own preflight at submit time, surfaced via
  // the rejection alert below - it just isn't pre-disabled in the picker.
  const admissionActive =
    dialogActive &&
    intent === "continue" &&
    forkProfileSupported &&
    sourceTuiAgentId !== null &&
    sourceHarnessProfiles.length > 0;
  // Keyed by the exact inputs a bulk request answers for, so a stale result
  // from a PRIOR target/profile-set is never read as settled for the current
  // one (amend-01 Fix 3: the map must not fail open while unsettled).
  const admissionRequestKey =
    sourceTuiAgentId === null
      ? null
      : `${sourceTuiAgentId}:${sourceHarnessProfiles.map(profileCommitId).join(",")}`;
  const [admissionResult, setAdmissionResult] =
    useState<AdmissionResultState | null>(null);
  useEffect(() => {
    if (!admissionActive) return;
    if (admissionRequestKey === null) return;
    let cancelled = false;
    void validateForkProfileMutateAsync({
      epicId,
      sourceTuiAgentId,
      targetProfileIds: sourceHarnessProfiles.map(profileCommitId),
    })
      .then((result) => {
        if (cancelled) return;
        setAdmissionResult({
          requestKey: admissionRequestKey,
          outcome: {
            kind: "resolved",
            map: new Map(
              result.verdicts.map((verdict) => [
                verdict.targetProfileId,
                {
                  disabled: !verdict.admitted,
                  reason:
                    verdict.message ??
                    (verdict.admitted
                      ? null
                      : "This profile can't continue this session."),
                },
              ]),
            ),
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setAdmissionResult({
          requestKey: admissionRequestKey,
          outcome: { kind: "failed" },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    admissionActive,
    admissionRequestKey,
    epicId,
    sourceHarnessProfiles,
    sourceTuiAgentId,
    validateForkProfileMutateAsync,
  ]);
  // `null` = no settled result for the CURRENT request key yet (either still
  // pending, or a stale result from a superseded target/profile-set).
  const admissionSettled: AdmissionOutcome | null =
    admissionRequestKey !== null &&
    admissionResult !== null &&
    admissionResult.requestKey === admissionRequestKey
      ? admissionResult.outcome
      : null;
  const admissionByProfileId = resolveDialogAdmission({
    capabilityLockActive,
    admissionActive,
    admissionSettled,
    sourceHarnessProfiles,
    sourceProfileId,
    capabilityLockExemptProfileId,
  });

  // Live default title (tech plan UX package: "profile-changed default
  // title"): reactive to the CURRENT picker selection, not frozen at
  // open-time, so switching profiles in the strip updates the title for as
  // long as the user hasn't typed their own.
  const defaultTitle =
    target === null
      ? ""
      : terminalForkDefaultTitle({
          sourceAgent: target.sourceAgent,
          profileLabel:
            currentProfileId === sourceProfileId
              ? null
              : resolveForkProfileLabel(
                  sourceHarnessProfiles,
                  currentProfileId,
                ),
        });
  if (open !== titleState.open) {
    // A fresh open resets to the (now live) default; a close leaves the
    // draft/touched state exactly as it was so the closing dialog doesn't
    // flash back to the default mid-animation (matches prior behavior).
    setTitleState((current) => ({
      open,
      touched: open ? false : current.touched,
      draft: open ? "" : current.draft,
    }));
    if (!open) {
      // Clear the transient submit status/alert when the dialog closes
      // (incl. an external close mid-submit). Adjusted during render on the
      // `open` prop transition rather than in an effect.
      if (status !== "idle") setStatus("idle");
      if (rejection !== null) setRejection(null);
    }
  }
  const title = titleState.touched ? titleState.draft : defaultTitle;
  const setTitle = useCallback((nextTitle: string): void => {
    setTitleState((current) => ({
      ...current,
      touched: true,
      draft: nextTitle,
    }));
  }, []);
  const trimmedTitle = title.trim();
  const sourceSessionId = target?.sourceAgent.harnessSessionId ?? null;
  const [argsState, setArgsState] = useState(() => ({
    sourceAgentId: "",
    draft: "",
    touched: false,
  }));
  const sourceAgentId = target?.sourceAgent.id ?? "";
  const sourceArgs = target?.sourceAgent.terminalAgentArgs ?? "";
  // `argsDraft` / `argsTouched` are DERIVED from `argsState` vs the current
  // source: a different source (or a never-touched field) falls back to the
  // source's own args, so there is no effect syncing state to the props - the
  // input's onChange stamps `sourceAgentId` when the user edits.
  const argsDraft =
    argsState.sourceAgentId === sourceAgentId ? argsState.draft : sourceArgs;
  const argsTouched =
    argsState.sourceAgentId === sourceAgentId ? argsState.touched : false;
  const busy = createAgent.isPending || status !== "idle";
  // Defense-in-depth alongside the picker's own row-disabling (amend-01
  // Fixes 1 and 3): the CTA itself refuses to submit a currently-selected
  // profile the composed admission map has locked, whether that's the
  // old-host capability lock, an unsettled/failed bulk check, or a rejected
  // server verdict. A resolved server verdict is authoritative for the source
  // profile too; only local unsettled/failed locks exempt that same-profile
  // selection.
  const crossProfileSelected = currentProfileId !== sourceProfileId;
  const hasResolvedAdmission = admissionSettled?.kind === "resolved";
  const selectedProfileLocked =
    (crossProfileSelected || hasResolvedAdmission) &&
    admissionByProfileId.get(currentProfileId)?.disabled === true;
  const canSubmit =
    target !== null &&
    sourceSessionId !== null &&
    trimmedTitle.length > 0 &&
    modelResolved &&
    !busy &&
    !selectedProfileLocked;

  // The seeded workspace (staged intent + live snapshot) is scratch state for
  // THIS fork attempt. Abandoning the dialog must drop it, or the next fork in
  // the epic reads the cancelled fork's folders/primary back out of the shared
  // per-epic slot - `readSeededLaunchWorkspace` prefers the snapshot over the
  // new target's `workspaceSeed`.
  const activeWorkspaceTarget = open ? target : null;
  useEffect(() => {
    if (activeWorkspaceTarget === null) return;
    const stagingKeyId = worktreeStagingKeyString(stagingKey);
    const owner = Symbol(activeWorkspaceTarget.sourceAgent.id);
    activeTerminalForkWorkspaceOwnerByKey.set(stagingKeyId, owner);
    return () => {
      if (activeTerminalForkWorkspaceOwnerByKey.get(stagingKeyId) !== owner) {
        return;
      }
      activeTerminalForkWorkspaceOwnerByKey.delete(stagingKeyId);
      clearTerminalForkWorkspace(stagingKey);
    };
  }, [activeWorkspaceTarget, stagingKey]);

  const close = useCallback(() => {
    if (busy) return;
    clearTerminalForkWorkspace(stagingKey);
    onOpenChange(false);
  }, [busy, onOpenChange, stagingKey]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && busy) return;
      if (!nextOpen) {
        clearTerminalForkWorkspace(stagingKey);
      }
      onOpenChange(nextOpen);
    },
    [busy, onOpenChange, stagingKey],
  );

  const submit = useCallback(() => {
    // `canSubmit` already implies `target !== null && sourceSessionId !== null`,
    // and TS narrows both from it for the rest of this callback.
    if (!canSubmit) return;
    setRejection(null);
    const launchWorkspace = readSeededLaunchWorkspace({
      stagingKey,
      seedIntent: target.workspaceSeed.intent,
      fallbackWorkspace: target.workspaceSeed.workspace,
    });
    const worktreeIntent = launchWorkspace.worktreeIntent;
    if (worktreeIntent !== null) {
      useWorktreeIntentMemoryStore
        .getState()
        .setEpicIntent(epicId, worktreeIntent, Date.now());
    }
    setStatus(
      worktreeIntent !== null && worktreeIntent.entries.length > 0
        ? "preparing-workspace"
        : "forking-session",
    );
    const toolbar = toolbarStore.getState();
    const submittedProfileId = toolbar.selection.profileId;
    // Claude cross-profile disclosure moment (tech plan UX package): the
    // forked session's TodoWrite/rewind state is provider-account-scoped and
    // does not follow a profile switch. Gated to Claude - the only harness
    // this feature admits cross-profile forks for at all.
    const crossProfileClaudeFork =
      submittedProfileId !== sourceProfileId &&
      target.sourceAgent.harnessId === "claude";
    const targetLabel = resolveForkProfileLabel(
      sourceHarnessProfiles,
      submittedProfileId,
    );
    void createAgent
      .create({
        epicId,
        tabId,
        parentId: target.sourceAgent.parentId,
        title: trimmedTitle,
        placement: { kind: "active-tile" },
        harnessId: target.sourceAgent.harnessId,
        model:
          toolbar.selection.modelSlug.length > 0
            ? toolbar.selection.modelSlug
            : null,
        reasoningEffort:
          toolbar.reasoning.length > 0 ? toolbar.reasoning : null,
        profileId: submittedProfileId,
        forkSourceHarnessSessionId: sourceSessionId,
        sourceTuiAgentId: target.sourceAgent.id,
        sourceProfileId,
        onStatusChange: setStatus,
        worktreeIntent,
        workspaceMode: deriveWorkspaceMode(
          launchWorkspace.folderCount,
          worktreeIntent,
        ),
        terminalAgentArgs: argsTouched
          ? argsDraft
          : target.sourceAgent.terminalAgentArgs,
      })
      .then((createdAgentId) => {
        if (createdAgentId !== null) {
          Analytics.getInstance().track(AnalyticsEvent.TerminalAgentForked, {
            source: "direct_ui",
            harness: target.sourceAgent.harnessId,
          });
          // No trivial persisted field exists to drive a tile-side one-time
          // notice (tech plan UX package's documented fallback), so the
          // cross-profile lossiness disclosure fires as a toast here instead.
          if (crossProfileClaudeFork) {
            toast(
              `Continuing under ${targetLabel} - TodoWrite history and rewind state from the original session won't carry over.`,
            );
          }
          clearTerminalForkWorkspace(stagingKey);
          onOpenChange(false);
        }
      })
      .catch((caught: unknown) => {
        const sourceLabel = resolveForkProfileLabel(
          sourceHarnessProfiles,
          sourceProfileId,
        );
        const view = resolveTuiForkRejectionView(caught, {
          targetLabel,
          sourceLabel,
        });
        if (view !== null) setRejection(view);
      })
      .finally(() => setStatus("idle"));
  }, [
    argsDraft,
    argsTouched,
    canSubmit,
    createAgent,
    epicId,
    onOpenChange,
    sourceHarnessProfiles,
    sourceProfileId,
    sourceSessionId,
    stagingKey,
    tabId,
    target,
    toolbarStore,
    trimmedTitle,
  ]);
  usePrimaryActionShortcut(activityEnabled, submit);

  const crossProfileClaudeHint =
    intent === "continue" &&
    target !== null &&
    target.sourceAgent.harnessId === "claude" &&
    crossProfileSelected;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[92vh] w-[min(94vw,48rem)] gap-3 sm:max-w-[min(94vw,48rem)]"
        // Same portal rule as the worktree pickers: the host switcher's list
        // mounts outside this dialog, so a click in it reads as an interaction
        // from outside. Dismissing on that would throw away the form someone is
        // in the middle of filling, for the crime of choosing a host in it.
        onInteractOutside={(event) => {
          if (isHostSwitcherListInteraction(event.target)) {
            event.preventDefault();
          }
        }}
        onOpenAutoFocus={(event) => {
          // Continue mode starts on the real picker control, using that
          // control's normal focus treatment instead of drawing a ring around
          // the whole profile section. The section remains a safe fallback
          // while the picker is still resolving.
          if (intent !== "continue") return;
          if (profileSectionRef.current === null) return;
          event.preventDefault();
          const pickerTrigger =
            profileSectionRef.current.querySelector<HTMLButtonElement>(
              "button:not(:disabled)",
            );
          (pickerTrigger ?? profileSectionRef.current).focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {intent === "continue"
              ? "Continue under another profile"
              : "Fork terminal agent"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto pr-1">
          {rejection !== null ? (
            <div
              role="alert"
              data-testid="terminal-fork-rejection"
              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-ui-xs text-destructive"
            >
              <CircleAlert aria-hidden className="mt-0.5 size-3.5" />
              <div className="min-w-0">
                <p>{rejection.message}</p>
                {rejection.residueNote !== null ? (
                  <p className="mt-0.5 text-muted-foreground">
                    {rejection.residueNote}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          <div
            data-testid="terminal-fork-dialog-fields"
            className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 flex-col gap-3">
              <label
                htmlFor={titleInputId}
                className="flex min-w-0 flex-col gap-1.5"
              >
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
                  disabled={busy}
                  aria-label={
                    intent === "continue"
                      ? "Continue under another profile title"
                      : "Fork terminal agent title"
                  }
                />
              </label>
              <section
                ref={profileSectionRef}
                tabIndex={-1}
                aria-labelledby={profileSectionHeadingId}
                data-testid="terminal-fork-profile-section"
                className="flex min-w-0 flex-col gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
              >
                <div
                  id={profileSectionHeadingId}
                  className="px-0 py-0 font-sans text-overline font-medium uppercase text-muted-foreground/70"
                >
                  {intent === "continue" ? "Continue under" : "Harness"}
                </div>
                <div className="flex min-w-0 items-center gap-2 rounded-md">
                  <HarnessModelPicker
                    key={terminalForkModelPickerKey(target)}
                    store={toolbarStore}
                    withServiceTier={false}
                    tuiOnly
                    lockedHarnessId={target?.sourceAgent.harnessId ?? null}
                    disabled={busy}
                    registerActivation={false}
                    createProfileHostId={hostId}
                    runTargetHostId={hostId}
                    profileAdmission={admissionByProfileId}
                  />
                </div>
                {crossProfileClaudeHint ? (
                  <p className="text-ui-xs text-muted-foreground">
                    Heads up: TodoWrite history and rewind state from this
                    session won't carry over to the new profile.
                  </p>
                ) : null}
              </section>
              <label
                htmlFor={argsInputId}
                className="flex min-w-0 flex-col gap-1.5"
              >
                <span className="px-0 py-0 font-sans text-overline font-medium uppercase text-muted-foreground/70">
                  Additional args
                </span>
                <Input
                  id={argsInputId}
                  value={argsDraft}
                  onChange={(event) =>
                    setArgsState({
                      sourceAgentId,
                      draft: event.target.value,
                      touched: true,
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submit();
                  }}
                  disabled={busy}
                  aria-label="Terminal interface CLI arguments"
                  className="font-mono text-ui-xs"
                />
              </label>
            </div>
            <section
              aria-label="Run location"
              className="min-w-0 rounded-lg border border-border/60 bg-muted/20 p-3"
            >
              <ActiveHostWorkspaceControls
                disabled={false}
                stagingKey={stagingKey}
                layout="stacked"
                workspaceSeed={target?.workspaceSeed.workspace ?? null}
                seedIntent={target?.workspaceSeed.intent ?? null}
                seedIntentOverride={null}
                hostScope={{ kind: "fixed", hostId, hostClient }}
              />
            </section>
          </div>
          {status !== "idle" ? (
            <div
              role="status"
              aria-live="polite"
              className="min-h-5 text-ui-xs text-muted-foreground"
            >
              {terminalForkStatusLabel(status)}
            </div>
          ) : null}
        </div>
        <DialogFooter className="py-3">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            aria-label={terminalForkButtonLabel(intent)}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? (
              <AgentSpinningDots
                className="text-current"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {terminalForkButtonLabel(intent)}
            <PrimaryActionShortcutHint />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Drops both halves of this fork's scratch workspace: the staged per-folder
// intent (branch/scripts selections) and the live snapshot the picker mirrors
// out for `readSeededLaunchWorkspace`. Idempotent - a successful submit clears
// here and the close that follows clears again.
function clearTerminalForkWorkspace(stagingKey: WorktreeStagingKey): void {
  useWorktreeIntentStagingStore.getState().clear(stagingKey);
  useSeededWorkspaceSnapshotStore.getState().clear(stagingKey);
}

function terminalForkStatusLabel(status: CreateTuiAgentStatus): string {
  switch (status) {
    case "preparing-workspace":
      return "Preparing linked folders";
    case "forking-session":
      return "Forking terminal agent";
    case "starting-terminal":
      return "Starting terminal";
  }
}

function terminalForkButtonLabel(intent: TerminalAgentForkIntent): string {
  return intent === "continue" ? "Continue" : "Fork";
}

function terminalForkSettingsSeed(agent: TuiAgentProjection): ChatRunSettings {
  return {
    harnessId: agent.harnessId,
    model: agent.model ?? "",
    permissionMode: "supervised",
    reasoningEffort: agent.reasoningEffort,
    // Epic Mode was removed; the protocol still carries the field.
    agentMode: "regular",
    serviceTier: null,
    // Seed from the source agent's profile - `useComposerToolbarStore`
    // validates it against the target host's live provider profiles; the
    // harness stays locked (see `lockedHarnessId` below) but the user can
    // still switch between that harness's OTHER profiles via the rail
    // before forking.
    profileId: agent.profileId,
  };
}

/**
 * Tech plan UX package's "profile-changed default title":
 * `Continue · {profileLabel} - {sourceTitle}` once the picker's live
 * selection differs from the source's own profile, else the plain
 * `Fork - {sourceTitle}`. `profileLabel === null` is the caller's signal for
 * "no change" - it never independently re-derives that comparison.
 */
function terminalForkDefaultTitle(input: {
  readonly sourceAgent: TuiAgentProjection;
  readonly profileLabel: string | null;
}): string {
  const sourceTitle = displayTitle(input.sourceAgent.title, "agent");
  if (input.profileLabel === null) {
    return `Fork - ${sourceTitle}`;
  }
  return `Continue · ${input.profileLabel} - ${sourceTitle}`;
}

/** Best-effort label for a profile id against a resolved profile list -
 *  used for the default-title and rejection-alert copy, both of which need
 *  a readable name even before `providers.list` has settled. */
function resolveForkProfileLabel(
  profiles: ReadonlyArray<ProviderProfile>,
  profileId: string | null,
): string {
  const match = profiles.find(
    (profile) => profileCommitId(profile) === profileId,
  );
  if (match !== undefined) return profileDisplayLabel(match);
  return profileId === null ? "the default profile" : "this profile";
}

function terminalForkModelPickerKey(
  target: TerminalAgentForkDialogTarget | null,
): string {
  if (target === null) return "terminal-fork-dialog-closed";
  const agent = target.sourceAgent;
  return [
    agent.id,
    agent.harnessId,
    agent.model ?? "",
    agent.reasoningEffort ?? "",
    agent.profileId ?? "",
  ].join("\u0000");
}
