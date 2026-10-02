import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import {
  profileCopyDraftStatusKey,
  profileCopyStatusKey,
  writeProfileCopyDraftOutcome,
} from "@/hooks/providers/profile-copy/profile-copy-cache";
import {
  DEST_HOST_ID,
  OPERATION_ID,
  profileCopyAttempt,
  recordedOutcome,
  SCOPED_HOST_ID,
  SOURCE_HOST_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import type { ProfileCopyDraftResponse } from "@/lib/profile-copy/profile-copy-model";

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
