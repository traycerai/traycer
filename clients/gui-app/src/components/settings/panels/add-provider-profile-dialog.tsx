import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Link2,
} from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  type ProviderCliState,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { ProfileSeedSource } from "@traycer/protocol/host/provider-profile-config-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { CopyTextButton } from "@/components/copy-text-button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProvidersStartLoginForClient } from "@/hooks/providers/use-providers-start-login-mutation";
import { useProvidersAwaitLoginForClient } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersCancelLoginForClient } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useProvidersSubmitLoginCodeForClient } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLoginForClient } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useRecolorProviderProfileForClient } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRenameProviderProfileForClient } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useOpenLink } from "@/lib/links/open-link";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { redactEmail } from "@/lib/providers/redact-email";
import { resolveDefaultSignInMode } from "@/components/providers/provider-signin-availability";
import { signInModeToggleSupported } from "./provider-sign-in-mode-support";
import { CodePasteField, CodePasteRestartNotice } from "./code-paste-field";
import { handleSignInLinkCopyError } from "./provider-sign-in-link";
import { waitingStepCopy } from "./waiting-step-copy";
import { profileDisplayLabel } from "@/components/providers/provider-profile-model";
import {
  useProviderProfileLoginFlow,
  type ProviderProfileLoginFlowCodePaste,
  type ProviderProfileLoginFlowState,
} from "./use-provider-profile-login-flow";

const COPY_CONFIRMATION_RESET_MS = 1600;

export interface FailedProviderProfileAttempt {
  readonly providerId: ProviderCliState["providerId"];
  readonly message: string;
}

/**
 * The "Sign in" tab body of the D25 add-profile dialog
 * (`add-profile-dialog.tsx`'s `AddProfileDialog`, which owns the outer
 * `<Dialog>`/`<DialogContent>` and Step 1's name+color+"Start from" fields).
 * Owns the login state machine and the naming/finalize steps that follow a
 * successful sign-in; does NOT own the dialog's open state - a close
 * attempt (Cancel, Escape, outside click) is routed through
 * `closeRequestRef`, which this component installs its own guarded handler
 * into (checking `dismissalLocked` and cancelling an in-flight login before
 * actually closing), because only this component knows `flow`'s state.
 */
