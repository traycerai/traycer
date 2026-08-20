import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle } from "lucide-react";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useProvidersStartLogin } from "@/hooks/providers/use-providers-start-login-mutation";
import { useHostScopedProvidersAwaitLogin } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersCancelLogin } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useProvidersSubmitLoginCode } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLogin } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { redactEmail } from "@/lib/providers/redact-email";
import {
  AddProfileIdentityStep,
  AddProfileWaitingStep,
} from "./add-provider-profile-dialog";
import {
  useProviderProfileLoginFlow,
  type ProviderProfileLoginFlow,
} from "./use-provider-profile-login-flow";

function noop(): void {}

interface ProviderProfileReauthPanelProps {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  /** Settles a reconnect of the SAME account without the acknowledgment card.
   *  The profile is already authenticated and persisted by the time the flow
   *  reaches `identity` - the card only asks the user to confirm something
   *  that already happened - so a caller whose surface exists purely for the
   *  sign-in (the edit dialog opened *to* sign this profile in) passes a
   *  handler here and closes itself, rather than handing back a form whose
   *  only exit is Cancel.
   *
   *  `null` keeps the card, and is right for a caller with unfinished
   *  business of its own - the "Switch account" entry, whose name/color edits
   *  stay uncommitted until "Save changes". A CHANGED account keeps the card
   *  either way: its amber notice is the only thing that tells the user the
   *  profile was rebound to a different account. */
  readonly onSameAccountReconnected:
    ((profile: ProviderProfile) => void) | null;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}

export function ProviderProfileReauthPanel({
  state,
  profile,
  onSameAccountReconnected,
  onCancel,
  onDone,
}: ProviderProfileReauthPanelProps): ReactNode {
  const openExternalLink = useRunnerOpenExternalLink();
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useHostScopedProvidersAwaitLogin();
  const cancelLogin = useProvidersCancelLogin();
  const submitLoginCode = useProvidersSubmitLoginCode();
  const touchLogin = useProvidersTouchLogin();
  // The `profile` prop is LIVE, and it turns over mid-flow:
  // `providers.awaitLogin`'s hook-level `onSuccess` commits the fresh row into
  // the `providers.list` cache, and query-core awaits that before the flow's
  // own per-call `onSuccess` settles the step. So by the first render of the
  // settled step this prop already describes whoever just signed in - it can
  // be neither the "before" side of the changed-account comparison (which
  // would then compare the new account against itself and always call it
  // unchanged) nor the basis for "are we signing this profile in, or switching
  // its account" (which would flip its own copy the instant it succeeded).
  // Freeze the row as it was on entry; it is the only record of who this
  // profile was when the user started, and everything below wants exactly it.
  const [entryProfile] = useState(profile);
  const flow = useProviderProfileLoginFlow({
    mode: "reauth",
    providerId: state.providerId,
    existingProfileId: entryProfile.profileId,
    loginCapability: state.loginCapability,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    failureMessages: {
      notStarted: "Sign-in did not start. Try again when ready.",
      notFinished: "Sign-in did not finish. Try again.",
    },
    onFailed: noop,
  });
  const [emailRevealed, setEmailRevealed] = useState(false);
  const startedRef = useRef(false);
  const handedOffRef = useRef(false);

  const showWaiting =
    flow.state.kind === "start" ||
    flow.state.kind === "starting" ||
    flow.state.kind === "waiting";
  const showIdentity = flow.state.kind === "identity";
  const identityChanged =
    flow.state.kind === "identity" &&
    !sameProfileIdentity(entryProfile, flow.state.profile);
  const handingOff =
    onSameAccountReconnected !== null && showIdentity && !identityChanged;
  // Suppressed from the render, not just skipped afterwards: the hand-off
  // runs in an effect, so the card would otherwise paint for a frame - and
  // stay painted for the caller's exit animation - before vanishing. A card
  // that appears only to fade out reads as a step the user missed.
  const showIdentityCard = showIdentity && !handingOff;

  const start = useCallback((): void => {
    flow.start({ label: null, shareSkillsAndPlugins: false });
  }, [flow]);

  const cancel = (): void => {
    flow.cancel();
    onCancel();
  };

  const signInAgain = (): void => {
    if (flow.busy) return;
    setEmailRevealed(false);
    start();
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
  }, [start]);

  // One-shot on its own ref, not on the dep list: the caller's handler is an
  // inline closure, so deps alone would re-fire this on every render the
  // caller takes to unmount - one duplicate toast apiece. Nothing resets it,
  // because the only route back into `identity` is "Sign in again", which is
  // exactly the correction this should settle (wrong account -> retry -> the
  // original account back = nothing left to ask about).
  //
  // No re-test of the state kind or the handler: `handingOff` is a const alias
  // for `kind === "identity"` plus the null check, and narrows both below.
  useEffect(() => {
    if (!handingOff) return;
    if (handedOffRef.current) return;
    handedOffRef.current = true;
    onSameAccountReconnected(flow.state.profile);
  }, [flow.state, handingOff, onSameAccountReconnected]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div>
        <div className="text-ui-sm font-medium text-foreground">
          {entryProfile.auth.status === "unauthenticated"
            ? "Signing in"
            : "Switching account"}
        </div>
        <p className="mt-0.5 text-ui-xs text-muted-foreground">
          {entryProfile.auth.status === "unauthenticated"
            ? "Reconnect this profile. Its name and color will not change."
            : "The profile name and color will not change."}
        </p>
      </div>

      <ProviderProfileReauthState
        flow={flow}
        entryProfile={entryProfile}
        showWaiting={showWaiting}
        showIdentity={showIdentityCard}
        identityChanged={identityChanged}
        emailRevealed={emailRevealed}
        setEmailRevealed={setEmailRevealed}
        onOpenExternalLink={(url) => openExternalLink.mutate(url)}
        onCancel={cancel}
        onRetry={start}
        onSignInAgain={signInAgain}
        onDone={onDone}
      />
    </div>
  );
}

