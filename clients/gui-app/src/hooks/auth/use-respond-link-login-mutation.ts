import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { useAuthService } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys";

export interface RespondLinkLoginInput {
  readonly code: string;
  readonly approve: boolean;
}

export type RespondLinkLoginOutcome =
  "ok" | "already-decided" | "gone" | "failed";

/**
 * The Link-a-phone panel's approve/reject decision on a claimed code.
 * Outcomes are returned rather than thrown — the panel reconciles
 * `already-decided`/`gone` against its own state machine inline.
 */
export function useRespondLinkLoginMutation(): UseMutationResult<
  RespondLinkLoginOutcome,
  Error,
  RespondLinkLoginInput
> {
  const auth = useAuthService();
  return useMutation({
    mutationKey: authMutationKeys.respondLinkLogin(),
    mutationFn: async (input: RespondLinkLoginInput) => {
      const result = await auth.respondLinkLogin(input.code, input.approve);
      if (result.kind === "ok") {
        return "ok";
      }
      if (result.kind === "already-decided") {
        return "already-decided";
      }
      if (result.kind === "gone") {
        return "gone";
      }
      return "failed";
    },
  });
}
