import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useAuthService } from "@/lib/host";
import { authMutationKeys, queryKeys } from "@/lib/query-keys";

const INVALID_TOKEN_MESSAGE = "Token is invalid or expired";

// No onError toast: paste failures stay inline-only per the sheet's spec.
export function useAuthApplyPastedToken(): UseMutationResult<
  true,
  Error,
  string
> {
  const auth = useAuthService();
  const queryClient = useQueryClient();
  return useMutation<true, Error, string>({
    mutationKey: authMutationKeys.applyPastedToken(),
    mutationFn: async (token) => {
      const applied = await auth.applyPastedToken(token);
      if (!applied) {
        throw new Error(INVALID_TOKEN_MESSAGE);
      }
      return true;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostBase(),
      });
    },
  });
}
