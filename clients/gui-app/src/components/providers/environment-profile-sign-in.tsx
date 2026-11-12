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
import {
  LINK_NO_SIGN_IN,
  LINK_OUTCOME_UNKNOWN,
  isLinkCompletionOutcomeUnknown,
} from "@/lib/providers/provider-link-copy";
import { getNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  HostRpcError,
  mayHaveReachedHost,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { startVisibleInterval } from "@/lib/dom/visible-interval";
import { useOpenLink } from "@/lib/links/open-link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AddProfileFailureStep,
  AddProfileStatusCard,
  AddProfileWaitingStep,
} from "@/components/settings/panels/add-profile-steps";
import {
  CODE_PASTE_RESTART_CAP,
  CODE_PASTE_RESTART_LIMIT_MESSAGES,
  CODE_PASTE_RESTART_NOTICES,
  type CodePasteRestartCause,
  type ProviderProfileLoginFlowCodePaste,
} from "@/components/settings/panels/use-provider-profile-login-flow";

type SignInState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "prompt";
      readonly prompt: ProvidersLinkResponseV12["prompt"];
    }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "installing";
      readonly account: string | null;
      readonly environmentProfileId: string | null;
      readonly profileId: string | null;
      readonly certified: boolean;
    }
  | { readonly kind: "complete" }
  | { readonly kind: "refused"; readonly line: string }
  | { readonly kind: "failed"; readonly line: string }
  /** The host will not run this sign-in; another attempt here cannot help. */
  | { readonly kind: "declined"; readonly line: string };

type SignInStartFailure = Extract<
  SignInState,
  { readonly kind: "refused" | "failed" | "declined" }
>;

const NOT_OFFERED_LINE = "Sign-in is not offered for this profile here.";

function isNotOffered(error: unknown): boolean {
  return (
    error instanceof HostRpcError && error.code === "PROVIDER_LINK_NOT_OFFERED"
  );
}

function pastesCode(prompt: ProvidersLinkResponseV12["prompt"]): boolean {
  return prompt.kind === "sign_in_url" && prompt.codePrompt !== null;
}

function signInStartFailure(error: unknown, team: boolean): SignInStartFailure {
  if (mayHaveReachedHost(error))
    return { kind: "failed", line: LINK_OUTCOME_UNKNOWN };
  if (
    error instanceof HostRpcError &&
    error.code === "harness_account_unidentified"
  )
    return { kind: "refused", line: ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE };
  if (isNotOffered(error)) return { kind: "declined", line: NOT_OFFERED_LINE };
  // The host's own words, such as an update it needs first.
  if (
    error instanceof HostRpcError &&
    error.code === "PROVIDER_LINK_UNAVAILABLE" &&
    error.message.length > 0
  )
    return { kind: "declined", line: error.message };
  return {
    kind: "failed",
    line:
      team && error instanceof HostRpcError && error.code === "FORBIDDEN"
        ? "Ask a teammate to sign in on Providers."
        : "Sign-in did not start. Try again.",
  };
}

interface SignInAttempt {
  readonly client: HostClient<HostRpcRegistry>;
  readonly environmentId: ProvidersLinkRequestV12["environmentId"];
  readonly hostId: string | null;
  readonly replaceAccount: boolean;
  /** Set once the answer is a sign-in link whose code is pasted back. */
  pastesCode: boolean;
  completing: boolean;
  linkId: string | null;
  environmentProfileId: string | null;
  closed: boolean;
  cancelSent: boolean;
  /** Null means a request may have committed without an observed answer. */
  connected: boolean | null;
}

// Dismissal and replacement can change liveness while a request is awaiting.
function isLiveSignInAttempt(
  current: SignInAttempt,
  active: SignInAttempt | null,
): boolean {
  return !current.closed && active === current;
}

export interface EnvironmentSignInCompletion {
  /** The account the host says was signed in, when it names one. */
  readonly account: string | null;
  readonly environmentProfileId: string | null;
  readonly profile: ProviderProfile | null;
}

interface EnvironmentProfileSignInProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly request: ProvidersLinkRequestV12;
  readonly waitForLocalProfile: boolean;
  /** The sign-in goes to a team's environment, not Personal. */
  readonly team: boolean;
  /** The add dialog sets its waiting step off from the fields above it. */
  readonly ruleAboveWaitingStep: boolean;
  /** Where a filed issue says a failed sign-in happened. */
  readonly reportSource: string;
  readonly onComplete: (completion: EnvironmentSignInCompletion) => void;
  /** A certified local id can finalize presentation without asserting usable auth. */
  readonly onDeliveryPending?: (certifiedProfileId: string | null) => void;
  /** Takes over when the host does not offer this sign-in for the profile,
   * such as one detached from its environment; null shows the refusal. */
  readonly onNotOffered: (() => void) | null;
  readonly onCancel: () => void;
}

/** Mounting starts the sign-in, unless it would replace the profile's account,
 * which waits for Switch account. A different target owns a fresh attempt.
 * New-profile settings are captured at start, outside that identity. */
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
 * after dismissal; a completed connection is never withdrawn. A pasted code
 * the provider refuses, or a link that ran out, starts a fresh link on its
 * own, at most `CODE_PASTE_RESTART_CAP` times, as the local sign-in does. */