export function ProviderSignInPanel({
  state,
  client,
  label,
  onLabelChange,
  accentColor,
  hostId,
  isSelectedHostLocal,
  startFrom,
  onFailedAttempt,
  onProfileCreated,
  onRequestClose,
  closeRequestRef,
}: {
  readonly state: ProviderCliState;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** Step 1's name field (lifted to the wrapper) - reused here for the
   *  post-auth naming step's inline rename, since Step 1 itself is no longer
   *  on screen once sign-in has started. */
  readonly label: string;
  readonly onLabelChange: (label: string) => void;
  readonly accentColor: ProviderProfileAccentColor;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
  /** D32/W2-T10b: Step 1's "Start from" selection (the wrapper dialog owns
   *  the `Select` and converts it via `startFromValueToSeed`) - passed
   *  straight through to `providers.startLogin`'s `startFrom` (D32) so a
   *  sign-in-created profile is seeded the same way an API-key-created one
   *  is. */
  readonly startFrom: ProfileSeedSource;
  /** `null` retracts a previously reported failure: fired when a new attempt
   *  starts and when an attempt completes, so a stale "sign-in did not
   *  finish" banner never sits next to a profile that DID sign in. */
  readonly onFailedAttempt: (
    attempt: FailedProviderProfileAttempt | null,
  ) => void;
  readonly onProfileCreated: (profileId: string) => void;
  /** The wrapper's real Dialog setter - call only once actually safe to
   *  close (see `closeRequestRef`). */
  readonly onRequestClose: (open: boolean) => void;
  /** The wrapper's Dialog routes every dismissal attempt through
   *  `closeRequestRef.current`; this component keeps that ref pointed at its
   *  own guarded handler for as long as it is mounted (the active tab). */
  readonly closeRequestRef: { current: (open: boolean) => void };
}): ReactNode {
  const openLink = useOpenLink();
  const [emailRevealed, setEmailRevealed] = useState(false);
  const finalizeAttemptRef = useRef<string | null>(null);
  // Set once naming is committed (a rename RPC succeeded, or none was needed
  // because the label was left at its default) for a given profileId - marks
  // the transition from the naming step into the ordinary finalize/recolor
  // path below, so a later recolor failure/retry never re-shows naming. State
  // (not a ref) because it feeds the naming-step derivation below, which runs
  // during render.
  const [namingCommittedFor, setNamingCommittedFor] = useState<string | null>(
    null,
  );
  const startLogin = useProvidersStartLoginForClient(client);
  const awaitLogin = useProvidersAwaitLoginForClient({
    client,
    getCacheHostId: () => client?.getActiveHostId() ?? null,
  });
  const cancelLogin = useProvidersCancelLoginForClient(client);
  const submitLoginCode = useProvidersSubmitLoginCodeForClient(client);
  const touchLogin = useProvidersTouchLoginForClient(client);
  const recolorProfile = useRecolorProviderProfileForClient(client);
  const renameProfile = useRenameProviderProfileForClient(client);
  const signInModeSchemaVersion = useHostMethodSchemaVersion(
    hostId,
    "providers.startLogin",
  );
  const toggleSupported = signInModeToggleSupported(signInModeSchemaVersion);
  const flow = useProviderProfileLoginFlow({
    mode: "create",
    providerId: state.providerId,
    existingProfileId: null,
    loginCapability: state.loginCapability,
    signInMode: resolveDefaultSignInMode(isSelectedHostLocal),
    startFrom,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    failureMessages: {
      notStarted:
        "Sign-in did not start. You can retry when the provider is available.",
      notFinished: "Sign-in did not finish. Retry when you are ready.",
    },
    onFailed: (message) =>
      onFailedAttempt({ providerId: state.providerId, message }),
  });
  const trimmedLabel = label.trim();
  const { finalizing, dismissalLocked } = resolveDialogLockState({
    flowState: flow.state,
    commitPending: flow.commitPending,
    recolorPending: recolorProfile.isPending,
    recolorError: recolorProfile.error,
    renamePending: renameProfile.isPending,
    renameError: renameProfile.error,
  });

  // Post-auth naming step: a freshly created (non-duplicate) profile whose
  // resolved email matches another active profile of the same provider -
  // the split-by-organization case now possible now that same-email,
  // different-org sign-ins mint distinct profiles instead of deduping. Holds
  // the dialog open on the resolved identity so the user can tell the two
  // apart before the default label sticks. Cleared once `namingCommittedFor`
  // is set (see `commitNaming`), so a later recolor retry never re-shows it.
  const naming = resolveNamingStep(flow.state, namingCommittedFor);

  const complete = (profileId: string): void => {
    onFailedAttempt(null);
    onProfileCreated(profileId);
    onRequestClose(false);
  };

  const finalizeProfile = (profile: ProviderProfile): void => {
    if (accentColor === profile.accentColor) {
      complete(profile.profileId);
      return;
    }
    recolorProfile.mutate(
      {
        providerId: state.providerId,
        profileId: profile.profileId,
        accentColor,
      },
      { onSuccess: () => complete(profile.profileId) },
    );
  };

  const commitNaming = (profile: ProviderProfile): void => {
    if (trimmedLabel.length === 0) return;
    if (trimmedLabel === profile.label) {
      setNamingCommittedFor(profile.profileId);
      // Claim the attempt before finalizing directly - otherwise the render
      // this triggers flips `naming` to null, and the effect below (which
      // has no dependency array) sees an unclaimed `finalizeAttemptRef` and
      // calls `finalizeProfile` a second time.
      finalizeAttemptRef.current = profile.profileId;
      finalizeProfile(profile);
      return;
    }
    renameProfile.mutate(
      {
        providerId: state.providerId,
        profileId: profile.profileId,
        label: trimmedLabel,
      },
      {
        onSuccess: () => {
          setNamingCommittedFor(profile.profileId);
          finalizeAttemptRef.current = profile.profileId;
          finalizeProfile(profile);
        },
      },
    );
  };

  useEffect(() => {
    if (flow.state.kind === "cancelled") {
      onRequestClose(false);
      return;
    }
    if (
      flow.state.kind !== "identity" ||
      flow.state.existingProfileId !== null ||
      finalizeAttemptRef.current === flow.state.profileId ||
      naming !== null
    ) {
      return;
    }
    finalizeAttemptRef.current = flow.state.profileId;
    finalizeProfile(flow.state.profile);
  });

  const close = (nextOpen: boolean): void => {
    if (!nextOpen && dismissalLocked) return;
    if (!nextOpen && flow.state.kind === "starting") {
      flow.cancel();
      return;
    }
    if (!nextOpen && flow.state.kind === "waiting") {
      flow.cancel();
    }
    onRequestClose(nextOpen);
  };
  // Keeps the wrapper's dismissal handler pointed at THIS panel's own guard
  // for as long as it is mounted - after render commits, matching the same
  // forwarding-ref technique `use-provider-profile-login-flow.ts` uses for
  // `beginLoginRef`. The cleanup restores a plain pass-through on unmount
  // (the wrapper's Tabs unmounts an inactive pane by default, so switching
  // to the API key tab mid-flow must not leave this ref pointed at a stale
  // closure over dead `flow` state).
  useEffect(() => {
    closeRequestRef.current = close;
    return () => {
      closeRequestRef.current = (nextOpen) => onRequestClose(nextOpen);
    };
  });

  const linkAccount = (): void => {
    if (trimmedLabel.length === 0) return;
    // A fresh attempt supersedes any previously reported failure - covers
    // both the initial "Link account" and the failed-state Retry.
    onFailedAttempt(null);
    flow.start({
      // D02/D32: new profiles start Linked unconditionally - this legacy
      // wire field predates per-category ownership and only claude-code's
      // create path still reads it (host-side `partial-overlay` seeding); the
      // create-time checkbox that used to set it is gone (W2-T12 owns the
      // Skills/Plugins tabs' Linked/Own toggle instead).
      shareSkillsAndPlugins: true,
      label: trimmedLabel,
    });
  };

  const retryFinalize = (): void => {
    if (flow.state.kind !== "identity") return;
    finalizeProfile(flow.state.profile);
  };

  const duplicateProfile =
    flow.state.kind === "identity" && flow.state.existingProfileId !== null
      ? flow.state.profile
      : null;

  return (
    <div className="flex flex-col gap-5">
      <AddProfileAccountSection
        flowState={flow.state}
        startPending={flow.startPending}
        cancelPending={flow.cancelPending}
        cancelDisabled={flow.commitPending}
        codePaste={flow.codePaste}
        finalizing={finalizing}
        finalizeError={recolorProfile.error}
        duplicateProfile={duplicateProfile}
        naming={naming}
        namingError={renameProfile.error}
        label={label}
        onLabelChange={onLabelChange}
        emailRevealed={emailRevealed}
        setEmailRevealed={setEmailRevealed}
        linkDisabled={trimmedLabel.length === 0 || flow.busy}
        onLink={linkAccount}
        onOpenExternalLink={(url) => {
          void openLink(url, "auth", null);
        }}
        onCancel={() => close(false)}
        onRetryLogin={linkAccount}
        onRetryFinalize={retryFinalize}
        userCode={flow.state.kind === "waiting" ? flow.state.userCode : null}
        onUseCodeInstead={
          toggleSupported && flow.activeSignInMode === "browser"
            ? flow.switchToDeviceMode
            : null
        }
      />

      {flow.state.kind === "start" ? (
        <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-foreground/3 px-5 py-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => close(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      ) : null}
      {naming !== null ? (
        <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-foreground/3 px-5 py-3">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={trimmedLabel.length === 0 || finalizing}
            onClick={() => commitNaming(naming.profile)}
          >
            {finalizing ? <MutedAgentSpinner /> : null}
            Save profile
          </Button>
        </DialogFooter>
      ) : null}
      {duplicateProfile !== null ? (
        <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-foreground/3 px-5 py-3">
          <Button type="button" size="sm" variant="ghost" onClick={linkAccount}>
            Sign in again
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => close(false)}
          >
            Done
          </Button>
        </DialogFooter>
      ) : null}
    </div>
  );
}

