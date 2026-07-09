import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProvidersStartLogin } from "@/hooks/providers/use-providers-start-login-mutation";
import { useHostScopedProvidersAwaitLogin } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersCancelLogin } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { redactEmail } from "@/lib/providers/redact-email";
import {
  AddProfileIdentityStep,
  AddProfileWaitingStep,
} from "./add-provider-profile-dialog";
import { useProviderProfileLoginFlow } from "./use-provider-profile-login-flow";

function noop(): void {}

interface ProviderProfileReauthDialogProps {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ProviderProfileReauthDialog({
  state,
  profile,
  open,
  onOpenChange,
}: ProviderProfileReauthDialogProps): ReactNode {
  const runnerHost = useRunnerHost();
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useHostScopedProvidersAwaitLogin();
  const cancelLogin = useProvidersCancelLogin();
  const flow = useProviderProfileLoginFlow({
    mode: "reauth",
    providerId: state.providerId,
    existingProfileId: profile.profileId,
    startLogin,
    awaitLogin,
    cancelLogin,
    failureMessages: {
      notStarted: "Sign-in did not start. Try again when ready.",
      notFinished: "Sign-in did not finish. Try again.",
    },
    onFailed: noop,
  });
  const [emailRevealed, setEmailRevealed] = useState(false);
  // Eagerly overrides the identity view back to "waiting" the instant
  // "Sign in again" is clicked, without waiting for `startLogin` to resolve -
  // otherwise the stale identity-changed prompt would keep rendering (with no
  // indication a new sign-in is already underway) until the round trip
  // finishes. Clears itself once the flow has genuinely moved past its old
  // `identity` state (a fresh `waiting`, or a `failed` retry target).
  const [restarting, setRestarting] = useState(false);
  if (restarting && flow.state.kind !== "identity") {
    setRestarting(false);
  }
  const showWaiting =
    flow.state.kind === "waiting" ||
    (flow.state.kind === "identity" && restarting);
  const showIdentity = flow.state.kind === "identity" && !restarting;
  const busy = flow.busy;
  const startedRef = useRef(false);

  const close = (nextOpen: boolean): void => {
    if (!nextOpen && busy && !showWaiting) return;
    if (!nextOpen && showWaiting) {
      cancelLogin.mutate({
        providerId: state.providerId,
        profileId: profile.profileId,
      });
    }
    onOpenChange(nextOpen);
  };

  const start = useCallback((): void => {
    flow.start({ shareSkillsAndPlugins: false });
  }, [flow]);

  const signInAgain = (): void => {
    if (busy) return;
    setRestarting(true);
    setEmailRevealed(false);
    start();
  };

  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    start();
  }, [open, start]);

  const identityChanged =
    flow.state.kind === "identity" &&
    !sameProfileIdentity(profile, flow.state.profile);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[min(92vw,32rem)]">
        <DialogHeader>
          <DialogTitle>Sign in again</DialogTitle>
          <DialogDescription>
            Reconnect {profile.label} for{" "}
            {PROVIDER_DISPLAY_NAMES[state.providerId]}. Name and color stay the
            same.
          </DialogDescription>
        </DialogHeader>

        {showWaiting ? (
          <AddProfileWaitingStep
            loginUrl={flow.state.kind === "waiting" ? flow.state.url : null}
            queuePending={flow.startPending}
            onOpenExternalLink={(url) => void runnerHost.openExternalLink(url)}
            onCancel={() => close(false)}
          />
        ) : null}
        {showIdentity ? (
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
                  {profile.label} is now signed in as{" "}
                  {profileIdentityCopy(flow.state.profile)} (was{" "}
                  {profileIdentityCopy(profile)}). Sign in again if this is not
                  the intended account.
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
        {flow.state.kind === "failed" ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-ui-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{flow.state.message}</span>
          </div>
        ) : null}

        <ProviderProfileReauthDialogFooter
          failed={flow.state.kind === "failed"}
          showIdentity={showIdentity}
          showWaiting={showWaiting}
          identityChanged={identityChanged}
          busy={busy}
          onCancel={() => close(false)}
          onRetry={start}
          onSignInAgain={signInAgain}
        />
      </DialogContent>
    </Dialog>
  );
}

function ProviderProfileReauthDialogFooter({
  failed,
  showIdentity,
  showWaiting,
  identityChanged,
  busy,
  onCancel,
  onRetry,
  onSignInAgain,
}: {
  readonly failed: boolean;
  readonly showIdentity: boolean;
  readonly showWaiting: boolean;
  readonly identityChanged: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onSignInAgain: () => void;
}): ReactNode {
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="ghost"
        disabled={busy ? !showWaiting : false}
        onClick={onCancel}
      >
        Cancel
      </Button>
      {failed ? (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? <MutedAgentSpinner /> : null}
          Retry
        </Button>
      ) : null}
      {showIdentity ? (
        <>
          {identityChanged ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={onSignInAgain}
            >
              {busy ? <MutedAgentSpinner /> : null}
              Sign in again
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onCancel}>
            {identityChanged ? "Keep new account" : "Done"}
          </Button>
        </>
      ) : null}
    </DialogFooter>
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
