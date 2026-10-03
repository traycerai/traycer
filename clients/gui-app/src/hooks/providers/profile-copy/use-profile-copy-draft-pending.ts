import { useIsMutating } from "@tanstack/react-query";
import {
  profileCopyAttemptSchema,
  type ProfileCopyAttempt,
} from "@traycer/protocol/host/profile-copy-schemas";
import { profileCopyTransferKey } from "@/lib/profile-copy/profile-copy-model";

const DRAFT_METHODS = new Set([
  "providers.profileCopy.verify",
  "providers.profileCopy.confirmVerification",
  "providers.profileCopy.confirmIdentity",
  "providers.profileCopy.setPreference",
  "providers.profileCopy.cancelDraft",
  "providers.profileCopy.login.start",
  "providers.profileCopy.login.await",
  "providers.profileCopy.login.touch",
  "providers.profileCopy.login.submitCode",
  "providers.profileCopy.login.cancel",
]);

/** Draft keys name the destination; the request also captures its source. */
export function profileCopyDraftMutationAttempt(
  key: readonly unknown[] | undefined,
  variables: unknown,
): ProfileCopyAttempt | null {
  if (
    typeof key?.[0] !== "string" ||
    !DRAFT_METHODS.has(key[0]) ||
    typeof variables !== "object" ||
    variables === null ||
    !("attempt" in variables)
  ) {
    return null;
  }
  const parsed = profileCopyAttemptSchema.safeParse(variables.attempt);
  if (
    !parsed.success ||
    key[1] !== parsed.data.destinationHostId ||
    key[2] !== parsed.data.attemptId
  ) {
    return null;
  }
  return parsed.data;
}

/** Keep this operation's draft mounted even if polling replaces its receipt. */
export function useProfileCopyDraftPending(
  sourceHostId: string,
  operationId: string,
  destinationHostId: string,
): boolean {
  return (
    useIsMutating({
      predicate: (mutation) => {
        const attempt = profileCopyDraftMutationAttempt(
          mutation.options.mutationKey,
          mutation.state.variables,
        );
        return (
          attempt !== null &&
          attempt.sourceHostId === sourceHostId &&
          attempt.operationId === operationId &&
          attempt.destinationHostId === destinationHostId
        );
      },
    }) > 0
  );
}

function isResolveForAttempt(
  variables: object,
  attempt: ProfileCopyAttempt,
): boolean {
  return (
    "sourceHostId" in variables &&
    variables.sourceHostId === attempt.sourceHostId &&
    "operationId" in variables &&
    variables.operationId === attempt.operationId &&
    "destinationHostId" in variables &&
    variables.destinationHostId === attempt.destinationHostId &&
    "providerId" in variables &&
    variables.providerId === attempt.providerId &&
    "sourceProfileId" in variables &&
    variables.sourceProfileId === attempt.sourceProfileId
  );
}

/** Source actions compete with this transfer's destination draft writes. */
export function useProfileCopySourcePending(
  attempt: ProfileCopyAttempt,
): boolean {
  return (
    useIsMutating({
      predicate: (mutation) => {
        const key = mutation.options.mutationKey;
        const variables = mutation.state.variables;
        if (
          key?.[1] !== attempt.sourceHostId ||
          typeof variables !== "object" ||
          variables === null
        )
          return false;
        if (
          key[0] === "providers.profileCopy.retry" &&
          "attempt" in variables
        ) {
          const requested = profileCopyAttemptSchema.safeParse(
            variables.attempt,
          );
          return (
            requested.success &&
            key[2] === attempt.operationId &&
            profileCopyTransferKey(requested.data) ===
              profileCopyTransferKey(attempt)
          );
        }
        return (
          key[0] === "providers.profileCopy.sync.resolve" &&
          isResolveForAttempt(variables, attempt)
        );
      },
    }) > 0
  );
}