function ProviderProfileReauthState({
  flow,
  entryProfile,
  showWaiting,
  showIdentity,
  identityChanged,
  emailRevealed,
  setEmailRevealed,
  onOpenExternalLink,
  onCancel,
  onRetry,
  onSignInAgain,
  onDone,
}: {
  readonly flow: ProviderProfileLoginFlow;
  /** The row as it was when the panel mounted - see the freeze at the call
   *  site. The live prop describes the account that just signed in, so it
   *  cannot narrate what this profile "was". */
  readonly entryProfile: ProviderProfile;
  readonly showWaiting: boolean;
  readonly showIdentity: boolean;
  readonly identityChanged: boolean;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onSignInAgain: () => void;
  readonly onDone: () => void;
}): ReactNode {
  return (
    <>
      {showWaiting ? (
        <AddProfileWaitingStep
          loginUrl={flow.state.kind === "waiting" ? flow.state.url : null}
          queuePending={flow.startPending}
          cancelRequested={
            flow.state.kind === "starting" && flow.state.cancelRequested
          }
          cancelPending={flow.cancelPending}
          cancelDisabled={flow.commitPending}
          waiting={flow.state.kind === "waiting"}
          codePaste={flow.codePaste}
          onOpenExternalLink={onOpenExternalLink}
          onCancel={onCancel}
        />
      ) : null}

      {showIdentity && flow.state.kind === "identity" ? (
        <div className="flex flex-col gap-3">
          <AddProfileIdentityStep
            profile={flow.state.profile}
            duplicateLabel={null}
            emailRevealed={emailRevealed}
            setEmailRevealed={setEmailRevealed}
          />
          {identityChanged ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-ui-xs text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {entryProfile.label} is now signed in as{" "}
                {profileIdentityCopy(flow.state.profile)} (was{" "}
                {profileIdentityCopy(entryProfile)}). Sign in again if this is
                not the intended account.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {flow.state.kind === "failed" ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-ui-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{flow.state.message}</span>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Provider reauthentication failed",
              message: null,
              code: null,
              source: "Provider reauth",
            })}
            presentation="link"
            className="h-auto p-0 text-current"
          />
        </div>
      ) : null}

      <ProviderProfileReauthActions
        flow={flow}
        showWaiting={showWaiting}
        showIdentity={showIdentity}
        identityChanged={identityChanged}
        onCancel={onCancel}
        onRetry={onRetry}
        onSignInAgain={onSignInAgain}
        onDone={onDone}
      />
    </>
  );
}

function ProviderProfileReauthActions({
  flow,
  showWaiting,
  showIdentity,
  identityChanged,
  onCancel,
  onRetry,
  onSignInAgain,
  onDone,
}: {
  readonly flow: ProviderProfileLoginFlow;
  readonly showWaiting: boolean;
  readonly showIdentity: boolean;
  readonly identityChanged: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onSignInAgain: () => void;
  readonly onDone: () => void;
}): ReactNode {
  if (showWaiting) return null;
  // Nothing to act on - the settled-and-handing-off frame, whose card is
  // suppressed above. Without this the row still reserves its gap under an
  // empty footer while the caller unmounts.
  if (!showIdentity && flow.state.kind !== "failed") return null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {flow.state.kind === "failed" ? (
        <>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel sign-in
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={flow.busy}
            onClick={onRetry}
          >
            {flow.busy ? <MutedAgentSpinner /> : null}
            Retry
          </Button>
        </>
      ) : null}
      {showIdentity && identityChanged ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={flow.busy}
          onClick={onSignInAgain}
        >
          {flow.busy ? <MutedAgentSpinner /> : null}
          Sign in again
        </Button>
      ) : null}
      {showIdentity ? (
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>
          {identityChanged ? "Keep new account" : "Done"}
        </Button>
      ) : null}
    </div>
  );
}

function sameProfileIdentity(
  previous: ProviderProfile,
  next: ProviderProfile,
): boolean {
  const previousUuid = previous.identity?.accountUuid ?? null;
  const nextUuid = next.identity?.accountUuid ?? null;
  if (previousUuid !== null || nextUuid !== null) {
    return previousUuid === nextUuid;
  }
  return (previous.identity?.email ?? null) === (next.identity?.email ?? null);
}

function profileIdentityCopy(profile: ProviderProfile): string {
  const email = profile.identity?.email ?? null;
  if (email !== null) return redactEmail(email);
  const uuid = profile.identity?.accountUuid ?? null;
  if (uuid !== null) return "another account";
  return "an unknown account";
}