function AddProfileAccountSection({
  flowState,
  startPending,
  cancelPending,
  cancelDisabled,
  codePaste,
  finalizing,
  finalizeError,
  duplicateProfile,
  naming,
  namingError,
  label,
  onLabelChange,
  emailRevealed,
  setEmailRevealed,
  linkDisabled,
  onLink,
  onOpenExternalLink,
  onCancel,
  onRetryLogin,
  onRetryFinalize,
  userCode,
  onUseCodeInstead,
}: {
  readonly flowState: ProviderProfileLoginFlowState;
  readonly startPending: boolean;
  readonly cancelPending: boolean;
  readonly cancelDisabled: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly finalizing: boolean;
  readonly finalizeError: Error | null;
  readonly duplicateProfile: ProviderProfile | null;
  readonly naming: NamingStepState | null;
  readonly namingError: Error | null;
  /** Step 1's name field, reused for the naming step's inline rename. */
  readonly label: string;
  readonly onLabelChange: (label: string) => void;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
  readonly linkDisabled: boolean;
  readonly onLink: () => void;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
  readonly onRetryLogin: () => void;
  readonly onRetryFinalize: () => void;
  readonly userCode: string | null;
  readonly onUseCodeInstead: (() => void) | null;
}): ReactNode {
  if (flowState.kind === "start") {
    return (
      <button
        type="button"
        aria-label="Link account"
        className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-foreground/3 p-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={linkDisabled}
        onClick={onLink}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border/60 transition-colors group-hover:text-foreground">
          <Link2 className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui-sm font-medium text-foreground">
            Link account
          </span>
          <span className="block text-ui-xs text-muted-foreground">
            Sign in to the account this profile should use.
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </button>
    );
  }

  if (flowState.kind === "starting" || flowState.kind === "waiting") {
    return (
      <div className="border-t border-border/60 pt-4">
        <AddProfileWaitingStep
          loginUrl={flowState.kind === "waiting" ? flowState.url : null}
          userCode={userCode}
          queuePending={startPending}
          cancelRequested={
            flowState.kind === "starting" && flowState.cancelRequested
          }
          cancelPending={cancelPending}
          cancelDisabled={cancelDisabled}
          waiting={flowState.kind === "waiting"}
          codePaste={codePaste}
          onOpenExternalLink={onOpenExternalLink}
          onCancel={onCancel}
          onUseCodeInstead={onUseCodeInstead}
        />
      </div>
    );
  }

  if (flowState.kind === "failed") {
    return (
      <AddProfileFailureStep
        message={flowState.message}
        onCancel={onCancel}
        onRetry={onRetryLogin}
      />
    );
  }

  if (flowState.kind === "cancelled") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-foreground/3 p-3 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        <span>Cancelling sign-in</span>
      </div>
    );
  }

  if (duplicateProfile !== null) {
    return <DuplicateAccountNotice profile={duplicateProfile} />;
  }

  if (naming !== null) {
    return (
      <AddProfileNamingStep
        profile={naming.profile}
        collisionProfile={naming.collisionProfile}
        error={namingError}
        label={label}
        onLabelChange={onLabelChange}
        emailRevealed={emailRevealed}
        setEmailRevealed={setEmailRevealed}
      />
    );
  }

  if (finalizeError !== null) {
    return (
      <AddProfileFailureStep
        message="The account was linked, but the profile color could not be saved."
        onCancel={onCancel}
        onRetry={onRetryFinalize}
      />
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-foreground/3 p-3 text-ui-sm text-muted-foreground">
      <MutedAgentSpinner />
      <span>{finalizing ? "Finishing profile setup" : "Account linked"}</span>
    </div>
  );
}

