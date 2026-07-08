import type { ReactNode, SyntheticEvent } from "react";
import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import type { UserSessionListItem } from "@traycer/protocol/auth/devices-sessions";
import {
  Clock,
  Globe,
  Laptop,
  LogOut,
  Mail,
  Monitor,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Terminal,
} from "lucide-react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type RevokeUserSessionInput,
  useRevokeUserSession,
} from "@/hooks/auth/use-revoke-user-session-mutation";
import { useRevokeAllSessions } from "@/hooks/auth/use-revoke-all-sessions-mutation";
import {
  useRequestStepUpChallenge,
  useVerifyStepUpChallenge,
} from "@/hooks/auth/use-step-up-challenge-mutations";
import { useUserSessions } from "@/hooks/auth/use-user-sessions-query";
import {
  createStepUpCredential,
  getActiveStepUpCredential,
  isStepUpRequiredError,
  runStepUpProtectedAction,
  type StepUpCredential,
} from "@/lib/auth/step-up-flow";
import { useHostBinding } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";

const STEP_UP_CODE_LENGTH = 6;
const SESSION_ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type StepUpPromptPurpose = "session-revoke" | "global-revoke";

interface StepUpPromptRequest {
  readonly id: number;
  readonly purpose: StepUpPromptPurpose;
  readonly resolve: (credential: StepUpCredential) => void;
  readonly reject: (error: Error) => void;
}

interface SessionMutation {
  readonly isPending: boolean;
  readonly mutateAsync: (input: RevokeUserSessionInput) => Promise<unknown>;
}

function normalizeStepUpCodeInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, STEP_UP_CODE_LENGTH);
}

