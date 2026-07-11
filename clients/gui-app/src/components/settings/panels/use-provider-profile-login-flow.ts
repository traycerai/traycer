import { useCallback, useRef, useState } from "react";
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
  | { readonly kind: "starting"; readonly cancelRequested: boolean }
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
      readonly existingProfileId: string | null;
    }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" };

interface UseProviderProfileLoginFlowInput {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly providerId: ProviderCliState["providerId"];
  /** Reauth mode always targets this existing profile - the flow awaits THIS
   *  id regardless of what `startLogin`'s response echoes. Create mode has no
   *  profile yet, so it awaits whatever id `startLogin` mints. */
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
    readonly label: string | null;
    readonly shareSkillsAndPlugins: boolean;
  }) => void;
  readonly cancel: () => void;
}

/**
 * Shared OAuth login-flow state machine (multi-profile UX overhaul, S10):
 * owns the start -> starting -> waiting -> identity | failed transitions,
 * including cancellation before `startLogin` returns, and the three provider
 * login mutations shared by the add-profile and inline reauth panels.
 *
 * Callers render their own UI per `state.kind`; profile naming/coloring stays
 * outside this machine. Callers remain conditionally mounted so closing
 * discards the flow state and late mutation callbacks cannot leak into a
 * later attempt.
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
  const [state, setState] = useState<ProviderProfileLoginFlowState>({
    kind: "start",
  });
  const cancelRequestedRef = useRef(false);
  const cancelledProfileIdRef = useRef<string | null>(null);

  const cancelProfile = useCallback(
    (profileId: string): void => {
      if (cancelledProfileIdRef.current === profileId) return;
      cancelledProfileIdRef.current = profileId;
      cancelLogin.mutate({ providerId, profileId });
    },
    [cancelLogin, providerId],
  );

  const finishCancellation = useCallback(
    (profileId: string | null): void => {
      if (profileId !== null) cancelProfile(profileId);
      setState({ kind: "cancelled" });
    },
    [cancelProfile],
  );

  const fail = useCallback(
    (message: string): void => {
      setState({ kind: "failed", message });
      onFailed(message);
    },
    [onFailed],
  );

  const start = useCallback(
    (options: {
      readonly label: string | null;
      readonly shareSkillsAndPlugins: boolean;
    }): void => {
      if (
        state.kind === "starting" ||
        state.kind === "waiting" ||
        startLogin.isPending ||
        awaitLogin.isPending
      ) {
        return;
      }
      cancelRequestedRef.current = false;
      cancelledProfileIdRef.current = null;
      setState({ kind: "starting", cancelRequested: false });
      startLogin.mutate(
        {
          providerId,
          profileId: existingProfileId,
          createProfile:
            mode === "create"
              ? {
                  label: options.label ?? "",
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
            if (cancelRequestedRef.current) {
              finishCancellation(nextProfileId);
              return;
            }
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
                  const existingProfileId = result.existingProfileId ?? null;
                  const resolvedProfileId = existingProfileId ?? nextProfileId;
                  const profile =
                    profiles.find(
                      (candidate) => candidate.profileId === resolvedProfileId,
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
                    existingProfileId,
                  });
                },
                onError: () => fail(failureMessages.notFinished),
              },
            );
          },
          onError: () => {
            if (cancelRequestedRef.current) {
              finishCancellation(null);
              return;
            }
            fail(failureMessages.notStarted);
          },
        },
      );
    },
    [
      awaitLogin,
      existingProfileId,
      fail,
      failureMessages,
      finishCancellation,
      mode,
      providerId,
      state.kind,
      startLogin,
    ],
  );

  const cancel = useCallback((): void => {
    cancelRequestedRef.current = true;
    if (state.kind === "starting") {
      if (mode === "reauth" && existingProfileId !== null) {
        finishCancellation(existingProfileId);
        return;
      }
      setState({ kind: "starting", cancelRequested: true });
      return;
    }
    if (state.kind === "waiting" && state.profileId !== null) {
      finishCancellation(state.profileId);
      return;
    }
    if (
      mode === "reauth" &&
      state.kind === "start" &&
      existingProfileId !== null
    ) {
      finishCancellation(existingProfileId);
    }
  }, [existingProfileId, finishCancellation, mode, state]);

  return {
    mode,
    state,
    busy:
      state.kind === "starting" || startLogin.isPending || awaitLogin.isPending,
    startPending: state.kind === "starting" || startLogin.isPending,
    start,
    cancel,
  };
}
