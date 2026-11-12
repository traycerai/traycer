import { EnvironmentProfileSignIn } from "@/components/providers/environment-profile-sign-in";
import {
  useEnvironmentProfileSignInSupported,
  useProfileSignInEnvironment,
} from "@/hooks/providers/use-profile-sign-in-environment";
import { useProvidersLoginOwnershipForClient } from "@/hooks/providers/use-providers-login-ownership";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff } from "lucide-react";
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
import { useProvidersEnsurePackForClient } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import { useProvidersSubmitLoginCodeForClient } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLoginForClient } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useRecolorProviderProfileForClient } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRenameProviderProfileForClient } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useOpenLink } from "@/lib/links/open-link";
import { redactEmail } from "@/lib/providers/redact-email";
import type { ProviderLoginStartCopy } from "@/components/providers/provider-login-start";
import {
  providerHostBlock,
  providerHostBlockLabel,
  shouldAutoOpenLoginUrl,
  type ProviderHostBlock,
} from "@/components/providers/provider-signin-availability";
import { providerLoginRetryLabel } from "@/lib/providers/provider-login-retry-label";
import {
  AddProfileFailureStep,
  AddProfileSignInCard,
  AddProfileStatusCard,
  AddProfileWaitingStep,
} from "./add-profile-steps";
import {
  useProviderProfileLoginFlow,
  providerProfileLoginProgress,
  type ProviderProfileLoginFlowCodePaste,
  type ProviderProfileLoginFlowState,
} from "./use-provider-profile-login-flow";
import { CredentialRefusalNote } from "@/components/providers/credential-refusal-note";
import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";

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

/** Whether "Sign in" is held off: any one reason is enough. */
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

export interface AddProviderProfileDialogProps {
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
  const hostId = useRequesterHostId(props.client);
  const supported = useEnvironmentProfileSignInSupported(
    hostId,
    props.state.providerId,
    true,
  );
  const refusal = useHostCredentialRefusal(hostId);
  if ((hostId !== null && refusal !== null) || supported === null)
    return (
      <AddProfileRoutingDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        retry={null}
        refusal={hostId === null ? null : refusal}
      />
    );
  if (supported && props.client !== null)
    return <RoutedAddProviderProfileDialog {...props} client={props.client} />;
  return <LocalAddProviderProfileDialog {...props} />;
}

function RoutedAddProviderProfileDialog(
  props: AddProviderProfileDialogProps & {
    readonly client: HostClient<HostRpcRegistry>;
  },
): ReactNode {
  const route = useProfileSignInEnvironment(props.client);
  if (route.kind === "environment" && !route.canSignIn)
    return (
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in</DialogTitle>
            <DialogDescription>
              Ask a teammate to sign in on Providers.
            </DialogDescription>
          </DialogHeader>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    );
  if (route.kind === "environment") {
    return (
      <EnvironmentAddProviderProfileDialog
        {...props}
        client={props.client}
        environmentId={route.environmentId}
        team={route.team}
      />
    );
  }
  if (route.kind === "reading" || route.kind === "failed") {
    return (
      <AddProfileRoutingDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        retry={route.kind === "failed" ? route.retry : null}
        refusal={null}
      />
    );
  }
  return <LocalAddProviderProfileDialog {...props} />;
}

function AddProfileRoutingDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly retry: (() => void) | null;
  readonly refusal: string | null;
}): ReactNode {
  let action: ReactNode;
  if (props.refusal !== null)
    action = (
      <Button type="button" onClick={() => props.onOpenChange(false)}>
        Back
      </Button>
    );
  else if (props.retry === null) action = <MutedAgentSpinner />;
  else action = <Button onClick={props.retry}>Retry</Button>;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in</DialogTitle>
          {props.refusal === null ? (
            <DialogDescription>
              {props.retry === null
                ? "Reading where this profile will be available…"
                : "Couldn't read where this profile will be available."}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <CredentialRefusalNote refusal={props.refusal} />
        {action}
      </DialogContent>
    </Dialog>
  );
}

function LocalAddProviderProfileDialog({
  state,
  client,
  isLocalHost,
  open,
  onOpenChange,
  onFailedAttempt,
  onProfileCreated,
}: AddProviderProfileDialogProps): ReactNode {
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
  const awaitLogin = useProvidersAwaitLoginForClient({
    client,
    getCacheHostId: () => client?.getActiveHostId() ?? null,
  });
  const cancelLogin = useProvidersCancelLoginForClient(client);
  const submitLoginCode = useProvidersSubmitLoginCodeForClient(client);
  const touchLogin = useProvidersTouchLoginForClient(client);
  const ensurePack = useProvidersEnsurePackForClient(client);
  const recolorProfile = useRecolorProviderProfileForClient(client);
  const renameProfile = useRenameProviderProfileForClient(client);
  const supportsLoginOwnership = useProvidersLoginOwnershipForClient(client);
  const hostBlock = providerHostBlock(state, "sign-in-and-enable");
  const macosBlock = hostBlock?.kind === "macos" ? hostBlock : null;
  const flow = useProviderProfileLoginFlow({
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
  });
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
    // both the initial "Sign in" and the failed-state Retry.
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
    <AddProfileDialogShell
      providerId={state.providerId}
      open={open}
      onOpenChange={close}
      showCloseButton={!linking}
      dismissalLocked={dismissalLocked}
      footer={
        <AddProfileFooter
          step={addProfileFooterStep({
            started: flow.state.kind !== "start",
            naming: naming !== null,
            duplicate: duplicateProfile !== null,
          })}
          saveDisabled={trimmedLabel.length === 0 || finalizing}
          savePending={finalizing}
          signInAgainDisabled={credentialRefusal !== null}
          onCancel={() => close(false)}
          onSave={() => {
            if (naming !== null) commitNaming(naming.profile);
          }}
          onSignInAgain={linkAccount}
        />
      }
    >
      <ProviderProfileCard
        profile={null}
        profiles={state.profiles}
        label={label}
        onLabelChange={setLabel}
        selectedColor={accentColor}
        onSelectColor={setAccentColor}
        disabled={(linking && naming === null) || finalizing}
      />

      {supportsShareSkillsAndPlugins ? (
        <ShareSkillsAndPluginsField
          checked={shareSkillsAndPlugins}
          disabled={linking || finalizing}
          onCheckedChange={setShareSkillsAndPlugins}
        />
      ) : null}

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
    </AddProfileDialogShell>
  );
}

interface EnvironmentSignedIn {
  readonly profileId: string;
  /** Null when the profile arrived before this computer could read it. */
  readonly profile: ProviderProfile | null;
  /** The account already had a profile here before this sign-in. */
  readonly duplicate: boolean;
}

/**
 * The add dialog for a sign-in through the environment: the same steps as the
 * local one, with the environment's sign-in in place of this computer's.
 */
