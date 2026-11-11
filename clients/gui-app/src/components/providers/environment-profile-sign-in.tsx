import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
  ProvidersLinkCompleteResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  ACCOUNT_MISMATCH_SIGN_IN_LINE,
  ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
  REPLACE_PROFILE_ACCOUNT_LINE,
  SIGNED_IN_RECEIVING_LINE,
  installedEnvironmentProfile,
} from "@traycer-clients/shared/providers/environment-profile-sign-in";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { getNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { startVisibleInterval } from "@/lib/dom/visible-interval";
import { useOpenLink } from "@/lib/links/open-link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";

type SignInState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "prompt";
      readonly prompt: ProvidersLinkResponseV12["prompt"];
      readonly note: string | null;
    }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "installing";
      readonly environmentProfileId: string | null;
      readonly profileId: string | null;
      readonly certified: boolean;
    }
  | { readonly kind: "complete" }
  | { readonly kind: "refused"; readonly line: string }
  | { readonly kind: "failed"; readonly line: string };

interface SignInAttempt {
  linkId: string | null;
  environmentProfileId: string | null;
  closed: boolean;
  cancelSent: boolean;
  connected: boolean;
}

export interface EnvironmentSignInCompletion {
  readonly environmentProfileId: string | null;
  readonly profile: ProviderProfile | null;
}

/** One visible sign-in owns one attempt. A late start still releases its item
 * after dismissal; a completed connection is never withdrawn. */