function DuplicateAccountNotice({
  profile,
}: {
  readonly profile: ProviderProfile;
}): ReactNode {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-ui-sm font-medium">Account already linked</div>
        <p className="mt-0.5 text-ui-xs leading-relaxed">
          {profileDisplayLabel(profile)} already uses this account and
          organization. Sign in again and choose a different organization.
        </p>
      </div>
    </div>
  );
}

/**
 * Step 1's name field is not on screen once sign-in has started, so this step
 * (an email collision after a successful auth) needs its OWN editable name
 * input - it reuses Step 1's lifted `label`/`onLabelChange` state rather than
 * a second, independent field.
 */
function AddProfileNamingStep({
  profile,
  collisionProfile,
  error,
  label,
  onLabelChange,
  emailRevealed,
  setEmailRevealed,
}: {
  readonly profile: ProviderProfile;
  readonly collisionProfile: ProviderProfile;
  readonly error: Error | null;
  readonly label: string;
  readonly onLabelChange: (label: string) => void;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
}): ReactNode {
  const nameId = useId();
  return (
    <div className="flex flex-col gap-3">
      <AddProfileIdentityStep
        profile={profile}
        duplicateLabel={null}
        emailRevealed={emailRevealed}
        setEmailRevealed={setEmailRevealed}
      />
      <p className="text-ui-xs leading-relaxed text-muted-foreground">
        {collisionProfile.label} already uses this email. Name this profile so
        you can tell them apart.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={nameId}>Profile name</Label>
        <Input
          id={nameId}
          value={label}
          autoComplete="off"
          onChange={(event) => onLabelChange(event.target.value)}
        />
      </div>
      {error !== null ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-ui-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>Couldn&apos;t save the name. Try again.</span>
        </div>
      ) : null}
    </div>
  );
}

