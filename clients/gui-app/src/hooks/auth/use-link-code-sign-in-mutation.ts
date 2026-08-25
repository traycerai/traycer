import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { LinkLoginSignInResult } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys";

/**
 * Redeems a link-login code (scanned or typed) into a full sign-in. The
 * result kinds are returned rather than thrown — the sign-in surface renders
 * them inline next to the code field, so a wrong code is an ordinary state
 * with the field still focused, not a toast.
 */
export function useLinkCodeSignInMutation(): UseMutationResult<
  LinkLoginSignInResult,
  Error,
  string
> {
  const auth = useAuthService();
  return useMutation({
    mutationKey: authMutationKeys.signInWithLinkCode(),
    mutationFn: (code: string) => auth.signInWithLinkCode(code),
  });
}
