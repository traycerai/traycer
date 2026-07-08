import { useMutation } from "@tanstack/react-query";
import { useAuthService } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys";

export function useAuthOpenVerificationPageMutation() {
  const auth = useAuthService();
  return useMutation({
    mutationKey: authMutationKeys.openVerificationPage(),
    mutationFn: () => {
      auth.openVerificationPage();
      return Promise.resolve();
    },
  });
}
