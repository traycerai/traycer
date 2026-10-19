import { useEffect, useState, type ReactNode } from "react";
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
  if (target === null) return null;
  // Keyed by the target, so a new target starts from the intro.
  return (
    <ProviderLinkDialogFor
      key={`${target.providerId}:${target.profileId ?? "new"}`}
      target={target}
      onClose={close}
    />
  );
}

function ProviderLinkDialogFor(props: {
  readonly target: ProviderLinkTarget;
  readonly onClose: () => void;
}): ReactNode {
  const client = useHostClient();
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
      const response = await client.request("providers.link", {
        providerId: providerId.data,
        profileId: linkTarget.profileId,
      });
      setState(stateOfLinkStart(response));
    } catch (error) {
      setState(stateOfLinkError(error));
    }
  };

  const submitCode = async (
    current: Extract<LinkDialogState, { readonly kind: "sign_in" }>,
  ): Promise<void> => {
    setSubmitting(true);
    try {
      const response = await client.request("providers.linkComplete", {
        linkId: current.linkId,
        code: code.trim(),
      });
      setCode("");
      setState((latest) => stateOfLinkComplete(latest, response));
    } catch (error) {
      setState(stateOfLinkError(error));
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
      void client
        .request("providers.linkComplete", { linkId: pollLinkId, code: null })
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
  }, [client, pollLinkId, pollMs, pollTick]);

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
          <DialogTitle>Link to your plan</DialogTitle>
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
              })
            }
            data-testid="provider-link-add-new"
          >
            Add as a new profile
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