export function EnvironmentProfileSignIn(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly request: ProvidersLinkRequestV12;
  readonly autoStart: boolean;
  readonly onStarted?: () => void;
  readonly waitForLocalProfile: boolean;
  readonly disabled: boolean;
  readonly onComplete: (completion: EnvironmentSignInCompletion) => void;
  readonly onDeliveryPending?: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const attempt = useRef<SignInAttempt | null>(null);
  const autoStarted = useRef(false);
  const delivered = useRef(false);
  const onComplete = useRef(props.onComplete);
  useEffect(() => {
    onComplete.current = props.onComplete;
  });
  const inventory = useProvidersListForClient(props.client, {
    enabled: state.kind === "installing" && props.waitForLocalProfile,
    subscribed: true,
  });

  const release = useCallback(
    (current: SignInAttempt): void => {
      current.closed = true;
      const hostId = props.client.getActiveHostId();
      const canCancel =
        hostId !== null &&
        getNegotiatedHostMethods(hostId)?.has("providers.linkCancel") === true;
      if (
        current.linkId === null ||
        current.cancelSent ||
        current.connected ||
        !canCancel
      )
        return;
      current.cancelSent = true;
      void props.client
        .request("providers.linkCancel", {
          linkId: current.linkId,
          environmentId: props.request.environmentId,
        })
        .catch(() => undefined);
    },
    [props.client, props.request.environmentId],
  );

  useEffect(
    () => () => {
      if (attempt.current !== null) release(attempt.current);
    },
    [release],
  );

  const accept = (
    current: SignInAttempt,
    response: ProvidersLinkCompleteResponseV12,
  ): void => {
    if (current.closed || attempt.current !== current || delivered.current)
      return;
    if (response.state === "expired" && current.connected) {
      delivered.current = true;
      setState({ kind: "complete" });
      toast.info(SIGNED_IN_RECEIVING_LINE);
      if (props.onDeliveryPending !== undefined) props.onDeliveryPending();
      else props.onCancel();
      return;
    }
    if (response.state === "linked" || response.state === "installing") {
      current.connected = true;
      if (!props.waitForLocalProfile) {
        setState({ kind: "complete" });
        delivered.current = true;
        onComplete.current({
          environmentProfileId:
            response.environmentProfileId ?? current.environmentProfileId,
          profile: null,
        });
      } else {
        setState({
          kind: "installing",
          environmentProfileId:
            response.environmentProfileId ?? current.environmentProfileId,
          profileId: response.profileId,
          certified: response.state === "linked" && response.profileId !== null,
        });
      }
    } else if (!current.connected) {
      setState((previous) => incompleteSignInState(previous, response));
    }
  };
  const acceptRef = useRef(accept);
  useEffect(() => {
    acceptRef.current = accept;
  });

  const start = async (replaceAccount: boolean): Promise<void> => {
    if (props.disabled) return;
    if (attempt.current !== null) release(attempt.current);
    const current: SignInAttempt = {
      linkId: null,
      environmentProfileId: null,
      closed: false,
      cancelSent: false,
      connected: false,
    };
    attempt.current = current;
    delivered.current = false;
    props.onStarted?.();
    setCode("");
    setState({ kind: "starting" });
    try {
      const answer =
        await props.client.requestWithSignalRequiringHostMethodVersion(
          "providers.link",
          { ...props.request, replaceAccount },
          undefined,
          { method: "providers.link", version: { major: 1, minor: 2 } },
        );
      current.linkId = answer.linkId;
      current.environmentProfileId = answer.environmentProfileId;
      if (current.closed) {
        release(current);
        return;
      }
      if (attempt.current !== current) return;
      setState(
        answer.prompt.kind === "local_handoff"
          ? { kind: "waiting" }
          : { kind: "prompt", prompt: answer.prompt, note: null },
      );
    } catch (error) {
      if (!current.closed && attempt.current === current)
        setState({
          kind: "failed",
          line:
            error instanceof HostRpcError && error.code === "FORBIDDEN"
              ? "Ask a teammate to sign in on Providers."
              : "Sign-in did not start. Try again.",
        });
    }
  };
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    if (
      !props.autoStart ||
      props.request.replaceAccount ||
      props.disabled ||
      autoStarted.current
    )
      return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || autoStarted.current) return;
      autoStarted.current = true;
      void startRef.current(false);
    });
    return () => {
      disposed = true;
    };
  }, [props.autoStart, props.disabled, props.request.replaceAccount]);

  const polling =
    (state.kind === "installing" &&
      props.request.profileId !== null &&
      !state.certified) ||
    state.kind === "waiting" ||
    (state.kind === "prompt" && state.prompt.kind === "device_code");
  useEffect(() => {
    const current = attempt.current;
    if (!polling || current === null || current.linkId === null) return;
    let inFlight = false;
    return startVisibleInterval({
      intervalMs: 2_000,
      fireOnShow: true,
      tick: () => {
        if (inFlight || current.closed || current.linkId === null) return;
        inFlight = true;
        void props.client
          .requestWithSignalRequiringHostMethodVersion(
            "providers.linkComplete",
            {
              linkId: current.linkId,
              code: null,
              environmentId: props.request.environmentId,
            },
            undefined,
            {
              method: "providers.linkComplete",
              version: { major: 1, minor: 2 },
            },
          )
          .then((response) => acceptRef.current(current, response))
          .catch(() => {
            if (!current.closed && !current.connected)
              setState({
                kind: "failed",
                line: "Couldn't check this sign-in. Try again.",
              });
          })
          .finally(() => {
            inFlight = false;
          });
      },
    });
  }, [polling, props.client, props.request.environmentId]);

  const { refetch } = inventory;
  const installing = state.kind === "installing";
  const installingEnvironmentId = installing
    ? state.environmentProfileId
    : null;
  const installingProfileId = installing ? state.profileId : null;
  const certified = installing && state.certified;
  useEffect(() => {
    if (!installing || !props.waitForLocalProfile) return;
    const current = attempt.current;
    let disposed = false;
    const readInventory = (): void => {
      void refetch({ cancelRefetch: false }).then((result) => {
        if (
          disposed ||
          current === null ||
          current.closed ||
          attempt.current !== current ||
          delivered.current ||
          result.data === undefined ||
          result.isError ||
          (props.request.profileId !== null && !certified)
        )
          return;
        const profile = installedEnvironmentProfile(
          result.data.providers,
          props.request.providerId,
          installingEnvironmentId,
          installingProfileId,
        );
        if (profile === null) return;
        delivered.current = true;
        setState({ kind: "complete" });
        onComplete.current({
          environmentProfileId: installingEnvironmentId,
          profile,
        });
      });
    };
    readInventory();
    const stop = startVisibleInterval({
      intervalMs: 2_000,
      fireOnShow: false,
      tick: readInventory,
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [
    installing,
    installingEnvironmentId,
    installingProfileId,
    certified,
    props.waitForLocalProfile,
    props.request.profileId,
    props.request.providerId,
    refetch,
  ]);

  const submit = async (): Promise<void> => {
    const current = attempt.current;
    if (
      current === null ||
      current.linkId === null ||
      code.trim().length === 0 ||
      submitting
    )
      return;
    setSubmitting(true);
    const pasted = code.trim();
    setCode("");
    try {
      acceptRef.current(
        current,
        await props.client.requestWithSignalRequiringHostMethodVersion(
          "providers.linkComplete",
          {
            linkId: current.linkId,
            code: pasted,
            environmentId: props.request.environmentId,
          },
          undefined,
          { method: "providers.linkComplete", version: { major: 1, minor: 2 } },
        ),
      );
    } catch {
      if (!current.closed && !current.connected)
        setState({
          kind: "failed",
          line: "Sign-in did not finish. Try again.",
        });
    }
    setSubmitting(false);
  };
  const cancel = (): void => {
    if (attempt.current !== null) release(attempt.current);
    props.onCancel();
  };
  return (
    <EnvironmentSignInBody
      state={state}
      code={code}
      submitting={submitting}
      disabled={props.disabled}
      replaceAccount={props.request.replaceAccount || replaceConfirmed}
      onStart={() =>
        void start(props.request.replaceAccount || replaceConfirmed)
      }
      onCodeChange={setCode}
      onSubmit={() => void submit()}
      onSwitch={() => {
        setReplaceConfirmed(true);
        setState({ kind: "idle" });
      }}
      onCancel={cancel}
    />
  );
}

function EnvironmentSignInBody(props: {
  readonly state: SignInState;
  readonly code: string;
  readonly submitting: boolean;
  readonly disabled: boolean;
  readonly replaceAccount: boolean;
  readonly onStart: () => void;
  readonly onCodeChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onSwitch: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const openLink = useOpenLink();
  const { state } = props;
  let body: ReactNode;
  switch (state.kind) {
    case "idle":
      body = (
        <>
          {props.replaceAccount ? (
            <p className="text-ui-sm text-muted-foreground">
              {REPLACE_PROFILE_ACCOUNT_LINE}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={props.disabled}
            onClick={props.onStart}
          >
            {props.replaceAccount ? "Switch account" : "Sign in"}
          </Button>
        </>
      );
      break;
    case "starting":
    case "waiting":
    case "installing":
      body = (
        <div className="flex items-center gap-2 text-ui-sm">
          <MutedAgentSpinner />
          {state.kind === "installing"
            ? "Waiting for this profile on this computer…"
            : "Waiting for sign-in…"}
        </div>
      );
      break;
    case "prompt":
      body = (
        <EnvironmentSignInPrompt
          prompt={state.prompt}
          note={state.note}
          code={props.code}
          submitting={props.submitting}
          onCodeChange={props.onCodeChange}
          onSubmit={props.onSubmit}
          onOpen={(url) => void openLink(url, "auth", null)}
        />
      );
      break;
    case "refused":
      body = (
        <>
          <p role="alert" className="text-ui-sm">
            {state.line}
          </p>
          <Button type="button" onClick={props.onSwitch}>
            Switch account
          </Button>
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <p role="alert" className="text-ui-sm">
            {state.line}
          </p>
          <Button type="button" onClick={props.onStart}>
            Retry
          </Button>
        </>
      );
      break;
    case "complete":
      body = null;
      break;
  }
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {body}
      <Button type="button" variant="ghost" onClick={props.onCancel}>
        {state.kind === "complete" ? "Done" : "Cancel"}
      </Button>
    </div>
  );
}

function EnvironmentSignInPrompt(props: {
  readonly prompt: ProvidersLinkResponseV12["prompt"];
  readonly note: string | null;
  readonly code: string;
  readonly submitting: boolean;
  readonly onCodeChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onOpen: (url: string) => void;
}): ReactNode {
  const { prompt } = props;
  if (prompt.kind === "sign_in_url")
    return (
      <>
        <p className="text-ui-sm">
          Sign in on claude.ai, then paste the code it shows.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => props.onOpen(prompt.url)}
        >
          Sign in on claude.ai
        </Button>
        <Input
          aria-label={prompt.codePrompt ?? "Code"}
          value={props.code}
          onChange={(event) => props.onCodeChange(event.target.value)}
          autoComplete="off"
        />
        {props.note === null ? null : (
          <p className="text-ui-xs text-muted-foreground">{props.note}</p>
        )}
        <Button
          type="button"
          disabled={props.submitting || props.code.trim().length === 0}
          onClick={props.onSubmit}
        >
          Sign in
        </Button>
      </>
    );
  if (prompt.kind === "device_code")
    return (
      <>
        <p className="text-ui-sm">
          Open the page below and enter this code to sign in.
        </p>
        <code className="text-ui-base font-mono">{prompt.userCode}</code>
        <Button
          type="button"
          variant="outline"
          onClick={() => props.onOpen(prompt.verificationUrl)}
        >
          Open sign-in page
        </Button>
      </>
    );
  return null;
}

function incompleteSignInState(
  previous: SignInState,
  response: ProvidersLinkCompleteResponseV12,
): SignInState {
  if (
    response.code === "harness_account_mismatch" ||
    response.code === "harness_account_unidentified" ||
    response.state === "mismatch"
  ) {
    return {
      kind: "refused",
      line:
        response.code === "harness_account_unidentified"
          ? ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE
          : ACCOUNT_MISMATCH_SIGN_IN_LINE,
    };
  }
  if (response.state === "pending") {
    if (response.code === "harness_token_shape")
      return previous.kind === "prompt"
        ? { ...previous, note: "Paste the whole code claude.ai shows." }
        : previous;
    return { kind: "waiting" };
  }
  return {
    kind: "failed",
    line:
      response.state === "expired"
        ? "This sign-in expired."
        : "Sign-in did not finish. Try again.",
  };
}
