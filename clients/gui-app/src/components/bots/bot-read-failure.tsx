import type { ReactNode } from "react";
import { PrimarySignInButton } from "@/components/layout/header/sign-in/sign-in-action-buttons";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  hostLabelAtSentenceStart,
  useHostReachability,
} from "@/hooks/agent/use-host-reachability";
import type {
  BotReadFailing,
  BotReadFailureKind,
  BotReadStaleKind,
} from "@/lib/bots/bot-read-view";
import { useMessageTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A bot read that failed, said in place with a way to ask again. The caller
 * places it; it carries no margin of its own.
 */
export function BotReadFailure(props: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
    >
      <span>{props.message}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** A failing read of a bot's channel or thread, as its surface draws it. */
export interface BotReadNotice {
  readonly view: BotReadFailing;
  /** Asks the read again. */
  readonly retry: () => void;
  /** A re-ask is in flight: Retry waits for it, so a press adds no second. */
  readonly retrying: boolean;
}

/** What a notice is about, which names it in its copy and its test ids. */
export type BotReadNoticeSurface = "channel" | "thread";

/**
 * A failing read of a bot's channel or thread, said in place. Over rows it
 * kept: a quiet line saying why they may be out of date and when they loaded.
 * In place of the rows, when it kept none or the person must stop seeing
 * them: what happened and what the person can do. The caller places it; it
 * carries no margin of its own.
 */
export function BotReadNoticeView(props: {
  readonly notice: BotReadNotice;
  readonly surface: BotReadNoticeSurface;
  /** The host the read went to, named when it is the one not answering. */
  readonly hostId: string;
}): ReactNode {
  const { notice, surface, hostId } = props;
  const { view } = notice;
  if (view.kind === "stale") {
    return (
      <StaleLine
        failure={view.failure}
        loadedAt={view.loadedAt}
        surface={surface}
        hostId={hostId}
        retry={notice.retry}
        retrying={notice.retrying}
      />
    );
  }
  return (
    <FailedState
      failure={view.failure}
      surface={surface}
      hostId={hostId}
      retry={notice.retry}
      retrying={notice.retrying}
    />
  );
}

function StaleLine(props: {
  readonly failure: BotReadStaleKind;
  readonly loadedAt: number;
  readonly surface: BotReadNoticeSurface;
  readonly hostId: string;
  readonly retry: () => void;
  readonly retrying: boolean;
}): ReactNode {
  const { failure, surface } = props;
  const loaded = `Showing what loaded at ${useMessageTime(props.loadedAt)}.`;
  return (
    <div
      role="status"
      data-testid={`bot-${surface}-stale`}
      data-failure={failure}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-1.5 text-ui-xs text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-2">
        {failure === "reconnecting" ? <MutedDots /> : null}
        <span className="min-w-0">
          <StaleMessage
            failure={failure}
            surface={surface}
            hostId={props.hostId}
            loaded={loaded}
          />
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={props.retrying}
        onClick={props.retry}
      >
        Retry
      </Button>
    </div>
  );
}

function StaleMessage(props: {
  readonly failure: BotReadStaleKind;
  readonly surface: BotReadNoticeSurface;
  readonly hostId: string;
  /** When the kept rows loaded, as a sentence. */
  readonly loaded: string;
}): ReactNode {
  const { loaded } = props;
  switch (props.failure) {
    case "server":
      return props.surface === "channel"
        ? `Couldn't check for new messages. ${loaded}`
        : `Couldn't check for new replies. ${loaded}`;
    case "reconnecting":
      return `Reconnecting… ${loaded} You can send once reconnected.`;
    case "host-not-answering":
      return (
        <>
          <HostName hostId={props.hostId} /> isn't responding. {loaded} You can
          send once it answers.
        </>
      );
  }
}

function FailedState(props: {
  readonly failure: BotReadFailureKind;
  readonly surface: BotReadNoticeSurface;
  readonly hostId: string;
  readonly retry: () => void;
  readonly retrying: boolean;
}): ReactNode {
  const { failure, surface } = props;
  // An error is drawn as every bot surface draws a read that failed with
  // nothing to show; a passing state or one the person acts on is not one.
  return (
    <div
      role="status"
      data-testid={`bot-${surface}-error`}
      data-failure={failure}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-ui-sm",
        failure === "server"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border text-muted-foreground",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {failure === "reconnecting" ? <MutedDots /> : null}
        <span className="min-w-0">
          <FailedMessage
            failure={failure}
            surface={surface}
            hostId={props.hostId}
          />
        </span>
      </span>
      <FailedAction
        failure={failure}
        retry={props.retry}
        retrying={props.retrying}
      />
    </div>
  );
}

function FailedMessage(props: {
  readonly failure: BotReadFailureKind;
  readonly surface: BotReadNoticeSurface;
  readonly hostId: string;
}): ReactNode {
  const { surface } = props;
  switch (props.failure) {
    case "server":
      return `Couldn't load this ${surface}.`;
    case "reconnecting":
      return "Reconnecting…";
    case "host-not-answering":
      return (
        <>
          <HostName hostId={props.hostId} /> isn't responding.
        </>
      );
    case "signed-out":
      return `You're signed out. Sign in to see this ${surface}.`;
    case "access-refused":
      return `You don't have access to this ${surface} anymore.`;
    case "cannot-serve":
      return (
        <>
          <HostName hostId={props.hostId} /> can't open this {surface}.
        </>
      );
  }
}

/**
 * What the person can do about a failure with nothing kept: sign in, ask
 * whether access is back, or ask again. A host that cannot serve the bot
 * answers the same however often it is asked, so it offers nothing.
 */
function FailedAction(props: {
  readonly failure: BotReadFailureKind;
  readonly retry: () => void;
  readonly retrying: boolean;
}): ReactNode {
  const signingIn = useAuthStore((state) => state.status === "signing-in");
  switch (props.failure) {
    case "cannot-serve":
      return null;
    case "signed-out":
      return (
        <PrimarySignInButton
          isHero={false}
          isSigningIn={signingIn}
          offersDifferentAccount={false}
          emphasis="primary"
        />
      );
    case "access-refused":
    case "server":
    case "reconnecting":
    case "host-not-answering":
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.retrying}
          onClick={props.retry}
        >
          {props.failure === "access-refused" ? "Check again" : "Retry"}
        </Button>
      );
  }
}

/** The host's name where it opens a sentence: "The host" when it has none. */
function HostName(props: { readonly hostId: string }): ReactNode {
  return hostLabelAtSentenceStart(useHostReachability(props.hostId).hostLabel);
}

function MutedDots(): ReactNode {
  return (
    <AgentSpinningDots
      className="shrink-0"
      testId={undefined}
      variant={undefined}
      tone="muted"
    />
  );
}
