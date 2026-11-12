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
import {
  useProvidersLink,
  useProvidersLinkComplete,
  useProvidersLinkCancel,
} from "@/hooks/providers/use-providers-link-mutations";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";
import { CredentialRefusalNote } from "@/components/providers/credential-refusal-note";
import { LINK_NO_SIGN_IN } from "@/lib/providers/provider-link-copy";
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
  readonly client: HostClient<HostRpcRegistry>;
  readonly environmentId: ProvidersLinkRequestV12["environmentId"];
  readonly hostId: string | null;
  completing: boolean;
  linkId: string | null;
  environmentProfileId: string | null;
  closed: boolean;
  cancelSent: boolean;
  connected: boolean;
}

// Dismissal and replacement can change liveness while a request is awaiting.
function isLiveSignInAttempt(
  current: SignInAttempt,
  active: SignInAttempt | null,
): boolean {
  return !current.closed && active === current;
}

export interface EnvironmentSignInCompletion {
  readonly environmentProfileId: string | null;
  readonly profile: ProviderProfile | null;
}

interface EnvironmentProfileSignInProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly request: ProvidersLinkRequestV12;
  readonly autoStart: boolean;
  readonly onActiveChange?: (active: boolean) => void;
  readonly waitForLocalProfile: boolean;
  readonly disabled: boolean;
  readonly onComplete: (completion: EnvironmentSignInCompletion) => void;
  /** A certified local id can finalize presentation without asserting usable auth. */
  readonly onDeliveryPending?: (certifiedProfileId: string | null) => void;
  readonly onCancel: () => void;
}

/** A different target owns a fresh attempt and its auto-start policy.
 * Editable new-profile settings are captured at start, outside that identity. */
export function EnvironmentProfileSignIn(
  props: EnvironmentProfileSignInProps,
): ReactNode {
  const [scope, setScope] = useState(() => ({
    client: props.client,
    request: props.request,
    waitForLocalProfile: props.waitForLocalProfile,
    generation: 0,
  }));
  if (
    scope.client !== props.client ||
    scope.request.environmentId !== props.request.environmentId ||
    scope.request.providerId !== props.request.providerId ||
    scope.request.profileId !== props.request.profileId ||
    scope.request.replaceAccount !== props.request.replaceAccount ||
    (scope.request.createProfile === null) !==
      (props.request.createProfile === null) ||
    scope.waitForLocalProfile !== props.waitForLocalProfile
  )
    setScope({
      client: props.client,
      request: props.request,
      waitForLocalProfile: props.waitForLocalProfile,
      generation: scope.generation + 1,
    });
  return <EnvironmentProfileSignInForScope key={scope.generation} {...props} />;
}

/** One visible sign-in owns one attempt. A late start still releases its item
 * after dismissal; a completed connection is never withdrawn. */
