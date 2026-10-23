import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
import { useConfigurationEnvironmentId } from "@/components/settings/environment/configuration-source";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { useQueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { useOpenLink } from "@/lib/links/open-link";
import {
  LINK_DEVICE_LINE,
  LINK_EXPIRED,
  LINK_INTRO,
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
 * The calls are direct requests, as the Secrets page's Add a secret makes
 * them: the pasted code is a one-time credential and reaches no query or
 * mutation cache, and closing the dialog drops it.
 */

const DEVICE_POLL_MS = 5_000;
const LINKING_POLL_MS = 2_000;

const INTRO: LinkDialogState = { kind: "intro" };

export function ProviderLinkDialog(): ReactNode {
  const target = useProviderLinkDialogStore((state) => state.target);
  const close = useProviderLinkDialogStore((state) => state.close);
  const environmentId = useConfigurationEnvironmentId();
  if (target === null || (target.environmentId ?? null) !== environmentId)
    return null;
  // Keyed by the target, so a new target starts from the intro.
  if (environmentId !== null)
    return (
      <TeamProviderLinkDialogFor
        key={`${environmentId}:${target.providerId}:${target.profileId ?? "new"}`}
        target={target}
        environmentId={environmentId}
        onClose={close}
      />
    );
  return (
    <ProviderLinkDialogFor
      key={`${environmentId}:${target.providerId}:${target.profileId ?? "new"}`}
      target={target}
      onClose={close}
      onLinked={null}
    />
  );
}

function TeamProviderLinkDialogFor(props: {
  readonly target: ProviderLinkTarget;
  readonly environmentId: string;
  readonly onClose: () => void;
}): ReactNode {
  const queries = useQueryClient();
  const environmentId = props.environmentId;
  const onLinked = useCallback(
    (hostId: string | null): void => {
      void queries.invalidateQueries({
        queryKey: hostQueryKeys.method(hostId, "environment.plans.list", {
          environmentId,
        }),
      });
      void queries.invalidateQueries({
        queryKey: hostQueryKeys.method(
          hostId,
          "environment.configuration.items",
          { environmentId },
        ),
      });
    },
    [queries, environmentId],
  );
  return (
    <ProviderLinkDialogFor
      target={props.target}
      onClose={props.onClose}
      onLinked={onLinked}
    />
  );
}

function ProviderLinkDialogFor(props: {
  readonly target: ProviderLinkTarget;
  readonly onClose: () => void;
  readonly onLinked: ((hostId: string | null) => void) | null;
}): ReactNode {
  const hostClient = useHostClient();
  const poolClient = usePoolTierHostClient(hostClient);
  const environmentId = props.target.environmentId ?? null;
  const client = environmentId === null ? hostClient : poolClient;
  const onLinked = props.onLinked;
  const complete = useCallback(
    async (linkId: string, code: string | null) => {
      const hostId = client.getActiveHostId();
      const method = "providers.linkComplete";
      const request = { linkId, code, environmentId };
      if (environmentId !== null) cloudVerdictPreflight(method)();
      const response =
        environmentId === null
          ? await client.request(method, request)
          : await client.requestWithSignalRequiringHostMethodVersion(
              method,
              request,
              undefined,
              { method, version: { major: 1, minor: 1 } },
            );
      if (response.state === "linked") onLinked?.(hostId);
      return response;
    },
    [client, environmentId, onLinked],
  );
  const openLink = useOpenLink();
  const hostName = usePersonalHostName() ?? "this host";
  const [target, setTarget] = useState<ProviderLinkTarget>(props.target);
  const [state, setState] = useState<LinkDialogState>(INTRO);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Bumped after every poll answer, so a pending answer (which keeps the
  // same state) still arms the next poll.
  const [pollTick, setPollTick] = useState(0);

  const start = async (linkTarget: ProviderLinkTarget): Promise<void> => {
    setTarget(linkTarget);
    setState({ kind: "starting" });
    setCode("");
    const providerId = providerIdSchema.safeParse(linkTarget.providerId);
    if (!providerId.success) {
      setState({ kind: "not_offered" });
      return;
    }
    try {
      const method = "providers.link";
      const request = {
        providerId: providerId.data,
        profileId: linkTarget.profileId,
        environmentId,
      };
      if (environmentId !== null) cloudVerdictPreflight(method)();
      const response =
        environmentId === null
          ? await client.request(method, request)
          : await client.requestWithSignalRequiringHostMethodVersion(
              method,
              request,
              undefined,
              { method, version: { major: 1, minor: 1 } },
            );
      setState(stateOfLinkStart(response));
    } catch (error) {
      setState(sourceLinkError(error, environmentId));
    }
  };

  const submitCode = async (
    current: Extract<LinkDialogState, { readonly kind: "sign_in" }>,
  ): Promise<void> => {
    setSubmitting(true);
    try {
      const response = await complete(current.linkId, code.trim());
      setCode("");
      setState((latest) => stateOfLinkComplete(latest, response));
    } catch (error) {
      setState(sourceLinkError(error, environmentId));
    } finally {
      setSubmitting(false);
    }
  };

  // A device code and a local handoff are polled until they settle.
  const pollLinkId =
    state.kind === "device" || state.kind === "linking" ? state.linkId : null;
  const pollMs = state.kind === "device" ? DEVICE_POLL_MS : LINKING_POLL_MS;
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
          if (!cancelled) setState(sourceLinkError(error, environmentId));
        });
    }, pollMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [complete, environmentId, pollLinkId, pollMs, pollTick]);

  const onOpenChange = (open: boolean): void => {
    if (!open) props.onClose();
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,36rem)] w-[min(92vw,30rem)] flex-col overflow-hidden sm:max-w-none"
        data-testid="provider-link-dialog"
        data-state={state.kind}
      >
        <DialogHeader className="gap-1.5">
          <DialogTitle>
            {environmentId === null ? "Link to your plan" : "Link a plan"}
          </DialogTitle>
          <DialogDescription>{LINK_INTRO}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-5 text-ui-sm">
          <LinkBody
            state={state}
            hostName={hostName}
            code={code}
            onCodeChange={setCode}
            onOpenUrl={(url) => void openLink(url, "auth", null)}
          />
        </div>
        <DialogFooter>
          <LinkActions
            state={state}
            target={target}
            code={code}
            submitting={submitting}
            onStart={(linkTarget) => void start(linkTarget)}
            onSubmitCode={(current) => void submitCode(current)}
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

function sourceLinkError(
  error: unknown,
  environmentId: string | null,
): LinkDialogState {
  if (
    environmentId !== null &&
    error instanceof HostMethodVersionUnsatisfiedError
  )
    return { kind: "failed", line: "Linking a plan needs an updated host." };
  return stateOfLinkError(error);
}