function EnvironmentAddProviderProfileDialog(
  props: AddProviderProfileDialogProps & {
    readonly client: HostClient<HostRpcRegistry>;
    readonly environmentId: string;
    readonly team: boolean;
  },
): ReactNode {
  const { state, client } = props;
  const { providerId } = state;
  const supportsShareSkillsAndPlugins =
    PROVIDER_SHARES_SKILLS_AND_PLUGINS[providerId];
  const [shareSkillsAndPlugins, setShareSkillsAndPlugins] = useState(
    supportsShareSkillsAndPlugins,
  );
  const [label, setLabel] = useState("New profile");
  const [accentColor, setAccentColor] = useState<ProviderProfileAccentColor>(
    () => nextAvailableAccentColor(state.profiles),
  );
  const [emailRevealed, setEmailRevealed] = useState(false);
  // Counts sign-ins started from this dialog; each one mounts a fresh attempt.
  const [signInCount, setSignInCount] = useState(0);
  const [signedIn, setSignedIn] = useState<EnvironmentSignedIn | null>(null);
  const [namingCommitted, setNamingCommitted] = useState(false);
  const profileIdsBeforeSignIn = useRef<ReadonlySet<string>>(new Set());
  const recolorProfile = useRecolorProviderProfileForClient(client);
  const renameProfile = useRenameProviderProfileForClient(client);
  const trimmedLabel = label.trim();
  const started = signInCount > 0;
  const finalizing = recolorProfile.isPending || renameProfile.isPending;
  const duplicateProfile =
    signedIn !== null && signedIn.duplicate ? signedIn.profile : null;
  const naming = environmentNamingStep(
    signedIn,
    namingCommitted,
    state.profiles,
  );

  const close = (nextOpen: boolean): void => {
    if (!nextOpen && finalizing) return;
    props.onOpenChange(nextOpen);
  };
  const complete = (profileId: string): void => {
    props.onFailedAttempt(null);
    props.onProfileCreated(profileId);
    props.onOpenChange(false);
  };
  const finalize = (
    profileId: string,
    color: ProviderProfileAccentColor | null,
  ): void => {
    if (color === accentColor) {
      complete(profileId);
      return;
    }
    recolorProfile.mutate(
      { providerId, profileId, accentColor },
      { onSuccess: () => complete(profileId) },
    );
  };
  const signIn = (): void => {
    if (trimmedLabel.length === 0) return;
    props.onFailedAttempt(null);
    profileIdsBeforeSignIn.current = new Set(
      state.profiles.map((profile) => profile.profileId),
    );
    setSignedIn(null);
    setNamingCommitted(false);
    setEmailRevealed(false);
    setSignInCount((count) => count + 1);
  };
  const signedInAs = (profile: ProviderProfile): void => {
    const duplicate = profileIdsBeforeSignIn.current.has(profile.profileId);
    setSignedIn({ profileId: profile.profileId, profile, duplicate });
    if (duplicate) {
      props.onFailedAttempt(null);
      return;
    }
    // Same email as another profile: the person names this one first.
    if (findEmailCollisionProfile(state.profiles, profile) !== null) return;
    setNamingCommitted(true);
    finalize(profile.profileId, profile.accentColor);
  };
  const receiving = (profileId: string | null): void => {
    if (profileId === null) {
      close(false);
      return;
    }
    if (profileIdsBeforeSignIn.current.has(profileId)) {
      complete(profileId);
      return;
    }
    setSignedIn({ profileId, profile: null, duplicate: false });
    setNamingCommitted(true);
    finalize(profileId, null);
  };
  const commitNaming = (profile: ProviderProfile): void => {
    if (trimmedLabel.length === 0) return;
    const named = (): void => {
      setNamingCommitted(true);
      finalize(profile.profileId, profile.accentColor);
    };
    if (trimmedLabel === profile.label) {
      named();
      return;
    }
    renameProfile.mutate(
      { providerId, profileId: profile.profileId, label: trimmedLabel },
      { onSuccess: named },
    );
  };

  return (
    <AddProfileDialogShell
      providerId={providerId}
      open={props.open}
      onOpenChange={close}
      showCloseButton={!started}
      dismissalLocked={finalizing}
      footer={
        <AddProfileFooter
          step={addProfileFooterStep({
            started,
            naming: naming !== null,
            duplicate: duplicateProfile !== null,
          })}
          saveDisabled={trimmedLabel.length === 0 || finalizing}
          savePending={finalizing}
          signInAgainDisabled={false}
          onCancel={() => close(false)}
          onSave={() => {
            if (naming !== null) commitNaming(naming.profile);
          }}
          onSignInAgain={signIn}
        />
      }
    >
      <ProviderProfileCard
        profile={null}
        profiles={state.profiles}
        label={label}
        onLabelChange={setLabel}
        selectedColor={accentColor}
        onSelectColor={setAccentColor}
        disabled={(started && naming === null) || finalizing}
      />

      {supportsShareSkillsAndPlugins ? (
        <ShareSkillsAndPluginsField
          checked={shareSkillsAndPlugins}
          disabled={started || finalizing}
          onCheckedChange={setShareSkillsAndPlugins}
        />
      ) : null}

      {started ? (
        <EnvironmentProfileSignIn
          key={signInCount}
          client={client}
          request={{
            providerId,
            profileId: null,
            environmentId: props.environmentId,
            createProfile: {
              label: trimmedLabel,
              shareSkillsAndPlugins:
                supportsShareSkillsAndPlugins && shareSkillsAndPlugins,
            },
            replaceAccount: false,
          }}
          waitForLocalProfile
          team={props.team}
          ruleAboveWaitingStep
          reportSource="Add profile"
          onComplete={({ profile }) => {
            if (profile !== null) signedInAs(profile);
          }}
          onDeliveryPending={receiving}
          onNotOffered={null}
          onCancel={() => close(false)}
        />
      ) : (
        <AddProfileSignInCard
          disabled={trimmedLabel.length === 0}
          onClick={signIn}
        />
      )}

      {signedIn === null ? null : (
        <AddProfileSignedInSection
          providerId={providerId}
          duplicateProfile={duplicateProfile}
          naming={naming}
          namingError={renameProfile.error}
          finalizing={finalizing}
          finalizeError={recolorProfile.error}
          emailRevealed={emailRevealed}
          setEmailRevealed={setEmailRevealed}
          onCancel={() => close(false)}
          onRetryFinalize={() =>
            finalize(signedIn.profileId, signedIn.profile?.accentColor ?? null)
          }
        />
      )}
    </AddProfileDialogShell>
  );
}

function environmentNamingStep(
  signedIn: EnvironmentSignedIn | null,
  namingCommitted: boolean,
  profiles: readonly ProviderProfile[],
): NamingStepState | null {
  if (
    signedIn === null ||
    signedIn.duplicate ||
    signedIn.profile === null ||
    namingCommitted
  )
    return null;
  const collisionProfile = findEmailCollisionProfile(
    profiles,
    signedIn.profile,
  );
  return collisionProfile === null
    ? null
    : { profile: signedIn.profile, collisionProfile };
}

