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
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderCliState,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProvidersStartLoginForClient } from "@/hooks/providers/use-providers-start-login-mutation";
import { useProvidersAwaitLoginForClient } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersCancelLoginForClient } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useProvidersSubmitLoginCodeForClient } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLoginForClient } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useRecolorProviderProfileForClient } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { redactEmail } from "@/lib/providers/redact-email";
import { CodePasteField, CodePasteRestartNotice } from "./code-paste-field";
import { handleSignInLinkCopyError } from "./provider-sign-in-link";
import { waitingStepCopy } from "./waiting-step-copy";
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

export function AddProviderProfileDialog({
  state,
  client,
  open,
  onOpenChange,
  onFailedAttempt,
  onProfileCreated,
}: {
  readonly state: ProviderCliState;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null` retracts a previously reported failure: fired when a new attempt
   *  starts and when an attempt completes, so a stale "sign-in did not
   *  finish" banner never sits next to a profile that DID sign in. */
  readonly onFailedAttempt: (
    attempt: FailedProviderProfileAttempt | null,
  ) => void;
  readonly onProfileCreated: (profileId: string) => void;
}): ReactNode {
  const openExternalLink = useRunnerOpenExternalLink();
  const supportsShareSkillsAndPlugins = state.providerId === "claude-code";
  const [shareSkillsAndPlugins, setShareSkillsAndPlugins] = useState(
    supportsShareSkillsAndPlugins,
  );
  const [label, setLabel] = useState("New profile");
  const [accentColor, setAccentColor] = useState<ProviderProfileAccentColor>(
    () => nextAvailableAccentColor(state.profiles),
  );
  const finalizeAttemptRef = useRef<string | null>(null);
  const startLogin = useProvidersStartLoginForClient(client);
  const awaitLogin = useProvidersAwaitLoginForClient({
    client,
    getCacheHostId: () => client?.getActiveHostId() ?? null,
  });
  const cancelLogin = useProvidersCancelLoginForClient(client);
  const submitLoginCode = useProvidersSubmitLoginCodeForClient(client);
  const touchLogin = useProvidersTouchLoginForClient(client);
  const recolorProfile = useRecolorProviderProfileForClient(client);
  const flow = useProviderProfileLoginFlow({
    mode: "create",
    providerId: state.providerId,
    existingProfileId: null,
    loginCapability: state.loginCapability,
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
  const linking = flow.state.kind !== "start";
  const finalizing = recolorProfile.isPending;
  const identityCompletionPending =
    flow.state.kind === "identity" &&
    flow.state.existingProfileId === null &&
    recolorProfile.error === null;
  const dismissalLocked =
    flow.commitPending || finalizing || identityCompletionPending;

  const complete = (profileId: string): void => {
    onFailedAttempt(null);
    onProfileCreated(profileId);
    onOpenChange(false);
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

  useEffect(() => {
    if (flow.state.kind === "cancelled") {
      onOpenChange(false);
      return;
    }
    if (
      flow.state.kind !== "identity" ||
      flow.state.existingProfileId !== null ||
      finalizeAttemptRef.current === flow.state.profileId
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
    onOpenChange(nextOpen);
  };

  const linkAccount = (): void => {
    if (trimmedLabel.length === 0) return;
    // A fresh attempt supersedes any previously reported failure - covers
    // both the initial "Link account" and the failed-state Retry.
    onFailedAttempt(null);
    flow.start({
      label: trimmedLabel,
      shareSkillsAndPlugins:
        supportsShareSkillsAndPlugins && shareSkillsAndPlugins,
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
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="max-h-[min(85dvh,42rem)] w-[min(92vw,30rem)] gap-0 overflow-y-auto p-0 sm:max-w-none"
        showCloseButton={!linking}
        onEscapeKeyDown={(event) => {
          if (dismissalLocked) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (dismissalLocked) event.preventDefault();
        }}
      >
        <DialogHeader className="gap-1.5 px-5 pt-5 pr-12 pb-4">
          <DialogTitle className="text-ui font-semibold leading-snug">
            Add new {PROVIDER_DISPLAY_NAMES[state.providerId]} profile
          </DialogTitle>
          <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground">
            Name this {PROVIDER_DISPLAY_NAMES[state.providerId]} profile, choose
            its color, then link the account it should use.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-5 pb-5">
          <ProviderProfileCard
            profile={null}
            profiles={state.profiles}
            label={label}
            onLabelChange={setLabel}
            selectedColor={accentColor}
            onSelectColor={setAccentColor}
            disabled={linking || finalizing}
          />

          {supportsShareSkillsAndPlugins ? (
            <ShareSkillsAndPluginsField
              checked={shareSkillsAndPlugins}
              disabled={linking || finalizing}
              onCheckedChange={setShareSkillsAndPlugins}
            />
          ) : null}

          <AddProfileAccountSection
            flowState={flow.state}
            startPending={flow.startPending}
            cancelPending={flow.cancelPending}
            cancelDisabled={flow.commitPending}
            codePaste={flow.codePaste}
            finalizing={finalizing}
            finalizeError={recolorProfile.error}
            duplicateProfile={duplicateProfile}
            linkDisabled={trimmedLabel.length === 0 || flow.busy}
            onLink={linkAccount}
            onOpenExternalLink={(url) => openExternalLink.mutate(url)}
            onCancel={() => close(false)}
            onRetryLogin={linkAccount}
            onRetryFinalize={retryFinalize}
          />
        </div>

        {flow.state.kind === "start" ? (
          <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-muted/20 px-5 py-3">
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
        {duplicateProfile !== null ? (
          <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-muted/20 px-5 py-3">
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
      </DialogContent>
    </Dialog>
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
  linkDisabled,
  onLink,
  onOpenExternalLink,
  onCancel,
  onRetryLogin,
  onRetryFinalize,
}: {
  readonly flowState: ProviderProfileLoginFlowState;
  readonly startPending: boolean;
  readonly cancelPending: boolean;
  readonly cancelDisabled: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly finalizing: boolean;
  readonly finalizeError: Error | null;
  readonly duplicateProfile: ProviderProfile | null;
  readonly linkDisabled: boolean;
  readonly onLink: () => void;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
  readonly onRetryLogin: () => void;
  readonly onRetryFinalize: () => void;
}): ReactNode {
  if (flowState.kind === "start") {
    return (
      <button
        type="button"
        aria-label="Link account"
        className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50"
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
      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        <span>Cancelling sign-in</span>
      </div>
    );
  }

  if (duplicateProfile !== null) {
    return <DuplicateAccountNotice profile={duplicateProfile} />;
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
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-ui-sm text-muted-foreground">
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
          This account is already linked to {profile.label}. No new profile was
          created.
        </p>
      </div>
    </div>
  );
}

function ShareSkillsAndPluginsField({
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (value: boolean) => void;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-ui-sm text-muted-foreground">
      <Checkbox
        id={id}
        aria-label="Use terminal account skills and plugins"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <label
        htmlFor={id}
        className="flex min-w-0 cursor-pointer flex-col gap-0.5 select-none"
      >
        <span className="text-foreground">Use terminal skills and plugins</span>
        <span>
          Share the terminal account&apos;s installed skills and plugins with
          this profile.
        </span>
      </label>
    </div>
  );
}

export function AddProfileWaitingStep({
  loginUrl,
  queuePending,
  cancelRequested,
  cancelPending,
  cancelDisabled,
  waiting,
  codePaste,
  onOpenExternalLink,
  onCancel,
}: {
  readonly loginUrl: string | null;
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
      <div className="rounded-md border border-border/60 bg-muted/20 p-3">
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

function nextAvailableAccentColor(
  profiles: readonly ProviderProfile[],
): ProviderProfileAccentColor {
  const used = new Set(profiles.map((profile) => profile.accentColor));
  return (
    PROVIDER_PROFILE_ACCENT_COLORS.find((color) => !used.has(color)) ??
    PROVIDER_PROFILE_ACCENT_COLORS[0]
  );
}