function EnvironmentProfileSignInForScope(
  props: EnvironmentProfileSignInProps,
): ReactNode {
  const credentialRefusal = useHostCredentialRefusal(
    props.client.getActiveHostId(),
  );
  const disabled = props.disabled || credentialRefusal !== null;
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  const [code, setCode] = useState("");
  const { mutateAsync: startLink, isPending: starting } = useProvidersLink();
  const {
    mutateAsync: completeLink,
    isPending: submitting,
    reset: resetComplete,
  } = useProvidersLinkComplete();
  const { mutateAsync: cancelLink } = useProvidersLinkCancel();
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const attempt = useRef<SignInAttempt | null>(null);
  const autoStarted = useRef(false);
  const delivered = useRef(false);
  const onComplete = useRef(props.onComplete);
  const onActiveChange = useRef(props.onActiveChange);
  const onDeliveryPending = useRef(props.onDeliveryPending);
  const onCancel = useRef(props.onCancel);
  useEffect(() => {
    onComplete.current = props.onComplete;
    onActiveChange.current = props.onActiveChange;
    onDeliveryPending.current = props.onDeliveryPending;
    onCancel.current = props.onCancel;
  });
  const inventory = useProvidersListForClient(props.client, {
    enabled: state.kind === "installing" && props.waitForLocalProfile,
    subscribed: true,
  });

  const release = useCallback(
    (current: SignInAttempt): void => {
      current.closed = true;
      const canCancel =
        current.hostId !== null &&
        getNegotiatedHostMethods(current.hostId)?.has(
          "providers.linkCancel",
        ) === true;
      if (
        current.linkId === null ||
        current.cancelSent ||
        current.completing ||
        current.connected ||
        !canCancel
      )
        return;
      current.cancelSent = true;
      void cancelLink({
        client: current.client,
        request: {
          linkId: current.linkId,
          environmentId: current.environmentId,
        },
      }).catch(() => undefined);
    },
    [cancelLink],
  );

  useEffect(
    () => () => {
      if (attempt.current !== null) release(attempt.current);
      onActiveChange.current?.(false);
    },
    [release],
  );

  const finishReceiving = useCallback(
    (certifiedProfileId: string | null): void => {
      if (delivered.current) return;
      delivered.current = true;
      setState({ kind: "complete" });
      toast.info(SIGNED_IN_RECEIVING_LINE);
      if (onDeliveryPending.current !== undefined)
        onDeliveryPending.current(certifiedProfileId);
      else onCancel.current();
    },
    [],
  );

  const accept = (
    current: SignInAttempt,
    response: ProvidersLinkCompleteResponseV12,
  ): void => {
    if (!isLiveSignInAttempt(current, attempt.current) || delivered.current)
      return;
    if (response.state === "expired" && current.connected) {
      finishReceiving(null);
      return;
    }
    if (response.state === "linked" || response.state === "installing") {
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
    if (disabled || starting) return;
    if (attempt.current !== null) release(attempt.current);
    const current: SignInAttempt = {
      client: props.client,
      environmentId: props.request.environmentId,
      hostId: props.client.getActiveHostId(),
      completing: false,
      linkId: null,
      environmentProfileId: null,
      closed: false,
      cancelSent: false,
      connected: false,
    };
    attempt.current = current;
    delivered.current = false;
    onActiveChange.current?.(true);
    setCode("");
    setState({ kind: "starting" });
    try {
      const answer = await startLink({
        client: current.client,
        request: { ...props.request, replaceAccount },
      });
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
      if (isLiveSignInAttempt(current, attempt.current)) {
        onActiveChange.current?.(false);
        setState({
          kind: "failed",
          line:
            error instanceof HostRpcError && error.code === "FORBIDDEN"
              ? "Ask a teammate to sign in on Providers."
              : "Sign-in did not start. Try again.",
        });
      }
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
      disabled ||
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
  }, [props.autoStart, disabled, props.request.replaceAccount]);

  const complete = async (
    current: SignInAttempt,
    pastedCode: string | null,
  ): Promise<void> => {
    if (
      !isLiveSignInAttempt(current, attempt.current) ||
      credentialRefusal !== null ||
      current.completing ||
      current.linkId === null
    )
      return;
    current.completing = true;
    await completeLink({
      client: current.client,
      request: {
        linkId: current.linkId,
        code: pastedCode,
        environmentId: current.environmentId,
      },
    })
      .then((response) => {
        // Dismissal waits for this verdict before deciding whether to withdraw.
        if (response.state === "linked" || response.state === "installing")
          current.connected = true;
        acceptRef.current(current, response);
      })
      .catch(() => {
        if (
          isLiveSignInAttempt(current, attempt.current) &&
          !current.connected &&
          !delivered.current
        )
          setState({
            kind: "failed",
            line:
              pastedCode === null
                ? "Couldn't check this sign-in. Try again."
                : "Sign-in did not finish. Try again.",
          });
      })
      .finally(() => {
        current.completing = false;
        if (!isLiveSignInAttempt(current, attempt.current)) release(current);
        if (attempt.current === current) resetComplete();
      });
  };
  const completeRef = useRef(complete);
  useEffect(() => {
    completeRef.current = complete;
  });

  const polling =
    (state.kind === "installing" && !state.certified) ||
    state.kind === "waiting" ||
    (state.kind === "prompt" && state.prompt.kind === "device_code");
  useEffect(() => {
    const current = attempt.current;
    if (!polling || current === null || current.linkId === null) return;
    return startVisibleInterval({
      intervalMs: 2_000,
      fireOnShow: true,
      tick: () => {
        void completeRef.current(current, null);
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
          delivered.current
        )
          return;
        if (result.data === undefined || result.isError) {
          if (certified) finishReceiving(installingProfileId);
          return;
        }
        if (props.request.profileId !== null && !certified) return;
        const profile = installedEnvironmentProfile(
          result.data.providers,
          props.request.providerId,
          installingEnvironmentId,
          installingProfileId,
        );
        if (profile === null || profile.auth.status !== "authenticated") {
          if (certified) finishReceiving(installingProfileId);
          return;
        }
        delivered.current = true;
        setState({ kind: "complete" });
        onComplete.current({
          environmentProfileId: installingEnvironmentId,
          profile,
        });
      });
    };
    readInventory();
    if (certified)
      return () => {
        disposed = true;
      };
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
    finishReceiving,
  ]);

  const submit = (): void => {
    const current = attempt.current;
    if (
      current === null ||
      current.linkId === null ||
      disabled ||
      code.trim().length === 0 ||
      submitting
    )
      return;
    const pasted = code.trim();
    setCode("");
    void complete(current, pasted);
  };
  const cancel = (): void => {
    if (state.kind === "installing") {
      finishReceiving(state.certified ? state.profileId : null);
      return;
    }
    if (attempt.current !== null) release(attempt.current);
    props.onCancel();
  };
  return (
    <>
      <CredentialRefusalNote refusal={credentialRefusal} />
      <EnvironmentSignInBody
        state={state}
        code={code}
        submitting={submitting}
        disabled={disabled}
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
    </>
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
            ? SIGNED_IN_RECEIVING_LINE
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
          disabled={props.disabled}
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
          <Button
            type="button"
            disabled={props.disabled}
            onClick={props.onStart}
          >
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
        {state.kind === "complete" || state.kind === "installing"
          ? "Done"
          : "Cancel"}
      </Button>
    </div>
  );
}

function EnvironmentSignInPrompt(props: {
  readonly prompt: ProvidersLinkResponseV12["prompt"];
  readonly note: string | null;
  readonly code: string;
  readonly submitting: boolean;
  readonly disabled: boolean;
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
          disabled={props.disabled}
          onChange={(event) => props.onCodeChange(event.target.value)}
          autoComplete="off"
        />
        {props.note === null ? null : (
          <p className="text-ui-xs text-muted-foreground">{props.note}</p>
        )}
        <Button
          type="button"
          disabled={
            props.disabled || props.submitting || props.code.trim().length === 0
          }
          onClick={props.onSubmit}
        >
          {props.submitting ? <MutedAgentSpinner /> : null}
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
    return previous.kind === "prompt" && previous.prompt.kind === "device_code"
      ? previous
      : { kind: "waiting" };
  }
  if (response.state === "expired")
    return { kind: "failed", line: "This sign-in expired." };
  if (response.code === "no_sign_in")
    return { kind: "failed", line: LINK_NO_SIGN_IN };
  return { kind: "failed", line: "Sign-in did not finish. Try again." };
}
