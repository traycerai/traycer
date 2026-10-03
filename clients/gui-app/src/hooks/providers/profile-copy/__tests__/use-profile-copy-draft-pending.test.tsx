import type { ReactNode } from "react";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProfileCopyAttempt } from "@traycer/protocol/host/profile-copy-schemas";
import { useProfileSyncPending } from "@/hooks/providers/use-profile-sync";
import { profileCopyMutationKeys } from "@/lib/query-keys";
import {
  ATTEMPT_ID,
  ATTEMPT_TWO_ID,
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  SOURCE_HOST_ID,
  profileCopyAttempt,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import {
  profileCopyDraftMutationAttempt,
  useProfileCopyDraftPending,
} from "../use-profile-copy-draft-pending";

// The ten destination-served draft and sign-in verbs a source dialog must
// stay open for. Each key names the destination and the attempt it acts on.
const DRAFT_KEYS = [
  ["cancelDraft", profileCopyMutationKeys.cancelDraft],
  ["setPreference", profileCopyMutationKeys.setPreference],
  ["verify", profileCopyMutationKeys.verify],
  ["confirmVerification", profileCopyMutationKeys.confirmVerification],
  ["confirmIdentity", profileCopyMutationKeys.confirmIdentity],
  ["login.start", profileCopyMutationKeys.loginStart],
  ["login.await", profileCopyMutationKeys.loginAwait],
  ["login.touch", profileCopyMutationKeys.loginTouch],
  ["login.submitCode", profileCopyMutationKeys.loginSubmitCode],
  ["login.cancel", profileCopyMutationKeys.loginCancel],
] as const;

const OTHER_SOURCE = "other-source-host";

interface DraftVariables {
  readonly attempt: ProfileCopyAttempt;
  readonly expectedRevision: number;
}

function variablesFor(attempt: ProfileCopyAttempt): DraftVariables {
  return { attempt, expectedRevision: 1 };
}

describe("profileCopyDraftMutationAttempt", () => {
  it.each(DRAFT_KEYS)(
    "recognizes %s and returns the attempt its key and variables agree on",
    (_name, keyFor) => {
      const attempt = profileCopyAttempt({});
      expect(
        profileCopyDraftMutationAttempt(
          keyFor(attempt.destinationHostId, attempt.attemptId),
          variablesFor(attempt),
        ),
      ).toEqual(attempt);
    },
  );

  it.each(DRAFT_KEYS)(
    "refuses %s when its key names another destination or another attempt",
    (_name, keyFor) => {
      const attempt = profileCopyAttempt({});
      expect(
        profileCopyDraftMutationAttempt(
          keyFor(DEST_HOST_TWO_ID, attempt.attemptId),
          variablesFor(attempt),
        ),
      ).toBeNull();
      expect(
        profileCopyDraftMutationAttempt(
          keyFor(attempt.destinationHostId, ATTEMPT_TWO_ID),
          variablesFor(attempt),
        ),
      ).toBeNull();
    },
  );

  it("refuses variables that carry no valid attempt, and keys of other verbs", () => {
    const attempt = profileCopyAttempt({});
    const key = profileCopyMutationKeys.verify(
      attempt.destinationHostId,
      attempt.attemptId,
    );
    expect(profileCopyDraftMutationAttempt(key, {})).toBeNull();
    expect(
      profileCopyDraftMutationAttempt(key, { attempt: { attemptId: "x" } }),
    ).toBeNull();
    expect(
      profileCopyDraftMutationAttempt(
        profileCopyMutationKeys.retry(SOURCE_HOST_ID, "op"),
        variablesFor(attempt),
      ),
    ).toBeNull();
    expect(
      profileCopyDraftMutationAttempt(undefined, variablesFor(attempt)),
    ).toBeNull();
  });
});

describe("useProfileSyncPending with draft and sign-in requests", () => {
  afterEach(cleanup);

  function setup(sourceHostId: string) {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useProfileSyncPending(sourceHostId), {
      wrapper,
    });
    const releases: Array<() => void> = [];
    const hold = async (
      key: readonly string[],
      variables: DraftVariables,
    ): Promise<void> => {
      const promise = new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      const observer = new MutationObserver<void, Error, DraftVariables>(
        queryClient,
        {
          mutationKey: key,
          mutationFn: () => promise,
        },
      );
      await act(async () => {
        void observer.mutate(variables).catch(() => undefined);
        await Promise.resolve();
      });
    };
    const release = async (): Promise<void> => {
      await act(async () => {
        for (const resolve of releases) resolve();
        await Promise.resolve();
      });
    };
    return { view, hold, release };
  }

  it.each(DRAFT_KEYS)(
    "holds the attempt's own source while %s is in flight, and lets go when it settles",
    async (_name, keyFor) => {
      const attempt = profileCopyAttempt({});
      const { view, hold, release } = setup(attempt.sourceHostId);
      try {
        await hold(
          keyFor(attempt.destinationHostId, attempt.attemptId),
          variablesFor(attempt),
        );
        await waitFor(() => expect(view.result.current).toBe(true));
      } finally {
        await release();
      }
      await waitFor(() => expect(view.result.current).toBe(false));
    },
  );

  it.each(DRAFT_KEYS)(
    "does not hold an unrelated source, or a %s whose key disagrees with its attempt",
    async (_name, keyFor) => {
      const attempt = profileCopyAttempt({});
      const unrelated = setup(OTHER_SOURCE);
      const mismatchedDestination = setup(attempt.sourceHostId);
      const mismatchedAttempt = setup(attempt.sourceHostId);
      try {
        await unrelated.hold(
          keyFor(attempt.destinationHostId, attempt.attemptId),
          variablesFor(attempt),
        );
        await mismatchedDestination.hold(
          keyFor(DEST_HOST_TWO_ID, attempt.attemptId),
          variablesFor(attempt),
        );
        await mismatchedAttempt.hold(
          keyFor(attempt.destinationHostId, ATTEMPT_TWO_ID),
          variablesFor(attempt),
        );
        expect(unrelated.view.result.current).toBe(false);
        expect(mismatchedDestination.view.result.current).toBe(false);
        expect(mismatchedAttempt.view.result.current).toBe(false);
      } finally {
        await unrelated.release();
        await mismatchedDestination.release();
        await mismatchedAttempt.release();
      }
      // Sanity: the fixtures differ from the base attempt.
      expect(ATTEMPT_TWO_ID).not.toBe(ATTEMPT_ID);
      expect(DEST_HOST_TWO_ID).not.toBe(DEST_HOST_ID);
    },
  );
});

