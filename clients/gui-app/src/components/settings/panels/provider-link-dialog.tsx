import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import { usePersonalHostName } from "@/components/settings/personal/personal-page-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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
import { useHostClient } from "@/lib/host/runtime";
import {
  useConfigurationEnvironmentId,
  useConfigurationIsPersonal,
} from "@/components/settings/environment/configuration-source";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  useTeamPlanLinkCompleteMutation,
  useTeamPlanLinkPollQuery,
  useTeamPlanLinkStartMutation,
} from "@/hooks/environment/team/use-plan-link-mutations";
import { useOpenLink } from "@/lib/links/open-link";
import {
  LINK_DEVICE_LINE,
  LINK_EXPIRED,
  LINK_INTRO,
  teamLinkIntro,
  LINK_LINKING,
  LINK_SIGN_IN_LINE,
  LINK_UNAVAILABLE,
  linkedLine,
  mismatchLine,
  onHostOnlyLine,
  stateOfLinkComplete,
  stateOfLinkError,
  stateOfLinkStart,
  type LinkDialogState,
} from "@/lib/providers/provider-link-copy";
import {
  useProviderLinkDialogStore,
  type ProviderLinkTarget,
} from "@/stores/providers/provider-link-dialog-store";

/**
 * The Link dialog: links a profile that is on
 * this host only, or a new one, to the person's plan. Opened from the
 * Providers page's "On <host> only, link to use everywhere" line through
 * `provider-link-dialog-store`, and mounted once inside the page's host
 * scope, so its calls go to the host the page shows.
 *
 * Claude: sign in on claude.ai and paste the code. Codex: the provider's
 * device code, polled. The local handoff: "Linking…", polled. Each answer
 * moves the dialog to its state; the lines are `provider-link-copy.ts`'s.
 *
 * The Personal calls are direct requests, as the Secrets page's Add a secret
 * makes them: the pasted code is a one-time credential and reaches no query
 * or mutation cache, and closing the dialog drops it. A team's link goes
 * through `use-plan-link-mutations.ts`, which reads the code at dispatch for
 * the same reason.
 */

const DEVICE_POLL_MS = 5_000;
const LINKING_POLL_MS = 2_000;

const INTRO: LinkDialogState = { kind: "intro" };
const STARTING: LinkDialogState = { kind: "starting" };

type SignInState = Extract<LinkDialogState, { readonly kind: "sign_in" }>;

export function ProviderLinkDialog(): ReactNode {
  const target = useProviderLinkDialogStore((state) => state.target);
  const close = useProviderLinkDialogStore((state) => state.close);
  const environmentId = useConfigurationEnvironmentId();
  if (target === null || (target.environmentId ?? null) !== environmentId)
    return null;
  // Keyed by the target, so a new target starts from the intro.
  const key = `${environmentId}:${target.providerId}:${target.profileId ?? "new"}`;
  if (environmentId !== null)
    return (
      <TeamProviderLinkDialogFor
        key={key}
        target={target}
        environmentId={environmentId}
        onClose={close}
      />
    );
  return <ProviderLinkDialogFor key={key} target={target} onClose={close} />;
}

/** The poll a state asks for: a device code and a local handoff settle late. */
function pollOf(state: LinkDialogState): {
  readonly linkId: string | null;
  readonly intervalMs: number;
} {
  return {
    linkId:
      state.kind === "device" || state.kind === "linking" ? state.linkId : null,
    intervalMs: state.kind === "device" ? DEVICE_POLL_MS : LINKING_POLL_MS,
  };
}

