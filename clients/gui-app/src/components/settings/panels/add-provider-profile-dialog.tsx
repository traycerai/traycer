import { useProvidersLoginOwnershipForClient } from "@/hooks/providers/use-providers-login-ownership";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  Link2,
  LogIn,
} from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderCliState,
  type ProviderLoginRefusal,
  type ProviderLoginTarget,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  ADD_PROFILE_DIALOG_TITLE,
  alreadySignedInAsText,
  SIGN_IN_TEXT,
  SIGN_IN_WITH_ANOTHER_TEXT,
  signedInAsText,
  USE_PROFILE_TEXT,
  WAITING_FOR_PROFILE_TEXT,
} from "@/components/providers/profile-sync-copy";
import {
  useCachedProviderProfilesReader,
  useCachedProvidersList,
  type CachedProviderProfilesReader,
} from "@/hooks/providers/use-cached-providers-list";
import { listOffersSignIns } from "@/components/providers/provider-profile-model";
import { PROVIDER_STATE_UNREADABLE_COPY } from "@/lib/providers/provider-settings-unreadable-error";
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
import { useProvidersDestinationAwaitLoginForClient } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersCancelLoginForClient } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useProvidersEnsurePackForClient } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import { useProvidersSubmitLoginCodeForClient } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLoginForClient } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useRecolorProviderProfileForClient } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRenameProviderProfileForClient } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useOpenLink } from "@/lib/links/open-link";
import { redactEmail } from "@/lib/providers/redact-email";
import type { ProviderLoginStartCopy } from "@/components/providers/provider-login-start";
import {
  ProviderLoginRefusalAction,
  ProviderLoginRefusalMessage,
} from "@/components/providers/provider-login-refusal";
import {
  providerHostBlock,
  providerHostBlockLabel,
  type ProviderHostBlock,
} from "@/components/providers/provider-signin-availability";
import { providerLoginRetryLabel } from "@/lib/providers/provider-login-retry-label";
import { CodePasteField, CodePasteRestartNotice } from "./code-paste-field";
import { SignInCopyIconButton } from "./sign-in-copy-icon-button";
import {
  openBrowserLabel,
  useAutoOpenLoginUrl,
} from "./use-auto-open-login-url";
import { waitingStepCopy } from "./waiting-step-copy";
import {
  useProviderDestinationLoginFlow,
  providerProfileLoginProgress,
  type ProviderProfileLoginFlowCodePaste,
  type ProviderProfileLoginFlowState,
  type ProviderTargetLoginResult,
} from "./use-provider-profile-login-flow";
import { CredentialRefusalNote } from "@/components/providers/credential-refusal-note";
import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";

/**
 * Whether a new managed profile for this provider can SHARE the ambient
 * `skills/` and `plugins/` directories instead of copying them - i.e. whether
 * the "Share skills and plugins" checkbox does anything.
 *
 * The real driver is host-side: `seedManagedProfileDir` honours
 * `shareSkillsAndPlugins` only on the `partial-overlay` layout branch
 * (`profile-seeding.ts`), which today is claude-code alone. Codex also has
 * profiles and is also excluded, and that exclusion is CORRECT rather than an
 * oversight: codex takes the `overlay` branch, whose seeding never reads the
 * flag, so offering the checkbox there would send a request the host silently
 * discards.
 *
 * Exhaustive rather than the `providerId === "claude-code"` test it replaces.
 * The old check would have kept quietly answering "no" for a future provider on
 * the partial-overlay layout - a checkbox that should render and doesn't is
 * invisible, so nothing would ever have reported it. This is still a second
 * registration point for a host-side fact; a capability flag on the wire would
 * be the deeper fix, and is deliberately not being minted for a single-member
 * set on a released schema.
 */
const PROVIDER_SHARES_SKILLS_AND_PLUGINS: Record<
  ProviderCliState["providerId"],
  boolean
