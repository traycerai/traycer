import { useCallback, useRef } from "react";
import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import {
  recordSignInRequestOnce,
  type SignInRecording,
} from "@traycer-clients/shared/host-client/provider-sign-in-request";
import { useAuthService } from "@/lib/host";

/** Records a sign-in request an unfinished await answered with. */
export type SignInRequestRecorder = (
  request: ProviderLoginSignInRequest,
  signal: AbortSignal,
) => Promise<SignInRecording>;

/**
 * The recording step of the shared sign-in await (`useProvidersAwaitLogin`
 * and its variants), so every caller records: the request goes to authn on
 * the person's own session, through the app's auth service, each operation
 * id at most once for the caller's life. The caller stays in its pending
 * state while it runs.
 */
export function useProviderSignInRecording(): SignInRequestRecorder {
  const auth = useAuthService();
  const recordedRef = useRef<Set<string>>(new Set());
  return useCallback(
    (
      request: ProviderLoginSignInRequest,
      signal: AbortSignal,
    ): Promise<SignInRecording> =>
      recordSignInRequestOnce(auth, recordedRef.current, request, signal),
    [auth],
  );
}