function TeamProviderLinkDialogFor(props: {
  readonly target: ProviderLinkTarget;
  readonly environmentId: string;
  readonly onClose: () => void;
}): ReactNode {
  const [target, setTarget] = useState<ProviderLinkTarget>(props.target);
  const [state, setState] = useState<LinkDialogState>(INTRO);
  const [code, setCode] = useState("");
  // What `readCode` hands the complete mutation at dispatch.
  const codeRef = useRef("");
  const changeCode = (next: string): void => {
    codeRef.current = next;
    setCode(next);
  };
  const startLink = useTeamPlanLinkStartMutation(props.environmentId);
  const completeLink = useTeamPlanLinkCompleteMutation(
    props.environmentId,
    () => codeRef.current.trim(),
  );
  const personal = useConfigurationIsPersonal();
  const teamName = usePickedTeamLabel(props.environmentId) ?? "this team";
  const poll = pollOf(state);
  const pollAnswer = useTeamPlanLinkPollQuery(
    props.environmentId,
    poll.linkId,
    poll.intervalMs,
  );

  const start = (linkTarget: ProviderLinkTarget): void => {
    setTarget(linkTarget);
    changeCode("");
    const providerId = providerIdSchema.safeParse(linkTarget.providerId);
    if (!providerId.success) {
      setState({ kind: "not_offered" });
      return;
    }
    setState(STARTING);
    startLink.mutate(
      { providerId: providerId.data, profileId: linkTarget.profileId },
      {
        onSuccess: (response) => setState(stateOfLinkStart(response)),
        onError: (error) => setState(teamLinkError(error)),
      },
    );
  };

  const submitCode = (current: SignInState): void => {
    completeLink.mutate(current.linkId, {
      onSuccess: (response) => {
        changeCode("");
        setState((latest) => stateOfLinkComplete(latest, response));
      },
      onError: (error) => setState(teamLinkError(error)),
    });
  };

  let shown = state;
  if (startLink.isPending) shown = STARTING;
  else if (poll.linkId !== null && pollAnswer.error !== null)
    shown = teamLinkError(pollAnswer.error);
  else if (poll.linkId !== null && pollAnswer.data !== undefined)
    shown = stateOfLinkComplete(state, pollAnswer.data);

  return (
    <LinkDialogFrame
      title="Link a plan"
      intro={personal ? LINK_INTRO : teamLinkIntro(teamName)}
      state={shown}
      target={target}
      code={code}
      submitting={completeLink.isPending}
      startable
      onCodeChange={changeCode}
      onStart={start}
      onSubmitCode={submitCode}
      onClose={props.onClose}
    />
  );
}

