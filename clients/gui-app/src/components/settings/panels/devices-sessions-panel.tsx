import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { UserSessionListItem } from "@traycer/protocol/auth/devices-sessions";
import {
  Clock,
  Globe,
  HelpCircle,
  LogOut,
  Monitor,
  Server,
  ShieldAlert,
  Smartphone,
  TabletSmartphone,
  Terminal,
} from "lucide-react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type RevokeUserSessionInput,
  useAuthRevokeUserSession,
} from "@/hooks/auth/use-revoke-user-session-mutation";
import { useAuthRevokeAllSessions } from "@/hooks/auth/use-revoke-all-sessions-mutation";
import { useAuthFetchUserSessions } from "@/hooks/auth/use-user-sessions-query";
import {
  isStepUpRequiredError,
  runStepUpProtectedAction,
  type StepUpCredential,
} from "@/lib/auth/step-up-flow";
import { StepUpChallengeDialog } from "@/components/auth/step-up-challenge-dialog";
import {
  actionErrorFromStepUpError,
  StepUpCanceledError,
  type StepUpPromptPurpose,
  type StepUpPromptRequest,
} from "@/lib/auth/step-up-prompt";
import { useHostBinding } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";

const SESSION_ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface SessionMutation {
  readonly isPending: boolean;
  readonly mutateAsync: (input: RevokeUserSessionInput) => Promise<unknown>;
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
    case "mobile":
      return "Mobile app";
    case "host":
      return "Host";
    default:
      return "Unknown client";
  }
}

function sessionDisplayLine(session: UserSessionListItem): string {
  const parts = [
    session.displayLabel,
    session.platform,
    session.appVersion === null ? null : `App ${session.appVersion}`,
    // Coarse (city/region-level) and the strongest "is this me?" signal on the
    // row - a session in the wrong place is what a user actually scans for.
    session.location,
  ].filter((part): part is string => part !== null && part.trim().length > 0);
  return parts.length === 0 ? "Session details unavailable" : parts.join(" / ");
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

function sessionTimelineLine(session: UserSessionListItem): string {
  return `Created ${formatRelativeTime(session.createdAt)} · ${sessionStatusLine(session)}`;
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
    case "mobile":
      // Deliberately NOT `Smartphone`: the extension already owns that glyph,
      // and two client kinds sharing one icon in the same list is worse than
      // either choice on its own.
      return <TabletSmartphone className={className} />;
    case "host":
      return <Server className={className} />;
    default:
      return <HelpCircle className={className} />;
  }
}

export function DevicesSessionsPanel() {
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const binding = useHostBinding();
  const query = useAuthFetchUserSessions();
  const revokeAllSessions = useAuthRevokeAllSessions();
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
        setStepUpPrompt({ id, purpose, subjectLabel: null, resolve, reject });
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
    stepUpPrompt.reject(new StepUpCanceledError());
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
          getCredential: () => stepUpCredentialRef.current,
          setCredential: (credential) => {
            stepUpCredentialRef.current = credential;
          },
          requestCredential: () => requestStepUpCredential("session-revoke"),
          action: (useStepUpCredential) =>
            mutation.mutateAsync({
              familyId: session.familyId,
              useStepUpCredential,
            }),
          nowMs: () => Date.now(),
        });
        if (session.current && binding !== null) {
          await binding.auth.signOut();
        }
      } catch (error) {
        setActionError(actionErrorFromStepUpError(error));
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
      await requestStepUpCredential("global-revoke");
      try {
        await revokeAllSessions.mutateAsync(undefined);
      } catch (error) {
        if (!isStepUpRequiredError(error)) {
          throw error;
        }
        await requestStepUpCredential("global-revoke");
        await revokeAllSessions.mutateAsync(undefined);
      }
      await binding.auth.signOut();
    } catch (error) {
      setActionError(actionErrorFromStepUpError(error));
    }
  }, [binding, requestStepUpCredential, revokeAllSessions]);

  return (
    <>
      <SettingsPanelShell
        title="Sessions"
        description="Review where your account is signed in and remove access you no longer recognize."
      >
        <div className="flex flex-col">
          <div className="flex flex-col gap-3 border-b border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <h2 className="text-ui font-medium">Signed-in sessions</h2>
              <p className="text-ui-xs text-muted-foreground">
                Browser, desktop, CLI, extension, and host access for this
                account.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!signedIn || actionBusy}
              onClick={() => void handleRevokeAll()}
            >
              <LogOut className="size-3.5" />
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
          No signed-in sessions found.
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
  const mutation = useAuthRevokeUserSession(session.familyId);
  const pending =
    mutation.isPending || props.activeSessionFamilyId === session.familyId;
  const disabled = session.revoked || (props.actionBusy && !pending);
  return (
    <li
      className={cn(
        "flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
        session.revoked && "bg-foreground/3 text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground/8 text-muted-foreground">
          {sessionIcon(session)}
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui-sm font-medium text-foreground">
              {session.current ? "This session" : "Session"}
            </span>
            <Badge variant="outline">{sessionClientLabel(session)}</Badge>
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
            {pending ? "Signing out" : sessionTimelineLine(session)}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => void props.onRevokeSession(session, mutation)}
      >
        <LogOut className="size-3.5" />
        Sign out
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
