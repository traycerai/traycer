import { useMutation } from "@tanstack/react-query";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useAuthService } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys";

export function useAuthSignInMutation() {
  const auth = useAuthService();
  return useMutation({
    mutationKey: authMutationKeys.signIn(),
    mutationFn: () => auth.signIn(),
    onError: (error) => toastFromAuthError(error, "Couldn't start sign-in."),
  });
}