function ProviderLinkDialogFor(props: {
  readonly target: ProviderLinkTarget;
  readonly onClose: () => void;
}): ReactNode {
  const client = useHostClient();
  // Personal by its own id: a host that has not moved its settings has no
  // environment of its own to link into.
  const { environmentId, resolved } = useAddressedEnvironment();
  const complete = useCallback(
    (linkId: string, code: string | null) =>
      client.request("providers.linkComplete", {
        linkId,
        code,
        environmentId,
      }),
    [client, environmentId],
  );
  const [target, setTarget] = useState<ProviderLinkTarget>(props.target);
  const [state, setState] = useState<LinkDialogState>(INTRO);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Bumped after every poll answer, so a pending answer (which keeps the
  // same state) still arms the next poll.
  const [pollTick, setPollTick] = useState(0);

  const start = async (linkTarget: ProviderLinkTarget): Promise<void> => {
    setTarget(linkTarget);
    setState(STARTING);
    setCode("");
    const providerId = providerIdSchema.safeParse(linkTarget.providerId);
    if (!providerId.success) {
      setState({ kind: "not_offered" });
      return;
    }
    try {
      const response = await client.request("providers.link", {
        providerId: providerId.data,
        profileId: linkTarget.profileId,
        environmentId,
      });
      setState(stateOfLinkStart(response));
    } catch (error) {
      setState(stateOfLinkError(error));
    }
  };

  const submitCode = async (current: SignInState): Promise<void> => {
    setSubmitting(true);
    try {
      const response = await complete(current.linkId, code.trim());
      setCode("");
      setState((latest) => stateOfLinkComplete(latest, response));
    } catch (error) {
      setState(stateOfLinkError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const { linkId: pollLinkId, intervalMs: pollMs } = pollOf(state);
  useEffect(() => {
    if (pollLinkId === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void complete(pollLinkId, null)
        .then((response) => {
          if (cancelled) return;
          setState((latest) => stateOfLinkComplete(latest, response));
          setPollTick((tick) => tick + 1);
        })
        .catch((error: unknown) => {
          if (!cancelled) setState(stateOfLinkError(error));
        });
    }, pollMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [complete, pollLinkId, pollMs, pollTick]);

  return (
    <LinkDialogFrame
      title="Link to your plan"
      intro={LINK_INTRO}
      state={state}
      target={target}
      code={code}
      submitting={submitting}
      // Continue waits for Personal's id, so a link never names the host's
      // own environment in its place.
      startable={resolved}
      onCodeChange={setCode}
      onStart={(linkTarget) => void start(linkTarget)}
      onSubmitCode={(current) => void submitCode(current)}
      onClose={props.onClose}
    />
  );
}

function LinkDialogFrame(props: {
  readonly title: string;
  readonly intro: string;
  readonly state: LinkDialogState;
  readonly target: ProviderLinkTarget;
  readonly code: string;
  readonly submitting: boolean;
  /** False while the environment the link names is still being read. */
  readonly startable: boolean;
  readonly onCodeChange: (code: string) => void;
  readonly onStart: (target: ProviderLinkTarget) => void;
  readonly onSubmitCode: (current: SignInState) => void;
  readonly onClose: () => void;
}): ReactNode {
  const openLink = useOpenLink();
  const hostName = usePersonalHostName() ?? "this host";
  const onOpenChange = (open: boolean): void => {
    if (!open) props.onClose();
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,36rem)] w-[min(92vw,30rem)] flex-col overflow-hidden sm:max-w-none"
        data-testid="provider-link-dialog"
        data-state={props.state.kind}
      >
        <DialogHeader className="gap-1.5">
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.intro}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-5 text-ui-sm">
          <LinkBody
            state={props.state}
            hostName={hostName}
            code={props.code}
            onCodeChange={props.onCodeChange}
            onOpenUrl={(url) => void openLink(url, "auth", null)}
          />
        </div>
        <DialogFooter>
          <LinkActions
            state={props.state}
            target={props.target}
            code={props.code}
            submitting={props.submitting}
            startable={props.startable}
            onStart={props.onStart}
            onSubmitCode={props.onSubmitCode}
            onClose={props.onClose}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Line(props: {
  readonly children: ReactNode;
  readonly testId: string;
  readonly tone: "plain" | "warning";
}): ReactNode {
  return (
    <p
      role="status"
      className={
        props.tone === "warning"
          ? "max-w-[72ch] text-warning-foreground"
          : "max-w-[72ch]"
      }
      data-testid={props.testId}
    >
      {props.children}
    </p>
  );
}

function Spinner(): ReactNode {
  return (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
      tone="muted"
    />
  );
}

function LinkBody(props: {
  readonly state: LinkDialogState;
  readonly hostName: string;
  readonly code: string;
  readonly onCodeChange: (code: string) => void;
  readonly onOpenUrl: (url: string) => void;
}): ReactNode {
  const { state } = props;
  switch (state.kind) {
    case "intro":
      return null;
    case "starting":
      return <Spinner />;
    case "sign_in":
      return (
        <>
          <Line testId="provider-link-sign-in-line" tone="plain">
            {LINK_SIGN_IN_LINE}
          </Line>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => props.onOpenUrl(state.url)}
            data-testid="provider-link-sign-in"
          >
            Sign in on claude.ai
          </Button>
          <Input
            aria-label={state.codePrompt}
            placeholder={state.codePrompt}
            value={props.code}
            onChange={(event) => props.onCodeChange(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="provider-link-code"
          />
          {state.note === null ? null : (
            <Line testId="provider-link-code-note" tone="warning">
              {state.note}
            </Line>
          )}
        </>
      );
    case "device":
      return (
        <>
          <Line testId="provider-link-device-line" tone="plain">
            {LINK_DEVICE_LINE}
          </Line>
          <p
            className="font-mono text-ui-lg tracking-widest"
            data-testid="provider-link-user-code"
          >
            {state.userCode}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => props.onOpenUrl(state.verificationUrl)}
            data-testid="provider-link-device-open"
          >
            Open the sign-in page
          </Button>
        </>
      );
    case "linking":
      return (
        <Line testId="provider-link-linking" tone="plain">
          {LINK_LINKING}
        </Line>
      );
    case "linked":
      return (
        <Line testId="provider-link-linked" tone="plain">
          {linkedLine(state.account)}
        </Line>
      );
    case "mismatch":
      return (
        <Line testId="provider-link-mismatch" tone="warning">
          {mismatchLine(state.account, state.expectedAccount)}
        </Line>
      );
    case "expired":
      return (
        <Line testId="provider-link-expired" tone="warning">
          {LINK_EXPIRED}
        </Line>
      );
    case "failed":
      return (
        <Line testId="provider-link-failed" tone="warning">
          {state.line}
        </Line>
      );
    case "unavailable":
      return (
        <Line testId="provider-link-unavailable" tone="warning">
          {LINK_UNAVAILABLE}
        </Line>
      );
    case "not_offered":
      return (
        <Line testId="provider-link-not-offered" tone="plain">
          {onHostOnlyLine(props.hostName)}
        </Line>
      );
  }
}

function LinkActions(props: {
  readonly state: LinkDialogState;
  readonly target: ProviderLinkTarget;
  readonly code: string;
  readonly submitting: boolean;
  readonly startable: boolean;
  readonly onStart: (target: ProviderLinkTarget) => void;
  readonly onSubmitCode: (
    current: Extract<LinkDialogState, { readonly kind: "sign_in" }>,
  ) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { state } = props;
  const closeButton = (label: string): ReactNode => (
    <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>
      {label}
    </Button>
  );
  switch (state.kind) {
    case "intro":
      return (
        <>
          {closeButton("Cancel")}
          <Button
            type="button"
            size="sm"
            disabled={!props.startable}
            onClick={() => props.onStart(props.target)}
            data-testid="provider-link-continue"
          >
            Continue
          </Button>
        </>
      );
    case "sign_in":
      return (
        <>
          {closeButton("Cancel")}
          <Button
            type="button"
            size="sm"
            disabled={props.submitting || props.code.trim().length === 0}
            onClick={() => props.onSubmitCode(state)}
            data-testid="provider-link-submit-code"
          >
            Link
            {props.submitting ? <Spinner /> : null}
          </Button>
        </>
      );
    case "linked":
      return closeButton("Done");
    case "mismatch":
      return (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              props.onStart({
                providerId: props.target.providerId,
                profileId: null,
                environmentId: props.target.environmentId,
              })
            }
            data-testid="provider-link-add-new"
          >
            {(props.target.environmentId ?? null) === null
              ? "Add as a new profile"
              : "Link another plan"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => props.onStart(props.target)}
            data-testid="provider-link-retry"
          >
            Retry
          </Button>
        </>
      );
    case "expired":
      return (
        <>
          {closeButton("Cancel")}
          <Button
            type="button"
            size="sm"
            onClick={() => props.onStart(props.target)}
            data-testid="provider-link-reconnect"
          >
            Reconnect
          </Button>
        </>
      );
    case "failed":
    case "unavailable":
      return (
        <>
          {closeButton("Close")}
          <Button
            type="button"
            size="sm"
            onClick={() => props.onStart(props.target)}
            data-testid="provider-link-retry"
          >
            Retry
          </Button>
        </>
      );
    case "starting":
    case "device":
    case "linking":
      return closeButton("Cancel");
    case "not_offered":
      return closeButton("Close");
  }
}

/** A team's link refused by a host older than `@1.1` says it needs an update. */
function teamLinkError(error: unknown): LinkDialogState {
  if (error instanceof HostMethodVersionUnsatisfiedError)
    return { kind: "failed", line: "Linking a plan needs an updated host." };
  return stateOfLinkError(error);
}