export function AddProfileWaitingStep({
  loginUrl,
  userCode,
  queuePending,
  cancelRequested,
  cancelPending,
  cancelDisabled,
  waiting,
  codePaste,
  onOpenExternalLink,
  onCancel,
  onUseCodeInstead,
}: {
  readonly loginUrl: string | null;
  /** D21/D22: the device flow's separate one-time code (Codex); `null` for
   *  browser/paste flows and for providers that carry the code in the URL
   *  instead. */
  readonly userCode: string | null;
  readonly queuePending: boolean;
  readonly cancelRequested: boolean;
  readonly cancelPending: boolean;
  readonly cancelDisabled: boolean;
  /** True only once the flow has reached `waiting` (a live profileId/child
   *  exists). The paste field renders only then - during `starting` there
   *  is nothing yet for a submit to reach, and rendering it anyway would
   *  let a user's paste silently lock the field without ever being sent
   *  (fixup review finding 2). */
  readonly waiting: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
  /** D22 "Use a code instead" - `null` hides the toggle (an older host, or
   *  the attempt is already `device`). */
  readonly onUseCodeInstead: (() => void) | null;
}): ReactNode {
  const { copied, copy } = useClipboardCopy({
    resetMs: COPY_CONFIRMATION_RESET_MS,
    onSuccess: null,
    onError: handleSignInLinkCopyError,
  });
  const processingCode = codePaste.phase !== "idle";
  const { title, guidance } = waitingStepCopy({
    phase: codePaste.phase,
    queuePending,
    cancelRequested,
  });

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {codePaste.restartNotice !== null ? (
        <CodePasteRestartNotice message={codePaste.restartNotice} />
      ) : null}
      <div className="flex items-start gap-2.5">
        <MutedAgentSpinner />
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">{title}</div>
          {guidance !== null ? (
            <p className="mt-0.5 text-ui-xs leading-relaxed text-muted-foreground">
              {guidance}
            </p>
          ) : null}
        </div>
      </div>

      {!processingCode && loginUrl !== null ? (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onOpenExternalLink(loginUrl)}
          >
            <ExternalLink className="size-3.5" />
            Open browser again
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={copied ? "Copied sign-in link" : "Copy sign-in link"}
            onClick={() => copy(loginUrl)}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
          {userCode !== null ? (
            <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-foreground/5 px-2 py-1">
              <code className="font-mono text-code-xs text-foreground">
                {userCode}
              </code>
              <CopyTextButton
                value={userCode}
                label={null}
                ariaLabel="Copy sign-in code"
                disabled={false}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* D22: not offered until the flow settles into a real waiting child
          (never during `starting`, where there is nothing yet to switch) -
          `switchToDeviceMode` on the flow itself enforces this same gate. */}
      {waiting && onUseCodeInstead !== null ? (
        <div className="pl-6">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onUseCodeInstead}
          >
            Use a code instead
          </Button>
        </div>
      ) : null}

      {waiting && codePaste.enabled ? (
        <div className="border-t border-border/50 pt-3">
          {!processingCode ? (
            <div className="mb-2">
              <p className="text-ui-xs font-medium text-foreground">
                Didn&apos;t return automatically?
              </p>
              <p className="mt-0.5 text-ui-xs text-muted-foreground">
                If the browser shows a code, paste it here.
              </p>
            </div>
          ) : null}
          <CodePasteField
            key={codePaste.attemptId}
            codePaste={codePaste}
            disabled={cancelRequested}
            visibleLabel={false}
          />
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          aria-label="Cancel sign-in"
          disabled={cancelRequested || cancelPending || cancelDisabled}
          onClick={onCancel}
        >
          {cancelPending ? <MutedAgentSpinner /> : null}
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AddProfileIdentityStep({
  profile,
  duplicateLabel,
  emailRevealed,
  setEmailRevealed,
}: {
  readonly profile: ProviderProfile;
  readonly duplicateLabel: string | null;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
}): ReactNode {
  const email = profile.identity?.email ?? null;
  const tier = profile.identity?.tier ?? null;
  let identityText = "Authenticated profile";
  if (email !== null) {
    identityText = emailRevealed ? email : redactEmail(email);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border/60 bg-foreground/3 p-3">
        <div className="text-ui-xs font-medium uppercase text-muted-foreground">
          Signed in as
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-ui-sm">
          <span className="min-w-0 truncate font-medium text-foreground">
            {identityText}
          </span>
          {email !== null ? (
            <button
              type="button"
              aria-label={emailRevealed ? "Hide email" : "Reveal email"}
              aria-pressed={emailRevealed}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => setEmailRevealed(!emailRevealed)}
            >
              {emailRevealed ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </button>
          ) : null}
          {tier !== null && tier.length > 0 ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
              {tier}
            </Badge>
          ) : null}
        </div>
      </div>
      {duplicateLabel !== null ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-ui-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>This is the same account as {duplicateLabel}.</span>
        </div>
      ) : null}
    </div>
  );
}

function AddProfileFailureStep({
  message,
  onCancel,
  onRetry,
}: {
  readonly message: string;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-ui-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Provider sign-in failed",
            message: null,
            code: null,
            source: "Add profile",
          })}
          presentation="link"
          className="h-auto p-0 text-current"
        />
      </div>
    </div>
  );
}