/** The add-profile dialog's frame, whichever sign-in runs inside it. */
function AddProfileDialogShell(props: {
  readonly providerId: ProviderCliState["providerId"];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly showCloseButton: boolean;
  readonly dismissalLocked: boolean;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const name = PROVIDER_DISPLAY_NAMES[props.providerId];
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,42rem)] w-[min(92vw,30rem)] flex-col overflow-hidden sm:max-w-none"
        showCloseButton={props.showCloseButton}
        onEscapeKeyDown={(event) => {
          if (props.dismissalLocked) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (props.dismissalLocked) event.preventDefault();
        }}
      >
        <DialogHeader className="gap-1.5">
          <DialogTitle>Add new {name} profile</DialogTitle>
          <DialogDescription>
            Name this {name} profile, choose its color, then sign in to the
            account it should use.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pb-5">
          {props.children}
        </div>

        {props.footer}
      </DialogContent>
    </Dialog>
  );
}

type AddProfileFooterStep = "start" | "naming" | "duplicate" | null;

function addProfileFooterStep(at: {
  readonly started: boolean;
  readonly naming: boolean;
  readonly duplicate: boolean;
}): AddProfileFooterStep {
  if (!at.started) return "start";
  if (at.naming) return "naming";
  if (at.duplicate) return "duplicate";
  return null;
}

function AddProfileFooter(props: {
  readonly step: AddProfileFooterStep;
  readonly saveDisabled: boolean;
  readonly savePending: boolean;
  readonly signInAgainDisabled: boolean;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onSignInAgain: () => void;
}): ReactNode {
  switch (props.step) {
    case "start":
      return (
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        </DialogFooter>
      );
    case "naming":
      return (
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={props.saveDisabled}
            onClick={props.onSave}
          >
            {props.savePending ? <MutedAgentSpinner /> : null}
            Save profile
          </Button>
        </DialogFooter>
      );
    case "duplicate":
      return (
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.signInAgainDisabled}
            onClick={props.onSignInAgain}
          >
            Sign in again
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={props.onCancel}
          >
            Done
          </Button>
        </DialogFooter>
      );
    case null:
      return null;
  }
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
  if (flowState.kind === "start") {
    return <AddProfileSignInCard disabled={linkDisabled} onClick={onLink} />;
  }

  if (flowState.kind === "starting" || flowState.kind === "waiting") {
    return (
      <div className="border-t border-border/60 pt-4">
        <AddProfileWaitingStep
          {...providerProfileLoginProgress(flowState)}
          autoOpenBrowser={shouldAutoOpenLoginUrl(isLocalHost, loginCapability)}
          codeReturn="automatic"
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
        source="Add profile"
        retryLabel={providerLoginRetryLabel(flowState.refusal, "Retry")}
        onCancel={onCancel}
        onRetry={onRetryLogin}
      />
    );
  }

  if (flowState.kind === "cancelled") {
    return <AddProfileStatusCard>Cancelling sign-in</AddProfileStatusCard>;
  }

  return (
    <AddProfileSignedInSection
      providerId={providerId}
      duplicateProfile={duplicateProfile}
      naming={naming}
      namingError={namingError}
      finalizing={finalizing}
      finalizeError={finalizeError}
      emailRevealed={emailRevealed}
      setEmailRevealed={setEmailRevealed}
      onCancel={onCancel}
      onRetryFinalize={onRetryFinalize}
    />
  );
}

/** What follows a finished sign-in, until the profile is named and colored. */
function AddProfileSignedInSection({
  providerId,
  duplicateProfile,
  naming,
  namingError,
  finalizing,
  finalizeError,
  emailRevealed,
  setEmailRevealed,
  onCancel,
  onRetryFinalize,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly duplicateProfile: ProviderProfile | null;
  readonly naming: NamingStepState | null;
  readonly namingError: Error | null;
  readonly finalizing: boolean;
  readonly finalizeError: Error | null;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
  readonly onCancel: () => void;
  readonly onRetryFinalize: () => void;
}): ReactNode {
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
        message="The account is signed in, but the profile color could not be saved."
        refusal={null}
        source="Add profile"
        retryLabel="Retry"
        onCancel={onCancel}
        onRetry={onRetryFinalize}
      />
    );
  }

  return (
    <AddProfileStatusCard>
      {finalizing ? "Finishing profile setup" : "Account signed in"}
    </AddProfileStatusCard>
  );
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
        <div className="text-ui-sm font-medium">Account already signed in</div>
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