function messageFromError(error: unknown): string {
  if (isStepUpRequiredError(error)) {
    return "Verification expired. Try again.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Action failed. Try again.";
}

function sessionClientLabel(session: UserSessionListItem): string {
  switch (session.clientKind) {
    case "web":
      return "Web";
    case "desktop":
      return "Desktop";
    case "cli":
      return "CLI";
    case "extension":
      return "Extension";
    default:
      return "Unknown";
  }
}

function sessionDisplayLine(session: UserSessionListItem): string {
  const parts = [
    session.displayLabel,
    session.platform,
    session.appVersion === null ? null : `App ${session.appVersion}`,
  ].filter((part): part is string => part !== null && part.trim().length > 0);
  return parts.length === 0 ? "No device details recorded" : parts.join(" / ");
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  return SESSION_ABSOLUTE_TIME_FORMATTER.format(new Date(timestamp));
}

function sessionStatusLine(session: UserSessionListItem): string {
  if (session.revoked) {
    return session.revokedAt === null
      ? "Signed out"
      : `Signed out ${formatRelativeTime(session.revokedAt)}`;
  }
  return `Last seen ${formatRelativeTime(session.lastSeenAt)}`;
}

function sortSessions(
  sessions: readonly UserSessionListItem[],
): readonly UserSessionListItem[] {
  return [...sessions].sort((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  });
}

function sessionIcon(session: UserSessionListItem): ReactNode {
  const className = "size-4";
  switch (session.clientKind) {
    case "web":
      return <Globe className={className} />;
    case "desktop":
      return <Monitor className={className} />;
    case "cli":
      return <Terminal className={className} />;
    case "extension":
      return <Smartphone className={className} />;
    default:
      return <Laptop className={className} />;
  }
}

export function DevicesSessionsPanel() {
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const binding = useHostBinding();
  const query = useUserSessions();
  const revokeAllSessions = useRevokeAllSessions();
  const [actionError, setActionError] = useState<string | null>(null);
  const [stepUpPrompt, setStepUpPrompt] = useState<StepUpPromptRequest | null>(
    null,
  );
  const [activeSessionFamilyId, setActiveSessionFamilyId] = useState<
    string | null
  >(null);
  const stepUpPromptIdRef = useRef(0);
  const stepUpCredentialRef = useRef<StepUpCredential | null>(null);
  const sessions = useMemo(
    () => sortSessions(query.data?.sessions ?? []),
    [query.data?.sessions],
  );
  const loading = query.isPending && query.fetchStatus !== "idle";
  const actionBusy =
    activeSessionFamilyId !== null ||
    revokeAllSessions.isPending ||
    stepUpPrompt !== null;

  const requestStepUpCredential = useCallback(
    (purpose: StepUpPromptPurpose): Promise<StepUpCredential> => {
      const id = stepUpPromptIdRef.current + 1;
      stepUpPromptIdRef.current = id;
      return new Promise((resolve, reject) => {
        setStepUpPrompt({ id, purpose, resolve, reject });
      });
    },
    [],
  );

  const handleStepUpVerified = useCallback(
    (credential: StepUpCredential) => {
      if (stepUpPrompt === null) {
        return;
      }
      stepUpPrompt.resolve(credential);
      setStepUpPrompt(null);
    },
    [stepUpPrompt],
  );

  const handleStepUpCanceled = useCallback(() => {
    if (stepUpPrompt === null) {
      return;
    }
    stepUpPrompt.reject(new Error("Verification canceled."));
    setStepUpPrompt(null);
  }, [stepUpPrompt]);

  const handleRevokeSession = useCallback(
    async (
      session: UserSessionListItem,
      mutation: SessionMutation,
    ): Promise<void> => {
      if (activeSessionFamilyId !== null) {
        return;
      }
      setActionError(null);
      setActiveSessionFamilyId(session.familyId);
      try {
        await runStepUpProtectedAction({
          getCredential: () =>
            getActiveStepUpCredential(stepUpCredentialRef.current, Date.now()),
          setCredential: (credential) => {
            stepUpCredentialRef.current = credential;
          },
          requestCredential: () => requestStepUpCredential("session-revoke"),
          action: (stepUpAccessToken) =>
            mutation.mutateAsync({
              familyId: session.familyId,
              stepUpAccessToken,
            }),
        });
        if (session.current && binding !== null) {
          await binding.auth.signOut();
        }
      } catch (error) {
        setActionError(messageFromError(error));
      } finally {
        setActiveSessionFamilyId(null);
      }
    },
    [activeSessionFamilyId, binding, requestStepUpCredential],
  );

  const handleRevokeAll = useCallback(async (): Promise<void> => {
    if (binding === null || revokeAllSessions.isPending) {
      return;
    }
    setActionError(null);
    try {
      const credential = await requestStepUpCredential("global-revoke");
      try {
        await revokeAllSessions.mutateAsync(credential.accessToken);
      } catch (error) {
        if (!isStepUpRequiredError(error)) {
          throw error;
        }
        const retryCredential = await requestStepUpCredential("global-revoke");
        await revokeAllSessions.mutateAsync(retryCredential.accessToken);
      }
      await binding.auth.signOut();
    } catch (error) {
      setActionError(messageFromError(error));
    }
  }, [binding, requestStepUpCredential, revokeAllSessions]);

  return (
    <>
      <SettingsPanelShell
        title="Devices"
        description="Review signed-in sessions and sign out devices that should no longer have access."
      >
        <div className="flex flex-col">
          <div className="flex flex-col gap-3 border-b border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <h2 className="text-ui font-medium">Sessions</h2>
              <p className="text-ui-xs text-muted-foreground">
                Browser, desktop, CLI, and extension access for this account.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!signedIn || actionBusy}
              onClick={() => void handleRevokeAll()}
            >
              <ShieldAlert className="size-3.5" />
              Sign out everywhere
              {revokeAllSessions.isPending ? (
                <AgentSpinningDots
                  className="text-current"
                  testId={undefined}
                  variant="orbit"
                />
              ) : null}
            </Button>
          </div>

          <DevicesSessionsBody
            signedIn={signedIn}
            loading={loading}
            isError={query.isError}
            sessions={sessions}
            actionBusy={actionBusy}
            activeSessionFamilyId={activeSessionFamilyId}
            actionError={actionError}
            onRevokeSession={handleRevokeSession}
          />
        </div>
      </SettingsPanelShell>
      <StepUpChallengeDialog
        request={stepUpPrompt}
        onVerified={handleStepUpVerified}
        onCancel={handleStepUpCanceled}
      />
    </>
  );
}