function EnvironmentProfileSignInForScope(
  props: EnvironmentProfileSignInProps,
): ReactNode {
  const credentialRefusal = useHostCredentialRefusal(
    props.client.getActiveHostId(),
  );
  const disabled = credentialRefusal !== null;
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  // Each link gets a fresh paste field; so does a code the host asked to be
  // pasted whole, so the field takes the next paste.
  const [pasteAttempt, setPasteAttempt] = useState(0);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const restarts = useRef(0);
  const { mutateAsync: startLink, isPending: starting } = useProvidersLink();
  const {
    mutateAsync: completeLink,
    isPending: completing,
    variables: completeVariables,
    reset: resetComplete,
  } = useProvidersLinkComplete();
  const submittingCode = completing && completeVariables.request.code !== null;
  const { mutateAsync: cancelLink } = useProvidersLinkCancel();
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const attempt = useRef<SignInAttempt | null>(null);
  const autoStarted = useRef(false);
  const delivered = useRef(false);
  const onComplete = useRef(props.onComplete);
  const onDeliveryPending = useRef(props.onDeliveryPending);
  const onNotOffered = useRef(props.onNotOffered);
  const onCancel = useRef(props.onCancel);
  useEffect(() => {
    onComplete.current = props.onComplete;
    onDeliveryPending.current = props.onDeliveryPending;
    onNotOffered.current = props.onNotOffered;
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
        current.connected !== false ||
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
    },
    [release],
  );

  const finishReceiving = useCallback(
    (certifiedProfileId: string | null): void => {
      if (delivered.current || attempt.current?.connected !== true) return;
      delivered.current = true;
      setState({ kind: "complete" });
      toast.info(SIGNED_IN_RECEIVING_LINE);
      if (onDeliveryPending.current !== undefined)
        onDeliveryPending.current(certifiedProfileId);
      else onCancel.current();
    },
    [],
  );

  const markOutcomeUnknown = (current: SignInAttempt): void => {
    current.connected = null;
    // Refresh the displayed inventory once; a row cannot certify this attempt.
    void inventory.refetch({ cancelRefetch: false });
    if (isLiveSignInAttempt(current, attempt.current) && !delivered.current)
      setState({ kind: "failed", line: LINK_OUTCOME_UNKNOWN });
    else toast.info(LINK_OUTCOME_UNKNOWN);
  };

  const accept = (
    current: SignInAttempt,
    response: ProvidersLinkCompleteResponseV12,
  ): void => {
    if (!isLiveSignInAttempt(current, attempt.current) || delivered.current)
      return;
    if (response.state === "expired" && current.connected === true) {
      finishReceiving(null);
      return;
    }
    if (response.state === "linked" || response.state === "installing") {
      if (!props.waitForLocalProfile) {
        setState({ kind: "complete" });
        delivered.current = true;
        onComplete.current({
          account: response.account,
          environmentProfileId:
            response.environmentProfileId ?? current.environmentProfileId,
          profile: null,
        });
      } else {
        setState({
          kind: "installing",
          account: response.account,
          environmentProfileId:
            response.environmentProfileId ?? current.environmentProfileId,
          profileId: response.profileId,
          certified: response.state === "linked" && response.profileId !== null,
        });
      }
    } else if (current.connected === false) {
      const restartCause = codePasteRestartCause(current, response);
      if (restartCause !== null) {
        restart(current, restartCause);
        return;
      }
      if (response.code === "harness_token_shape" && current.pastesCode) {
        setPasteNotice(TOKEN_SHAPE_NOTICE);
        setPasteAttempt((previous) => previous + 1);
      }
      setState((previous) => incompleteSignInState(previous, response));
    }
  };
  const restart = (
    current: SignInAttempt,
    cause: CodePasteRestartCause,
  ): void => {
    if (restarts.current >= CODE_PASTE_RESTART_CAP) {
      setState({
        kind: "failed",
        line: CODE_PASTE_RESTART_LIMIT_MESSAGES[cause],
      });
      return;
    }
    restarts.current += 1;
    void startRef.current(
      current.replaceAccount,
      CODE_PASTE_RESTART_NOTICES[cause],
    );
  };
  const acceptRef = useRef(accept);
  useEffect(() => {
    acceptRef.current = accept;
  });

  /** `restartNotice` is null for a person's own start, which also gives the
   * automatic restarts their full allowance again. */
  const start = async (
    replaceAccount: boolean,
    restartNotice: string | null,
  ): Promise<void> => {
    if (disabled || starting || attempt.current?.connected === null) return;
    if (attempt.current !== null) release(attempt.current);
    const current: SignInAttempt = {
      client: props.client,
      environmentId: props.request.environmentId,
      hostId: props.client.getActiveHostId(),
      replaceAccount,
      pastesCode: false,
      completing: false,
      linkId: null,
      environmentProfileId: null,
      closed: false,
      cancelSent: false,
      connected: false,
    };
    attempt.current = current;
    delivered.current = false;
    if (restartNotice === null) restarts.current = 0;
    setPasteNotice(restartNotice);
    setPasteAttempt((previous) => previous + 1);
    setState({ kind: "starting" });
    try {
      const answer = await startLink({
        client: current.client,
        request: { ...props.request, replaceAccount },
      });
      current.linkId = answer.linkId;
      current.environmentProfileId = answer.environmentProfileId;
      current.pastesCode = pastesCode(answer.prompt);
      if (current.closed) {
        release(current);
        return;
      }
      if (attempt.current !== current) return;
      setState(
        answer.prompt.kind === "local_handoff"
          ? { kind: "waiting" }
          : { kind: "prompt", prompt: answer.prompt },
      );
    } catch (error) {
      if (isLiveSignInAttempt(current, attempt.current))
        startFailed(current, error);
    }
  };
  const startFailed = (current: SignInAttempt, error: unknown): void => {
    if (isNotOffered(error) && onNotOffered.current !== null) {
      onNotOffered.current();
      return;
    }
    if (mayHaveReachedHost(error)) current.connected = null;
    setState(signInStartFailure(error, props.team));
  };
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    if (props.request.replaceAccount || disabled || autoStarted.current) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || autoStarted.current) return;
      autoStarted.current = true;
      void startRef.current(false, null);
    });
    return () => {
      disposed = true;
    };
  }, [disabled, props.request.replaceAccount]);

  const complete = async (
    current: SignInAttempt,
    pastedCode: string | null,
  ): Promise<void> => {
    if (
      !isLiveSignInAttempt(current, attempt.current) ||
      credentialRefusal !== null ||
      current.completing ||
      current.connected === null ||
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
        else if (
          response.state === "unavailable" &&
          current.connected !== true
        ) {
          // A check without a code changed nothing; the next one asks again.
          if (pastedCode !== null) markOutcomeUnknown(current);
          return;
        }
        acceptRef.current(current, response);
      })
      .catch((error: unknown) => {
        // A check that never reached the host changed nothing either. One
        // that may have is not retried: the host forgets a link once it
        // answers linked, so the next check would read "expired".
        if (
          pastedCode === null &&
          current.connected === false &&
          !isLinkCompletionOutcomeUnknown(error)
        )
          return;
        if (
          current.connected !== true &&
          isLinkCompletionOutcomeUnknown(error)
        ) {
          markOutcomeUnknown(current);
          return;
        }
        if (
          isLiveSignInAttempt(current, attempt.current) &&
          current.connected === false &&
          !delivered.current
        )
          setState({
            kind: "failed",
            line: "Sign-in did not finish. Try again.",
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
  const installingAccount = installing ? state.account : null;
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
          account: installingAccount,
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
    installingAccount,
    certified,
    props.waitForLocalProfile,
    props.request.profileId,
    props.request.providerId,
    refetch,
    finishReceiving,
  ]);

  const codePaste: ProviderProfileLoginFlowCodePaste = {
    enabled: state.kind === "prompt" && pastesCode(state.prompt),
    attemptId: pasteAttempt,
    restartNotice: pasteNotice,
    phase: submittingCode ? "submitting" : "idle",
    submitError: null,
    submit: (pasted) => {
      const current = attempt.current;
      if (current === null || current.linkId === null || disabled) return;
      void complete(current, pasted);
    },
    touch: () => undefined,
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
        providerId={props.request.providerId}
        ruleAboveWaitingStep={props.ruleAboveWaitingStep}
        reportSource={props.reportSource}
        codePaste={codePaste}
        disabled={disabled}
        replaceAccount={props.request.replaceAccount || replaceConfirmed}
        onStart={() =>
          void start(props.request.replaceAccount || replaceConfirmed, null)
        }
        onSwitch={() => {
          setReplaceConfirmed(true);
          setState({ kind: "idle" });
        }}
        onCancel={cancel}
      />
    </>
  );
}

const TOKEN_SHAPE_NOTICE = "Paste the whole code claude.ai shows.";

/** Why a pasted-code sign-in starts a fresh link on its own, if it does. */
function codePasteRestartCause(
  current: SignInAttempt,
  response: ProvidersLinkCompleteResponseV12,
): CodePasteRestartCause | null {
  if (!current.pastesCode) return null;
  if (response.state === "expired") return "sessionExpired";
  if (response.state === "failed" && response.code === "harness_token_invalid")
    return "codeRejected";
  return null;
}

/** The sign-in link or device page and its code, as the waiting step shows them. */
function promptProgress(state: SignInState): {
  readonly loginUrl: string | null;
  readonly userCode: string | null;
} {
  if (state.kind !== "prompt") return { loginUrl: null, userCode: null };
  const { prompt } = state;
  if (prompt.kind === "sign_in_url")
    return { loginUrl: prompt.url, userCode: null };
  if (prompt.kind === "device_code")
    return { loginUrl: prompt.verificationUrl, userCode: prompt.userCode };
  return { loginUrl: null, userCode: null };
}

function EnvironmentSignInBody(props: {
  readonly state: SignInState;
  readonly providerId: ProvidersLinkRequestV12["providerId"];
  readonly ruleAboveWaitingStep: boolean;
  readonly reportSource: string;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly disabled: boolean;
  readonly replaceAccount: boolean;
  readonly onStart: () => void;
  readonly onSwitch: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { state } = props;
  if (state.kind === "idle" && props.replaceAccount)
    return (
      <EnvironmentSwitchAccountStep
        disabled={props.disabled}
        onStart={props.onStart}
        onCancel={props.onCancel}
      />
    );
  if (state.kind === "idle" && props.disabled)
    return (
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    );
  switch (state.kind) {
    // Not refused and not replacing: the automatic start is a microtask away.
    case "idle":
    case "starting":
    case "prompt":
      return (
        <EnvironmentWaitingStep
          state={state}
          codePaste={props.codePaste}
          ruleAbove={props.ruleAboveWaitingStep}
          onCancel={props.onCancel}
        />
      );
    case "waiting":
    case "installing":
      return (
        <EnvironmentStatusStep
          receiving={state.kind === "installing"}
          onCancel={props.onCancel}
        />
      );
    case "refused":
    case "declined":
    case "failed":
      return <EnvironmentFailureStep {...props} state={state} />;
    case "complete":
      return null;
  }
}

function EnvironmentStatusStep(props: {
  /** Signed in, while this computer is still receiving the profile. */
  readonly receiving: boolean;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <AddProfileStatusCard>
        {props.receiving ? SIGNED_IN_RECEIVING_LINE : "Waiting for sign-in…"}
      </AddProfileStatusCard>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant={props.receiving ? "secondary" : "ghost"}
          onClick={props.onCancel}
        >
          {props.receiving ? "Done" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

function EnvironmentFailureStep(props: {
  readonly state: Extract<
    SignInState,
    { readonly kind: "refused" | "declined" | "failed" }
  >;
  readonly providerId: ProvidersLinkRequestV12["providerId"];
  readonly reportSource: string;
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onSwitch: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { state } = props;
  let retry: (() => void) | null = null;
  if (state.kind === "refused") retry = props.onSwitch;
  else if (
    state.kind === "failed" &&
    state.line !== LINK_OUTCOME_UNKNOWN &&
    !props.disabled
  )
    retry = props.onStart;
  return (
    <AddProfileFailureStep
      providerId={props.providerId}
      message={state.line}
      refusal={null}
      source={props.reportSource}
      retryLabel={state.kind === "refused" ? "Switch account" : "Retry"}
      onCancel={props.onCancel}
      onRetry={retry}
    />
  );
}

function EnvironmentWaitingStep(props: {
  readonly state: Extract<
    SignInState,
    { readonly kind: "idle" | "starting" | "prompt" }
  >;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly ruleAbove: boolean;
  readonly onCancel: () => void;
}): ReactNode {
  const openLink = useOpenLink();
  const { loginUrl, userCode } = promptProgress(props.state);
  const prompted = props.state.kind === "prompt";
  const waitingStep = (
    <AddProfileWaitingStep
      loginUrl={loginUrl}
      userCode={userCode}
      // No sign-in process runs on a computer for this link, so this window
      // is the one that opens it.
      autoOpenBrowser
      codeReturn={props.codePaste.enabled ? "paste" : "automatic"}
      queuePending={!prompted}
      startingCopy={null}
      cancelRequested={false}
      cancelPending={false}
      cancelDisabled={false}
      waiting={prompted}
      codePaste={props.codePaste}
      onOpenExternalLink={(url) => void openLink(url, "auth", null)}
      onCancel={props.onCancel}
    />
  );
  return props.ruleAbove ? (
    <div className="border-t border-border/60 pt-4">{waitingStep}</div>
  ) : (
    waitingStep
  );
}

function EnvironmentSwitchAccountStep(props: {
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ui-sm text-muted-foreground">
        {REPLACE_PROFILE_ACCOUNT_LINE}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={props.disabled}
          onClick={props.onStart}
        >
          Switch account
        </Button>
      </div>
    </div>
  );
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
    if (response.code === "harness_token_shape") return previous;
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
