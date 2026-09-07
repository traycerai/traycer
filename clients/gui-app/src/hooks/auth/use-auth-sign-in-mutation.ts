import { useMutation } from "@tanstack/react-query";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useAuthService } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export function useAuthSignInMutation() {
  const auth = useAuthService();
  return useMutation({
    mutationKey: authMutationKeys.signIn(),
    mutationFn: () => auth.signIn(),
    // Only `sign_in_started` belongs to the gesture.
    onMutate: () => {
      Analytics.getInstance().track(AnalyticsEvent.SignInStarted, {
        source: "direct_ui",
      });
    },
    onError: (error) => {
      toastFromAuthError(error, "Couldn't start sign-in.");
    },
  });
}