function DevicesSessionsBody(props: {
  readonly signedIn: boolean;
  readonly loading: boolean;
  readonly isError: boolean;
  readonly sessions: readonly UserSessionListItem[];
  readonly actionBusy: boolean;
  readonly activeSessionFamilyId: string | null;
  readonly actionError: string | null;
  readonly onRevokeSession: (
    session: UserSessionListItem,
    mutation: SessionMutation,
  ) => Promise<void>;
}) {
  if (!props.signedIn) {
    return (
      <div className="px-5 py-6 text-ui-sm text-muted-foreground">
        Sign in to see your sessions.
      </div>
    );
  }
  if (props.loading) {
    return <DevicesSessionsSkeleton />;
  }
  if (props.isError) {
    return (
      <div className="flex items-start gap-3 px-5 py-6 text-ui-sm text-destructive">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <span>Couldn&apos;t load your sessions. Retrying...</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {props.actionError === null ? null : (
        <div
          className="flex items-start gap-3 border-b border-amber-500/20 bg-amber-500/10 px-5 py-3 text-ui-sm text-amber-700 dark:text-amber-300"
          role="alert"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>{props.actionError}</span>
        </div>
      )}
      {props.sessions.length === 0 ? (
        <div className="px-5 py-6 text-ui-sm text-muted-foreground">
          No tracked sessions yet.
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {props.sessions.map((session) => (
            <SessionRow
              key={session.familyId}
              session={session}
              actionBusy={props.actionBusy}
              activeSessionFamilyId={props.activeSessionFamilyId}
              onRevokeSession={props.onRevokeSession}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DevicesSessionsSkeleton() {
  return (
    <div className="space-y-3 px-5 py-5">
      <Skeleton className="h-6 w-full max-w-96" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function SessionRow(props: {
  readonly session: UserSessionListItem;
  readonly actionBusy: boolean;
  readonly activeSessionFamilyId: string | null;
  readonly onRevokeSession: (
    session: UserSessionListItem,
    mutation: SessionMutation,
  ) => Promise<void>;
}) {
  const { session } = props;
  const mutation = useRevokeUserSession(session.familyId);
  const pending =
    mutation.isPending || props.activeSessionFamilyId === session.familyId;
  const disabled = session.revoked || (props.actionBusy && !pending);
  return (
    <li
      className={cn(
        "flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
        session.revoked && "bg-muted/30 text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {sessionIcon(session)}
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui-sm font-medium text-foreground">
              {session.current ? "This session" : "Session"}
            </span>
            <Badge variant="outline">{sessionClientLabel(session)}</Badge>
            {session.current ? (
              <Badge variant="secondary">Current</Badge>
            ) : null}
            {session.revoked ? (
              <Badge variant="outline" className="text-muted-foreground">
                Signed out
              </Badge>
            ) : null}
          </div>
          <p className="text-ui-sm text-muted-foreground wrap-anywhere">
            {sessionDisplayLine(session)}
          </p>
          <p className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
            <Clock className="size-3.5" />
            {pending ? "Signing out" : sessionStatusLine(session)}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant={session.current ? "destructive" : "outline"}
        size="sm"
        disabled={disabled}
        onClick={() => void props.onRevokeSession(session, mutation)}
      >
        <LogOut className="size-3.5" />
        {session.current ? "Log me out" : "Sign out"}
        {pending ? (
          <AgentSpinningDots
            className="text-current"
            testId={undefined}
            variant="orbit"
          />
        ) : null}
      </Button>
    </li>
  );
}

function StepUpChallengeDialog(props: {
  readonly request: StepUpPromptRequest | null;
  readonly onVerified: (credential: StepUpCredential) => void;
  readonly onCancel: () => void;
}) {
  if (props.request === null) {
    return null;
  }
  return (
    <StepUpChallengeDialogActive
      key={props.request.id}
      request={props.request}
      onVerified={props.onVerified}
      onCancel={props.onCancel}
    />
  );
}

function StepUpChallengeDialogActive(props: {
  readonly request: StepUpPromptRequest;
  readonly onVerified: (credential: StepUpCredential) => void;
  readonly onCancel: () => void;
}) {
  const requestChallenge = useRequestStepUpChallenge();
  const verifyChallenge = useVerifyStepUpChallenge();
  const [code, setCode] = useState("");
  const [challengeSent, setChallengeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = requestChallenge.isPending || verifyChallenge.isPending;
  const requestChallengeMutateAsync = requestChallenge.mutateAsync;
  const mountedRef = useRef(true);
  const title =
    props.request.purpose === "global-revoke"
      ? "Verify sign out everywhere"
      : "Verify session sign-out";
  const description =
    props.request.purpose === "global-revoke"
      ? "Enter the code sent to your email before signing out every session."
      : "Enter the code sent to your email to continue signing out sessions.";

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void requestChallengeMutateAsync()
      .then(() => {
        if (active) {
          setChallengeSent(true);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(messageFromError(caught));
        }
      });
    return () => {
      active = false;
    };
  }, [requestChallengeMutateAsync]);

  const handleResend = (): void => {
    setError(null);
    setChallengeSent(false);
    void requestChallenge
      .mutateAsync()
      .then(() => {
        setChallengeSent(true);
      })
      .catch((caught: unknown) => {
        setError(messageFromError(caught));
      });
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = normalizeStepUpCodeInput(code);
    if (!challengeSent || normalized.length !== STEP_UP_CODE_LENGTH || busy) {
      setError("Enter the 6-digit verification code.");
      return;
    }
    setError(null);
    void verifyChallenge
      .mutateAsync(normalized)
      .then((response) => {
        if (mountedRef.current) {
          props.onVerified(createStepUpCredential(response, Date.now()));
        }
      })
      .catch((caught: unknown) => {
        setError(messageFromError(caught));
      });
  };

  return (
    <Dialog
      open
      onOpenChange={
        busy
          ? undefined
          : (nextOpen) => {
              if (!nextOpen) {
                props.onCancel();
              }
            }
      }
    >
      <DialogContent
        showCloseButton={!busy}
        className="w-[min(92vw,26rem)] sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label
              htmlFor="step-up-code"
              className="text-ui-xs font-medium text-muted-foreground"
            >
              Email code
            </label>
            <div className="flex items-center gap-2">
              <Mail className="size-4 shrink-0 text-muted-foreground" />
              <Input
                id="step-up-code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={STEP_UP_CODE_LENGTH}
                disabled={!challengeSent || busy}
                aria-invalid={error !== null}
                onChange={(event) => {
                  setCode(normalizeStepUpCodeInput(event.currentTarget.value));
                }}
              />
            </div>
            {requestChallenge.isPending ? (
              <p className="flex items-center gap-2 text-ui-xs text-muted-foreground">
                <AgentSpinningDots
                  className="text-current"
                  testId={undefined}
                  variant="orbit"
                />
                Sending code
              </p>
            ) : null}
            {challengeSent && error === null ? (
              <p className="text-ui-xs text-muted-foreground">
                Check your email for the verification code.
              </p>
            ) : null}
            {error === null ? null : (
              <p className="text-ui-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={props.onCancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={handleResend}
            >
              <RefreshCcw className="size-3.5" />
              Resend code
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={
                !challengeSent || code.length !== STEP_UP_CODE_LENGTH || busy
              }
            >
              <ShieldCheck className="size-3.5" />
              Verify
              {verifyChallenge.isPending ? (
                <AgentSpinningDots
                  className="text-current"
                  testId={undefined}
                  variant="orbit"
                />
              ) : null}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
