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
import { useRunnerHost } from "@/providers/use-runner-host";
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
  readonly onCancel: () => void;
  readonly onDone: () => void;
}

export function ProviderProfileReauthPanel({
  state,
  profile,
  onCancel,
  onDone,
}: ProviderProfileReauthPanelProps): ReactNode {
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
  const startedRef = useRef(false);

  const showWaiting =
    flow.state.kind === "start" ||
    flow.state.kind === "starting" ||
    flow.state.kind === "waiting";
  const showIdentity = flow.state.kind === "identity";
  const identityChanged =
    flow.state.kind === "identity" &&
    !sameProfileIdentity(profile, flow.state.profile);

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

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div>
        <div className="text-ui-sm font-medium text-foreground">
          Switching account
        </div>
        <p className="mt-0.5 text-ui-xs text-muted-foreground">
          Complete sign-in in your browser. The profile name and color will not
          change.
        </p>
      </div>

      <ProviderProfileReauthState
        flow={flow}
        profile={profile}
        showWaiting={showWaiting}
        showIdentity={showIdentity}
        identityChanged={identityChanged}
        emailRevealed={emailRevealed}
        setEmailRevealed={setEmailRevealed}
        onOpenExternalLink={(url) => void runnerHost.openExternalLink(url)}
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
  profile,
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
  readonly profile: ProviderProfile;
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