> = {
  "claude-code": true,
  codex: false,
  opencode: false,
  cursor: false,
  traycer: false,
  openrouter: false,
  huggingface: false,
  grok: false,
  qwen: false,
  kiro: false,
  droid: false,
  kimi: false,
  copilot: false,
  kilocode: false,
  amp: false,
  devin: false,
  pi: false,
  hermes: false,
  omp: false,
  reasonix: false,
  antigravity: false,
  commandcode: false,
};

export interface FailedProviderProfileAttempt {
  readonly providerId: ProviderCliState["providerId"];
  readonly message: string;
}

export interface ProviderTargetLoginControls {
  readonly onSignInWithAnother: () => void;
  readonly accentColor: ProviderProfileAccentColor;
}

/** Whether "Link account" is held off: any one reason is enough. */
function linkHeldOff(reasons: {
  readonly labelEmpty: boolean;
  readonly busy: boolean;
  readonly credentialRefused: boolean;
  readonly macosBlocked: boolean;
}): boolean {
  return (
    reasons.labelEmpty ||
    reasons.busy ||
    reasons.credentialRefused ||
    reasons.macosBlocked
  );
}

interface AddProviderProfileDialogProps {
  readonly target: ProviderLoginTarget | null;
  readonly targetResult:
    | ((
        result: ProviderTargetLoginResult,
        controls: ProviderTargetLoginControls,
      ) => ReactNode)
    | null;
  readonly state: ProviderCliState;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly isLocalHost: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null` retracts a previously reported failure: fired when a new attempt
   *  starts and when an attempt completes, so a stale "sign-in did not
   *  finish" banner never sits next to a profile that DID sign in. */
  readonly onFailedAttempt: (
    attempt: FailedProviderProfileAttempt | null,
  ) => void;
  readonly onProfileCreated: (profileId: string) => void;
}

export function AddProviderProfileDialog(
  props: AddProviderProfileDialogProps,
): ReactNode {
  return (
    <ProviderProfileSignInDialog {...props} switchSourceProfileId={null} />
  );
}

export function SwitchAccountSignInDialog(
  props: AddProviderProfileDialogProps & {
    readonly switchSourceProfileId: string;
  },
): ReactNode {
  return <ProviderProfileSignInDialog {...props} />;
}

function ProviderProfileSignInDialog({
  state,
  client,
  isLocalHost,
  open,
  onOpenChange,
  onFailedAttempt,
  onProfileCreated,
  target,
  targetResult,
  switchSourceProfileId,
}: AddProviderProfileDialogProps & {
  readonly switchSourceProfileId: string | null;
}): ReactNode {
  const openLink = useOpenLink();
  // Every entry point gates on the target host already; this is the floor
  // under all of them, so no sign-in ever starts on a sandbox.
  const credentialRefusal = useHostCredentialRefusal(
    client === null ? null : client.getActiveHostId(),
  );
  const supportsShareSkillsAndPlugins =
    PROVIDER_SHARES_SKILLS_AND_PLUGINS[state.providerId];
  const [shareSkillsAndPlugins, setShareSkillsAndPlugins] = useState(
    supportsShareSkillsAndPlugins,
  );
  const [label, setLabel] = useState("New profile");
  const [accentColor, setAccentColor] = useState<ProviderProfileAccentColor>(
    () => nextAvailableAccentColor(state.profiles),
  );
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
  const awaitLogin = useProvidersDestinationAwaitLoginForClient(
    {
      client,
      getCacheHostId: () => client?.getActiveHostId() ?? null,
    },
    target !== null,
  );
  const cancelLogin = useProvidersCancelLoginForClient(client);
  const submitLoginCode = useProvidersSubmitLoginCodeForClient(client);
  const touchLogin = useProvidersTouchLoginForClient(client);
  const ensurePack = useProvidersEnsurePackForClient(client);
  const recolorProfile = useRecolorProviderProfileForClient(client);
  const renameProfile = useRenameProviderProfileForClient(client);
  const supportsLoginOwnership = useProvidersLoginOwnershipForClient(client);
  const hostBlock = providerHostBlock(state, "sign-in-and-enable");
  const macosBlock = hostBlock?.kind === "macos" ? hostBlock : null;
  const { offersSignIns, profileOutcomes } = useAddProfileOutcomes(
    client,
    state.providerId,
    target,
  );
  const flow = useProviderDestinationLoginFlow(
    {
      hostBlock,
      supportsLoginOwnership,
      mode: "create",
      providerId: state.providerId,
      existingProfileId: null,
      loginCapability: state.loginCapability,
      startLogin,
      awaitLogin,
      cancelLogin,
      submitLoginCode,
      touchLogin,
      ensurePack,
      failureMessages: {
        notStarted:
          "Sign-in did not start. You can retry when the provider is available.",
        notFinished: "Sign-in did not finish. Retry when you are ready.",
      },
      onFailed: (message) =>
        onFailedAttempt({ providerId: state.providerId, message }),
    },
    profileOutcomes,
    target,
    client,
  );
  const targetTerminal = destinationResult(flow.state);
  const trimmedLabel = label.trim();
  const linking = flow.state.kind !== "start";
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
      onOpenChange(false);
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
    onOpenChange(nextOpen);
  };

  const linkAccount = (): void => {
    if (trimmedLabel.length === 0 || credentialRefusal !== null) return;
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
        layout="banded"
        className="flex max-h-[min(85dvh,42rem)] w-[min(92vw,30rem)] flex-col overflow-hidden sm:max-w-none"
        showCloseButton={dialogShowsCloseButton(flow.state)}
        onEscapeKeyDown={(event) => {
          if (dismissalLocked) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (dismissalLocked) event.preventDefault();
        }}
        {...dialogDescriptionProps(offersSignIns)}
      >
        <AddProfileDialogHeader
          offersSignIns={offersSignIns}
          providerId={state.providerId}
        />

        {targetTerminal === null ? (
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pb-5">
            <AddProfileSetupFields
              target={target}
              profiles={state.profiles}
              label={label}
              onLabelChange={setLabel}
              accentColor={accentColor}
              onAccentColorChange={setAccentColor}
              linking={linking}
              naming={naming !== null}
              finalizing={finalizing}
              supportsShareSkillsAndPlugins={supportsShareSkillsAndPlugins}
              shareSkillsAndPlugins={shareSkillsAndPlugins}
              onShareSkillsAndPluginsChange={setShareSkillsAndPlugins}
            />

            <CredentialRefusalNote refusal={credentialRefusal} />
            <ProfileMacosNotice
              block={macosBlock}
              providerId={state.providerId}
              visible={flow.state.kind === "start"}
            />
            <AddProfileAccountSection
              providerId={state.providerId}
              flowState={flow.state}
              loginCapability={state.loginCapability}
              isLocalHost={isLocalHost}
              offersSignIns={offersSignIns}
              startPending={flow.startPending}
              startingCopy={flow.startingCopy}
              cancelPending={flow.cancelPending}
              cancelDisabled={flow.commitPending}
              codePaste={flow.codePaste}
              finalizing={finalizing}
              finalizeError={recolorProfile.error}
              duplicateProfile={duplicateProfile}
              naming={naming}
              namingError={renameProfile.error}
              emailRevealed={emailRevealed}
              setEmailRevealed={setEmailRevealed}
              linkDisabled={linkHeldOff({
                labelEmpty: trimmedLabel.length === 0,
                busy: flow.busy,
                credentialRefused: credentialRefusal !== null,
                macosBlocked: macosBlock !== null,
              })}
              onLink={linkAccount}
              onOpenExternalLink={(url) => {
                void openLink(url, "auth", null);
              }}
              onCancel={() => close(false)}
              onRetryLogin={linkAccount}
              onRetryFinalize={retryFinalize}
            />
          </div>
        ) : (
          targetResult?.(targetTerminal, {
            onSignInWithAnother: linkAccount,
            accentColor,
          })
        )}
        {flow.state.kind === "start" ? (
          <DialogFooter>
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
          <DialogFooter>
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
        <AddProfileOutcomeFooter
          flowState={flow.state}
          sameAccountProfileId={switchSourceProfileId}
          offersSignIns={offersSignIns}
          showsSignedIn={naming === null && recolorProfile.error === null}
          finalizing={finalizing}
          signInAgainDisabled={credentialRefusal !== null}
          onUse={complete}
          onSignInWithAnother={linkAccount}
          listRereadPending={flow.listRereadPending}
          onRetryListRead={flow.retryListRead}
          onDone={() => {
            onFailedAttempt(null);
            onOpenChange(false);
          }}
        />
        {duplicateProfile !== null ? (
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={credentialRefusal !== null}
              onClick={linkAccount}
            >
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
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether this dialog reads a completed sign-in's `profileOutcome`: only on a
 * computer that offers sign-ins by itself, by the list `state` came from (read
 * from the cache its caller keeps, never fetched here).
 */
function useAddProfileOutcomes(
  client: HostClient<HostRpcRegistry> | null,
  providerId: ProviderCliState["providerId"],
  target: ProviderLoginTarget | null,
): {
  readonly offersSignIns: boolean;
  readonly profileOutcomes: CachedProviderProfilesReader | null;
} {
  const source = target === null ? client : null;
  const offersSignIns = listOffersSignIns(useCachedProvidersList(source));
  const reader = useCachedProviderProfilesReader(source, providerId);
  return {
    offersSignIns: target !== null || offersSignIns,
    profileOutcomes: target === null && offersSignIns ? reader : null,
  };
}

function addProfileDialogTitle(
  offersSignIns: boolean,
  providerId: ProviderCliState["providerId"],
): string {
  return offersSignIns
    ? ADD_PROFILE_DIALOG_TITLE
    : `Add new ${PROVIDER_DISPLAY_NAMES[providerId]} profile`;
}

const NO_DIALOG_DESCRIPTION = { "aria-describedby": undefined } as const;

/**
 * A computer that offers sign-ins draws no line under the header, so the
 * dialog says it has no description; any other keeps today's, which Radix
 * links by itself.
 */
function dialogDescriptionProps(
  offersSignIns: boolean,
): typeof NO_DIALOG_DESCRIPTION | null {
  return offersSignIns ? NO_DIALOG_DESCRIPTION : null;
}

function AddProfileDialogHeader({
  offersSignIns,
  providerId,
}: {
  readonly offersSignIns: boolean;
  readonly providerId: ProviderCliState["providerId"];
}): ReactNode {
  return (
    <DialogHeader className="gap-1.5">
      <DialogTitle>
        {addProfileDialogTitle(offersSignIns, providerId)}
      </DialogTitle>
      {offersSignIns ? null : (
        <DialogDescription>
          Name this {PROVIDER_DISPLAY_NAMES[providerId]} profile, choose its
          color, then link the account it should use.
        </DialogDescription>
      )}
    </DialogHeader>
  );
}

/**
 * The × is held while a sign-in runs and its profile is set up, and returns
 * once a completed sign-in rests on a sentence the person reads: closing then
 * never cancels, since the sign-in is already done.
 */
function dialogShowsCloseButton(
  flowState: ProviderProfileLoginFlowState,
): boolean {
  return (
    flowState.kind === "start" ||
    flowState.kind === "already-signed-in" ||
    flowState.kind === "waiting-for-profile" ||
    flowState.kind === "list-unread"
  );
}

function ProfileMacosNotice({
  block,
  providerId,
  visible,
}: {
  readonly block: Extract<ProviderHostBlock, { kind: "macos" }> | null;
  readonly providerId: ProviderCliState["providerId"];
  readonly visible: boolean;
}): ReactNode {
  if (block === null || !visible) return null;
  return (
    <p role="status" className="text-ui-sm text-muted-foreground">
      {providerHostBlockLabel(block, PROVIDER_DISPLAY_NAMES[providerId])}
    </p>
  );
}

function AddProfileAccountSection({
  providerId,
  flowState,
  loginCapability,
  isLocalHost,
  offersSignIns,
  startPending,
  startingCopy,
  cancelPending,
  cancelDisabled,
  codePaste,
  finalizing,
  finalizeError,
  duplicateProfile,
  naming,
  namingError,
  emailRevealed,
  setEmailRevealed,
  linkDisabled,
  onLink,
  onOpenExternalLink,
  onCancel,
  onRetryLogin,
  onRetryFinalize,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly flowState: ProviderProfileLoginFlowState;
  readonly loginCapability: ProviderCliState["loginCapability"] | null;
  readonly isLocalHost: boolean;
  readonly offersSignIns: boolean;
  readonly startPending: boolean;
  readonly startingCopy: ProviderLoginStartCopy | null;
  readonly cancelPending: boolean;
  readonly cancelDisabled: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly finalizing: boolean;
  readonly finalizeError: Error | null;
  readonly duplicateProfile: ProviderProfile | null;
  readonly naming: NamingStepState | null;
  readonly namingError: Error | null;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
  readonly linkDisabled: boolean;
  readonly onLink: () => void;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
  readonly onRetryLogin: () => void;
  readonly onRetryFinalize: () => void;
}): ReactNode {
  const signInBody = offersSignIns
    ? signInAccountBody({
        providerId,
        flowState,
        settingUp:
          duplicateProfile === null &&
          naming === null &&
          finalizeError === null,
        linkDisabled,
        onLink,
      })
    : null;
  if (signInBody !== null) return signInBody;

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
          {...providerProfileLoginProgress(flowState)}
          loginCapability={loginCapability}
          isLocalHost={isLocalHost}
          queuePending={startPending}
          startingCopy={startingCopy}
          cancelPending={cancelPending}
          cancelDisabled={cancelDisabled}
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
        providerId={providerId}
        message={flowState.message}
        refusal={flowState.refusal}
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
        emailRevealed={emailRevealed}
        setEmailRevealed={setEmailRevealed}
      />
    );
  }

  if (finalizeError !== null) {
    return (
      <AddProfileFailureStep
        providerId={providerId}
        message="The account was linked, but the profile color could not be saved."
        refusal={null}
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

/**
 * What the account section shows on a computer that offers sign-ins by
 * itself, where that differs from any other computer, or null: the Sign in
 * card, the profile an existing account already has, the provider while the
 * list catches up, and a new profile's row while it is set up (`settingUp`:
 * no duplicate notice, naming step or failed recolor stands in front of it).
 */
function signInAccountBody({
  providerId,
  flowState,
  settingUp,
  linkDisabled,
  onLink,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly flowState: ProviderProfileLoginFlowState;
  readonly settingUp: boolean;
  readonly linkDisabled: boolean;
  readonly onLink: () => void;
}): ReactNode {
  switch (flowState.kind) {
    case "start":
      return <SignInCard disabled={linkDisabled} onSignIn={onLink} />;
    case "already-signed-in":
      return (
        <AlreadySignedInBody
          providerId={providerId}
          profile={flowState.profile}
        />
      );
    case "waiting-for-profile":
    case "list-unread":
      return (
        <p className="text-ui-sm text-muted-foreground">
          {PROVIDER_DISPLAY_NAMES[providerId]}
        </p>
      );
    case "identity":
      return settingUp ? (
        <ProfileAccountRow
          providerId={providerId}
          profile={flowState.profile}
        />
      ) : null;
    default:
      return null;
  }
}

/** The account card of a computer that offers sign-ins by itself. */
function SignInCard({
  disabled,
  onSignIn,
}: {
  readonly disabled: boolean;
  readonly onSignIn: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={SIGN_IN_TEXT}
      className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-foreground/3 p-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onSignIn}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border/60 transition-colors group-hover:text-foreground">
        <LogIn className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui-sm font-medium text-foreground">
          {SIGN_IN_TEXT}
        </span>
        <span className="block text-ui-xs text-muted-foreground">
          Sign in to the account this profile should use.
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

/** A profile's name and dot with its provider, as the dialog's body. */
function ProfileAccountRow({
  providerId,
  profile,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly profile: ProviderProfile;
}): ReactNode {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-ui-sm">
      <span className="flex min-w-0 items-center gap-2">
        <AccentDot
          profileId={profile.profileId}
          accentColor={profile.accentColor}
          label={profile.label}
          variant="inline"
          size="default"
          className={undefined}
        />
        <span className="min-w-0 truncate font-medium text-foreground">
          {profile.label}
        </span>
      </span>
      <span className="shrink-0 text-muted-foreground">
        {PROVIDER_DISPLAY_NAMES[providerId]}
      </span>
    </div>
  );
}

/**
 * The body when Add finished as an account that already has a profile: that
 * profile's row and nothing else. `DuplicateAccountNotice` is the computer
 * that does not offer sign-ins by itself.
 */
function AlreadySignedInBody({
  providerId,
  profile,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly profile: ProviderProfile;
}): ReactNode {
  return <ProfileAccountRow providerId={providerId} profile={profile} />;
}

/** One footer sentence beside the footer's buttons. */
function FooterSentence({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p
      role="status"
      className="min-w-0 text-ui-sm text-foreground sm:order-first sm:mr-auto sm:self-center"
    >
      {children}
    </p>
  );
}

/**
 * The footer a completed sign-in ends on, on a computer that offers sign-ins
 * by itself: `Signed in as` while a new profile finishes, `Already signed in
 * as` with Use and Sign in with another, or the wait for the list with Done.
 * Nothing on any other computer.
 */
function AddProfileOutcomeFooter({
  flowState,
  sameAccountProfileId,
  offersSignIns,
  showsSignedIn,
  finalizing,
  signInAgainDisabled,
  onUse,
  onSignInWithAnother,
  listRereadPending,
  onRetryListRead,
  onDone,
}: {
  readonly flowState: ProviderProfileLoginFlowState;
  readonly sameAccountProfileId: string | null;
  readonly offersSignIns: boolean;
  /** No naming step and no failed recolor stands in front of it. */
  readonly showsSignedIn: boolean;
  readonly finalizing: boolean;
  readonly signInAgainDisabled: boolean;
  readonly onUse: (profileId: string) => void;
  readonly onSignInWithAnother: () => void;
  readonly listRereadPending: boolean;
  readonly onRetryListRead: () => void;
  readonly onDone: () => void;
}): ReactNode {
  if (!offersSignIns) return null;
  if (flowState.kind === "list-unread") {
    return (
      <DialogFooter>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={listRereadPending}
          onClick={onRetryListRead}
        >
          {listRereadPending ? <MutedAgentSpinner /> : null}
          Retry
        </Button>
        <FooterSentence>{PROVIDER_STATE_UNREADABLE_COPY}</FooterSentence>
      </DialogFooter>
    );
  }
  if (
    flowState.kind === "identity" &&
    flowState.existingProfileId === null &&
    showsSignedIn
  ) {
    return (
      <DialogFooter>
        {finalizing ? <MutedAgentSpinner /> : null}
        <FooterSentence>
          {signedInAsText(flowState.profile.label)}
        </FooterSentence>
      </DialogFooter>
    );
  }
  if (flowState.kind === "already-signed-in") {
    const { profile } = flowState;
    if (sameAccountProfileId === profile.profileId) {
      return (
        <DialogFooter>
          <FooterSentence>
            {alreadySignedInAsText(profile.label)}
          </FooterSentence>
          <Button type="button" size="sm" onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      );
    }
    return (
      <DialogFooter>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={signInAgainDisabled}
          onClick={onSignInWithAnother}
        >
          {SIGN_IN_WITH_ANOTHER_TEXT}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onUse(profile.profileId)}
        >
          {USE_PROFILE_TEXT}
        </Button>
        <FooterSentence>{alreadySignedInAsText(profile.label)}</FooterSentence>
      </DialogFooter>
    );
  }
  if (flowState.kind === "waiting-for-profile") {
    return (
      <DialogFooter>
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
        <FooterSentence>{WAITING_FOR_PROFILE_TEXT}</FooterSentence>
      </DialogFooter>
    );
  }
  return null;
}

function DuplicateAccountNotice({
  profile,
}: {
  readonly profile: ProviderProfile;
}): ReactNode {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-warning-foreground">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-ui-sm font-medium">Account already linked</div>
        <p className="mt-0.5 text-ui-xs leading-relaxed">
          {profile.label} already uses this account and organization. Sign in
          again and choose a different organization.
        </p>
      </div>
    </div>
  );
}

function AddProfileNamingStep({
  profile,
  collisionProfile,
  error,
  emailRevealed,
  setEmailRevealed,
}: {
  readonly profile: ProviderProfile;
  readonly collisionProfile: ProviderProfile;
  readonly error: Error | null;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
}): ReactNode {
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
      {error !== null ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-ui-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>Couldn&apos;t save the name. Try again.</span>
        </div>
      ) : null}
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

export function WaitingStepDeviceCode(props: {
  readonly processingCode: boolean;
  readonly userCode: string | null;
}): ReactNode {
  if (props.processingCode || props.userCode === null) return null;
  const { userCode } = props;
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6">
      <code className="rounded-md border border-border/60 bg-foreground/5 px-2.5 py-1 font-mono text-ui tracking-[0.12em] text-foreground">
        {userCode}
      </code>
      <SignInCopyIconButton value={userCode} kind="code" variant="outline" />
    </div>
  );
}

export function WaitingStepUrlActions(props: {
  readonly processingCode: boolean;
  readonly loginUrl: string | null;
  readonly autoOpen: boolean;
  readonly onOpenExternalLink: (url: string) => void;
}): ReactNode {
  if (props.processingCode || props.loginUrl === null) return null;
  const { loginUrl, autoOpen, onOpenExternalLink } = props;
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onOpenExternalLink(loginUrl)}
      >
        <ExternalLink className="size-3.5" />
        {openBrowserLabel(autoOpen)}
      </Button>
      <SignInCopyIconButton value={loginUrl} kind="link" variant="outline" />
    </div>
  );
}

function WaitingStepPasteFallback(props: {
  readonly waiting: boolean;
  readonly processingCode: boolean;
  readonly userCode: string | null;
  readonly cancelRequested: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
}): ReactNode {
  if (!props.waiting || !props.codePaste.enabled || props.userCode !== null) {
    return null;
  }
  return (
    <div className="border-t border-border/50 pt-3">
      {props.processingCode ? null : (
        <div className="mb-2">
          <p className="text-ui-xs font-medium text-foreground">
            Didn&apos;t return automatically?
          </p>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            If the browser shows a code, paste it here.
          </p>
        </div>
      )}
      <CodePasteField
        key={props.codePaste.attemptId}
        codePaste={props.codePaste}
        disabled={props.cancelRequested}
        visibleLabel={false}
      />
    </div>
  );
}

export function AddProfileWaitingStep({
  loginUrl,
  userCode,
  loginCapability,
  isLocalHost,
  queuePending,
  startingCopy,
  cancelRequested,
  cancelPending,
  cancelDisabled,
  waiting,
  readerCount,
  codePaste,
  onOpenExternalLink,
  onCancel,
}: {
  readonly loginUrl: string | null;
  readonly userCode: string | null;
  /** Read only for `selfOpensBrowser` - whether this provider's own child
   *  already opened a browser, which decides whether the GUI opens one too.
   *  `userCode` above is still the paste-flow signal and is NOT that fact. */
  readonly loginCapability: ProviderCliState["loginCapability"] | null;
  readonly isLocalHost: boolean;
  readonly queuePending: boolean;
  /** The flow's `startingCopy`: what a slow start says instead of "Opening
   *  the sign-in page…". */
  readonly startingCopy: ProviderLoginStartCopy | null;
  readonly cancelRequested: boolean;
  readonly cancelPending: boolean;
  readonly cancelDisabled: boolean;
  /** True only once the flow has reached `waiting` (a live profileId/child
   *  exists). The paste field renders only then - during `starting` there
   *  is nothing yet for a submit to reach, and rendering it anyway would
   *  let a user's paste silently lock the field without ever being sent.
   */
  readonly waiting: boolean;
  readonly readerCount?: number;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const autoOpen = useAutoOpenLoginUrl(
    isLocalHost,
    loginCapability,
    loginUrl,
    onOpenExternalLink,
  );
  const processingCode = codePaste.phase !== "idle";
  const deviceCode = userCode !== null;
  const { title, guidance } = waitingStepCopy({
    phase: codePaste.phase,
    queuePending,
    startingCopy,
    cancelRequested,
    deviceCode,
  });

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {codePaste.restartNotice !== null ? (
        <CodePasteRestartNotice message={codePaste.restartNotice} />
      ) : null}
      <div className="flex items-start gap-2.5">
        <MutedAgentSpinner />
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            {readerCount === undefined
              ? title
              : `Waiting for ${readerCount} ${readerCount === 1 ? "agent" : "agents"} on this profile`}
          </div>
          {readerCount === undefined && guidance !== null ? (
            <p className="mt-0.5 text-ui-xs leading-relaxed text-muted-foreground">
              {guidance}
            </p>
          ) : null}
        </div>
      </div>

      <WaitingStepDeviceCode
        processingCode={processingCode}
        userCode={userCode}
      />
      <WaitingStepUrlActions
        processingCode={processingCode}
        loginUrl={loginUrl}
        autoOpen={autoOpen}
        onOpenExternalLink={onOpenExternalLink}
      />
      <WaitingStepPasteFallback
        waiting={waiting}
        processingCode={processingCode}
        userCode={userCode}
        cancelRequested={cancelRequested}
        codePaste={codePaste}
      />

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
            <Badge variant="outline" className="h-5" size="xs">
              {tier}
            </Badge>
          ) : null}
        </div>
      </div>
      {duplicateLabel !== null ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-ui-xs text-warning-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>This is the same account as {duplicateLabel}.</span>
        </div>
      ) : null}
    </div>
  );
}

function AddProfileFailureStep({
  providerId,
  message,
  refusal,
  onCancel,
  onRetry,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly message: string;
  readonly refusal: ProviderLoginRefusal | null;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-ui-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        {refusal === null ? (
          <span>{message}</span>
        ) : (
          <ProviderLoginRefusalMessage
            providerId={providerId}
            refusal={refusal}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <ProviderLoginRefusalAction refusal={refusal} />
        <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
          {providerLoginRetryLabel(refusal, "Retry")}
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Provider sign-in failed",
            message: null,
            code: null,
            source: "Add profile",
          })}
          presentation="link"
          className={undefined}
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

function destinationResult(
  state: ProviderProfileLoginFlowState,
): ProviderTargetLoginResult | null {
  return state.kind === "target-refused" || state.kind === "target-outcome"
    ? state
    : null;
}

function AddProfileSetupFields(props: {
  readonly target: ProviderLoginTarget | null;
  readonly profiles: readonly ProviderProfile[];
  readonly label: string;
  readonly onLabelChange: (label: string) => void;
  readonly accentColor: ProviderProfileAccentColor;
  readonly onAccentColorChange: (color: ProviderProfileAccentColor) => void;
  readonly linking: boolean;
  readonly naming: boolean;
  readonly finalizing: boolean;
  readonly supportsShareSkillsAndPlugins: boolean;
  readonly shareSkillsAndPlugins: boolean;
  readonly onShareSkillsAndPluginsChange: (value: boolean) => void;
}): ReactNode {
  if (props.target?.kind === "leave-to-local") return null;
  return (
    <>
      <ProviderProfileCard
        profile={null}
        profiles={props.profiles}
        label={props.label}
        onLabelChange={props.onLabelChange}
        selectedColor={props.accentColor}
        onSelectColor={props.onAccentColorChange}
        disabled={(props.linking && !props.naming) || props.finalizing}
      />
      {props.supportsShareSkillsAndPlugins ? (
        <ShareSkillsAndPluginsField
          checked={props.shareSkillsAndPlugins}
          disabled={props.linking || props.finalizing}
          onCheckedChange={props.onShareSkillsAndPluginsChange}
        />
      ) : null}
    </>
  );
}
