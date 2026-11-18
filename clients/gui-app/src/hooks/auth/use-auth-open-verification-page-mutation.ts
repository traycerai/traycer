import { useMutation } from "@tanstack/react-query";
import { useAuthService } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export function useAuthOpenVerificationPageMutation() {
  const auth = useAuthService();
  return useMutation({
    mutationKey: authMutationKeys.openVerificationPage(),
    onMutate: () => {
      Analytics.getInstance().track(AnalyticsEvent.SignInApprovalOpened, {
        source: "direct_ui",
      });
    },
    mutationFn: () => {
      auth.openVerificationPage();
      return Promise.resolve();
    },
  });
}
