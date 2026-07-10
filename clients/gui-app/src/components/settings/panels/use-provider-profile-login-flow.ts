import { useCallback, useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

type LoginMutationContext = { readonly hostId: string | null };

export type StartLoginMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.startLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.startLogin">,
  LoginMutationContext
>;
export type AwaitLoginMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.awaitLogin">,
  LoginMutationContext
>;
export type CancelLoginMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.cancelLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.cancelLogin">,
  LoginMutationContext
>;

export type ProviderProfileLoginFlowMode = "create" | "reauth";

export type ProviderProfileLoginFlowState =
  | { readonly kind: "start" }
  | {
      readonly kind: "waiting";
      readonly profileId: string | null;
      readonly url: string | null;
    }
  | {
      readonly kind: "identity";
      readonly profileId: string;
      readonly profile: ProviderProfile;
      readonly profiles: readonly ProviderProfile[];
    }
  | { readonly kind: "failed"; readonly message: string };

interface UseProviderProfileLoginFlowInput {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly providerId: ProviderCliState["providerId"];
  /** Reauth mode always targets this existing profile - the flow awaits THIS
   *  id regardless of what `startLogin`'s response echoes, and begins in
   *  `waiting` immediately (there is no "start" screen for a reauth: mounting
   *  the dialog always means a sign-in attempt is already underway). Create
   *  mode has no profile yet, so it begins in `start` and awaits whatever id
   *  `startLogin` mints. */
  readonly existingProfileId: string | null;
  readonly startLogin: StartLoginMutation;
  readonly awaitLogin: AwaitLoginMutation;
  readonly cancelLogin: CancelLoginMutation;
  /** Copy for the two failure edges - distinct per mode to match each
   *  dialog's existing wording. */
  readonly failureMessages: {
    readonly notStarted: string;
    readonly notFinished: string;
  };
  /** Fires once, the instant the flow lands on `failed` - lets a caller
   *  surface the failure outside the dialog (the Settings panel's inline
   *  retry banner). Reauth mode, which has no such banner, passes a no-op. */
  readonly onFailed: (message: string) => void;
}

export interface ProviderProfileLoginFlow {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly state: ProviderProfileLoginFlowState;
  /** Either of the flow's own mutations in flight. */
  readonly busy: boolean;
  /** `providers.startLogin` specifically - the "queued behind another
   *  sign-in" wording only applies while this mutation, not `awaitLogin`,
   *  is pending. */
  readonly startPending: boolean;
  readonly start: (options: {
    readonly shareSkillsAndPlugins: boolean;
  }) => void;
  readonly cancel: () => void;
}

function initialState(
  mode: ProviderProfileLoginFlowMode,
  existingProfileId: string | null,
): ProviderProfileLoginFlowState {
  return mode === "reauth"
    ? { kind: "waiting", profileId: existingProfileId, url: null }
    : { kind: "start" };
}

/**
 * Shared OAuth login-flow state machine (multi-profile UX overhaul, S10):
 * owns the start -> waiting -> identity | failed transitions and the
 * `providers.startLogin` / `providers.awaitLogin` / `providers.cancelLogin`
 * mutation callbacks, so the add-profile and reauth dialogs stop hand-rolling
 * the same flow twice (each previously carried parallel nullable fields and
 * an empty `onSettled`).
 *
 * Callers render their own UI per `state.kind`; naming/coloring (the
 * add-profile dialog's "details" step) is form state layered on top of a
 * resolved `identity`, not part of this machine. Callers are expected to stay
 * conditionally mounted (as both dialogs already are) so closing discards
 * this hook's state and any still-pending mutate-level callbacks land on an
 * already-unmounted instance - never a reopened one.
 */
export function useProviderProfileLoginFlow(
  input: UseProviderProfileLoginFlowInput,
): ProviderProfileLoginFlow {
  const {
    mode,
    providerId,
    existingProfileId,
    startLogin,
    awaitLogin,
    cancelLogin,
    failureMessages,
    onFailed,
  } = input;
  const [state, setState] = useState<ProviderProfileLoginFlowState>(() =>
    initialState(mode, existingProfileId),
  );

  const fail = useCallback(
    (message: string): void => {
      setState({ kind: "failed", message });
      onFailed(message);
    },
    [onFailed],
  );

  const start = useCallback(
    (options: { readonly shareSkillsAndPlugins: boolean }): void => {
      if (startLogin.isPending || awaitLogin.isPending) return;
      startLogin.mutate(
        {
          providerId,
          profileId: existingProfileId,
          createProfile:
            mode === "create"
              ? {
                  label: "",
                  shareSkillsAndPlugins: options.shareSkillsAndPlugins,
                }
              : null,
        },
        {
          onSuccess: (data) => {
            // Reauth always awaits the profile it was invoked for - the
            // response never mints a different id for an existing profile.
            // Create has no id until this response supplies one.
            const nextProfileId =
              mode === "reauth" ? existingProfileId : data.profileId;
            if (!data.started || nextProfileId === null) {
              fail(failureMessages.notStarted);
              return;
            }
            setState({
              kind: "waiting",
              profileId: nextProfileId,
              url: data.url,
            });
            awaitLogin.mutate(
              { providerId, profileId: nextProfileId },
              {
                onSuccess: (result) => {
                  const profiles = result.state?.profiles ?? [];
                  const profile =
                    profiles.find(
                      (candidate) => candidate.profileId === nextProfileId,
                    ) ?? null;
                  if (profile === null) {
                    fail(failureMessages.notFinished);
                    return;
                  }
                  setState({
                    kind: "identity",
                    profileId: profile.profileId,
                    profile,
                    profiles,
                  });
                },
                onError: () => fail(failureMessages.notFinished),
              },
            );
          },
          onError: () => fail(failureMessages.notStarted),
        },
      );
    },
    [
      awaitLogin,
      existingProfileId,
      fail,
      failureMessages,
      mode,
      providerId,
      startLogin,
    ],
  );

  const cancel = useCallback((): void => {
    if (state.kind !== "waiting" || state.profileId === null) return;
    cancelLogin.mutate({ providerId, profileId: state.profileId });
  }, [cancelLogin, providerId, state]);

  return {
    mode,
    state,
    busy: startLogin.isPending || awaitLogin.isPending,
    startPending: startLogin.isPending,
    start,
    cancel,
  };
}
