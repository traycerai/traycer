import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import {
  profileCopyDraftStatusKey,
  profileCopyStatusKey,
  writeProfileCopyDraftOutcome,
  writeProfileCopyRetryOutcome,
} from "@/hooks/providers/profile-copy/profile-copy-cache";
import {
  ATTEMPT_ID,
  ATTEMPT_TWO_ID,
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  OPERATION_ID,
  profileCopyAttempt,
  recordedOutcome,
  SCOPED_HOST_ID,
  SOURCE_HOST_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import type {
  ProfileCopyDraftResponse,
  ProfileCopyOperationResponse,
  ProfileCopyOutcome,
} from "@/lib/profile-copy/profile-copy-model";

describe("writeProfileCopyDraftOutcome", () => {
  it("does not overwrite a newer cached revision", () => {
    const queryClient = createAppQueryClient();
    const newer = recordedOutcome({
      state: "signed-in",
      revision: 5,
    });
    const older = recordedOutcome({
      state: "verification-pending",
      revision: 3,
    });
    const key = profileCopyDraftStatusKey(newer);
    queryClient.setQueryData<ProfileCopyDraftResponse>(key, {
      result: "current",
      outcome: newer,
    });

    writeProfileCopyDraftOutcome(queryClient, older);

    expect(
      queryClient.getQueryData<ProfileCopyDraftResponse>(key)?.outcome.revision,
    ).toBe(5);
    expect(
      queryClient.getQueryData<ProfileCopyDraftResponse>(key)?.outcome.state,
    ).toBe("signed-in");
  });

  it("invalidates incoming on D and status on S from the attempt, never a scoped host", () => {
    const queryClient = createAppQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const outcome = recordedOutcome({
      state: "sign-in-required",
      revision: 2,
      attempt: profileCopyAttempt({
        sourceHostId: SOURCE_HOST_ID,
        destinationHostId: DEST_HOST_ID,
      }),
    });

    writeProfileCopyDraftOutcome(queryClient, outcome);

    const incomingKey = hostQueryKeys.methodScope(
      DEST_HOST_ID,
      "providers.profileCopy.incoming",
    );
    const statusKey = profileCopyStatusKey(SOURCE_HOST_ID, OPERATION_ID);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: incomingKey });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: statusKey });
    expect(
      invalidate.mock.calls.some((call) => {
        const queryKey = call[0]?.queryKey;
        return Array.isArray(queryKey) && queryKey.includes(SCOPED_HOST_ID);
      }),
    ).toBe(false);
  });

  it("builds draft and status keys from the attempt hosts", () => {
    const outcome = recordedOutcome({
      attempt: profileCopyAttempt({
        sourceHostId: SOURCE_HOST_ID,
        destinationHostId: DEST_HOST_ID,
      }),
    });
    const draftKey = profileCopyDraftStatusKey(outcome);
    const statusKey = profileCopyStatusKey(
      outcome.attempt.sourceHostId,
      outcome.attempt.operationId,
    );
    expect(draftKey).toEqual(
      hostQueryKeys.method<
        HostRpcRegistry,
        "providers.profileCopy.draftStatus"
      >(DEST_HOST_ID, "providers.profileCopy.draftStatus", {
        attempt: outcome.attempt,
      }),
    );
    expect(statusKey).toEqual(
      hostQueryKeys.method<HostRpcRegistry, "providers.profileCopy.status">(
        SOURCE_HOST_ID,
        "providers.profileCopy.status",
        { sourceHostId: SOURCE_HOST_ID, operationId: OPERATION_ID },
      ),
    );
    expect(draftKey).not.toContain(SCOPED_HOST_ID);
    expect(statusKey).not.toContain(SCOPED_HOST_ID);
  });
});

describe("writeProfileCopyRetryOutcome", () => {
  const ATTEMPT_C = "55555555-5555-4555-8555-555555555557";
  const requested = profileCopyAttempt({});
  const key = profileCopyStatusKey(SOURCE_HOST_ID, OPERATION_ID);

  const outcomeFor = (
    attemptId: string,
    revision: number,
    state: ProfileCopyOutcome["state"],
    destinationHostId: string,
  ): ProfileCopyOutcome =>
    recordedOutcome({
      attempt: profileCopyAttempt({ attemptId, destinationHostId }),
      revision,
      state,
    });

  function cacheWith(outcomes: ProfileCopyOutcome[]) {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData<ProfileCopyOperationResponse>(key, {
      sourceHostId: SOURCE_HOST_ID,
      operationId: OPERATION_ID,
      outcomes,
    });
    return queryClient;
  }
  const cached = (queryClient: QueryClient) =>
    queryClient.getQueryData<ProfileCopyOperationResponse>(key)?.outcomes;

  it("replaces the requested attempt's cached outcome with the replacement", () => {
    const old = outcomeFor(ATTEMPT_ID, 3, "quarantined", DEST_HOST_ID);
    const replacement = outcomeFor(
      ATTEMPT_TWO_ID,
      1,
      "preparing",
      DEST_HOST_ID,
    );
    const queryClient = cacheWith([old]);
    writeProfileCopyRetryOutcome(queryClient, requested, replacement);
    expect(cached(queryClient)).toEqual([replacement]);
  });

  it("keeps a same-attempt outcome that is already at a higher revision", () => {
    const newer = outcomeFor(ATTEMPT_ID, 5, "quarantined", DEST_HOST_ID);
    const queryClient = cacheWith([newer]);
    writeProfileCopyRetryOutcome(
      queryClient,
      requested,
      outcomeFor(ATTEMPT_ID, 3, "preparing", DEST_HOST_ID),
    );
    expect(cached(queryClient)).toEqual([newer]);
  });

  it("keeps a newer unrelated attempt's outcome", () => {
    const newerAttempt = outcomeFor(ATTEMPT_C, 7, "quarantined", DEST_HOST_ID);
    const queryClient = cacheWith([newerAttempt]);
    writeProfileCopyRetryOutcome(
      queryClient,
      requested,
      outcomeFor(ATTEMPT_TWO_ID, 1, "preparing", DEST_HOST_ID),
    );
    expect(cached(queryClient)).toEqual([newerAttempt]);
  });

  it("leaves other destinations' outcomes untouched and ignores another transfer's answer", () => {
    const mine = outcomeFor(ATTEMPT_ID, 3, "quarantined", DEST_HOST_ID);
    const elsewhere = outcomeFor(ATTEMPT_ID, 2, "signed-in", DEST_HOST_TWO_ID);
    const queryClient = cacheWith([mine, elsewhere]);
    writeProfileCopyRetryOutcome(
      queryClient,
      requested,
      outcomeFor(ATTEMPT_TWO_ID, 1, "preparing", DEST_HOST_ID),
    );
    // Only the requested destination's row was merged.
    expect(cached(queryClient)).toEqual([
      outcomeFor(ATTEMPT_TWO_ID, 1, "preparing", DEST_HOST_ID),
      elsewhere,
    ]);
    // An answer for a different destination does not touch this transfer.
    const untouched = cacheWith([mine]);
    writeProfileCopyRetryOutcome(
      untouched,
      requested,
      outcomeFor(ATTEMPT_TWO_ID, 1, "preparing", DEST_HOST_TWO_ID),
    );
    expect(cached(untouched)).toEqual([mine]);
  });

  it("creates nothing when there is no cached status", () => {
    const queryClient = createAppQueryClient();
    writeProfileCopyRetryOutcome(
      queryClient,
      requested,
      outcomeFor(ATTEMPT_TWO_ID, 1, "preparing", DEST_HOST_ID),
    );
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
});
