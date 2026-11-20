import { useCallback, useRef } from "react";
import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import {
  recordSignInRequestOnce,
  type SignInRecording,
} from "@traycer-clients/shared/host-client/provider-sign-in-request";
import { useAuthService } from "@/lib/host";

export type SignInRequestRecorder = (
  request: ProviderLoginSignInRequest,
  signal: AbortSignal,
) => Promise<SignInRecording>;

/** Each operation id at most once for the caller's life; the caller stays pending meanwhile. */
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