/**
 * Another active profile of the same provider sharing `profile`'s email -
 * the split-by-organization case (same Anthropic account, different
 * subscription/org) the naming step exists for. Independent of the host's
 * `duplicateOfProfileId` verdict, which is org-aware and deliberately does
 * NOT mark this pair - this check only needs "tell them apart", not "are
 * these the same account".
 */
function findEmailCollisionProfile(
  profiles: readonly ProviderProfile[],
  profile: ProviderProfile,
): ProviderProfile | null {
  const email = profile.identity?.email ?? null;
  if (email === null) return null;
  const normalized = email.toLowerCase();
  return (
    profiles.find((candidate) => {
      const candidateEmail = candidate.identity?.email ?? null;
      return (
        candidate.profileId !== profile.profileId &&
        candidateEmail !== null &&
        candidateEmail.toLowerCase() === normalized
      );
    }) ?? null
  );
}

interface DialogLockState {
  readonly finalizing: boolean;
  readonly dismissalLocked: boolean;
}

/** Same complexity-budget rationale as `resolveNamingStep` below. */
function resolveDialogLockState({
  flowState,
  commitPending,
  recolorPending,
  recolorError,
  renamePending,
  renameError,
}: {
  readonly flowState: ProviderProfileLoginFlowState;
  readonly commitPending: boolean;
  readonly recolorPending: boolean;
  readonly recolorError: Error | null;
  readonly renamePending: boolean;
  readonly renameError: Error | null;
}): DialogLockState {
  const finalizing = recolorPending || renamePending;
  const identityCompletionPending =
    flowState.kind === "identity" &&
    flowState.existingProfileId === null &&
    recolorError === null &&
    renameError === null;
  return {
    finalizing,
    dismissalLocked: commitPending || finalizing || identityCompletionPending,
  };
}

interface NamingStepState {
  readonly profile: ProviderProfile;
  readonly collisionProfile: ProviderProfile;
}

/** Pulled out of the dialog component to keep its own branching out of the
 *  component's cyclomatic complexity count (react-doctor/eslint `complexity`
 *  budget) - see `naming`'s call site for what this gates. */
function resolveNamingStep(
  flowState: ProviderProfileLoginFlowState,
  namingCommittedFor: string | null,
): NamingStepState | null {
  if (
    flowState.kind !== "identity" ||
    flowState.existingProfileId !== null ||
    namingCommittedFor === flowState.profileId
  ) {
    return null;
  }
  const collisionProfile = findEmailCollisionProfile(
    flowState.profiles,
    flowState.profile,
  );
  return collisionProfile === null
    ? null
    : { profile: flowState.profile, collisionProfile };
}