describe("useProfileCopyDraftPending", () => {
  afterEach(cleanup);

  it.each(DRAFT_KEYS)(
    "follows the operation tuple while %s is in flight, even when polling replaces the receipt",
    async (_name, keyFor) => {
      const attempt = profileCopyAttempt({});
      const queryClient = new QueryClient();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observer = new MutationObserver<void, Error, DraftVariables>(
        queryClient,
        {
          mutationKey: keyFor(attempt.destinationHostId, attempt.attemptId),
          mutationFn: () => promise,
        },
      );
      const tuple = (source: string, operation: string, destination: string) =>
        renderHook(
          () => useProfileCopyDraftPending(source, operation, destination),
          { wrapper },
        );
      const own = tuple(
        attempt.sourceHostId,
        attempt.operationId,
        attempt.destinationHostId,
      );
      // A later receipt for the same operation is a different attempt id; the
      // tuple, not the receipt, is what keeps the draft mounted.
      const afterPolling = tuple(
        attempt.sourceHostId,
        attempt.operationId,
        attempt.destinationHostId,
      );
      const otherOperation = tuple(
        attempt.sourceHostId,
        "00000000-0000-4000-8000-0000000000ff",
        attempt.destinationHostId,
      );
      const otherSource = tuple(
        OTHER_SOURCE,
        attempt.operationId,
        attempt.destinationHostId,
      );
      const otherDestination = tuple(
        attempt.sourceHostId,
        attempt.operationId,
        DEST_HOST_TWO_ID,
      );
      try {
        await act(async () => {
          void observer.mutate(variablesFor(attempt)).catch(() => undefined);
          await Promise.resolve();
        });
        await waitFor(() => expect(own.result.current).toBe(true));
        expect(afterPolling.result.current).toBe(true);
        expect(otherOperation.result.current).toBe(false);
        expect(otherSource.result.current).toBe(false);
        expect(otherDestination.result.current).toBe(false);
      } finally {
        await act(async () => {
          release();
          await Promise.resolve();
        });
      }
      await waitFor(() => expect(own.result.current).toBe(false));
    },
  );
});
