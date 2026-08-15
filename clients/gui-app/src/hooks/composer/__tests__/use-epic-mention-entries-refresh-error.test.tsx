import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

import { useEpicMentionEntries } from "@/hooks/composer/use-epic-mention-entries";

/**
 * The Artifacts refresh button reports a rejected round-trip.
 *
 * `refetch()` RESOLVES with a failed result rather than rejecting, so the
 * `Promise.all` behind the button settles either way and the spinner stops
 * identically on success and on failure. The picker has no inline surface to
 * say it in either - `useMentionItems` publishes `loadFailed: false` outright -
 * so a refresh that never reached the host would otherwise be presented as one
 * that simply found nothing new.
 */

const toastFromHostError = vi.fn();
const refetches = vi.hoisted(
  () => [] as Array<() => Promise<{ readonly error: HostRpcError | null }>>,
);

/** Mutable so a test can rebind the host mid-refresh without remounting. */
const readiness = vi.hoisted(() => ({ hostId: "host-1" }));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (error: HostRpcError, fallback: string) => {
    toastFromHostError(error, fallback);
  },
}));

vi.mock("@/lib/host", () => ({ useHostBinding: () => null }));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: readiness.hostId,
    requestContextUserId: "user-1",
    isReady: true,
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () =>
    refetches.map((refetch) => ({
      data: undefined,
      isLoading: false,
      isFetching: false,
      dataUpdatedAt: 0,
      error: null,
      refetch,
    })),
}));

function hostError(method: string): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: `This host does not support '${method}'.`,
    requestId: "req-1",
    method,
    fatalDetails: {
      code: "E_HOST_UNSUPPORTED",
      reason: `This host does not support '${method}'.`,
      incompatibleMethods: null,
      upgradeGuidance: { clientShouldUpgrade: false, hostShouldUpgrade: true },
    },
  });
}

function settling(
  ...errors: ReadonlyArray<HostRpcError | null>
): ReadonlyArray<() => Promise<{ readonly error: HostRpcError | null }>> {
  return errors.map((error) => () => Promise.resolve({ error }));
}

/**
 * A refetch whose failure the test controls, so the host can be rebound
 * BETWEEN the request being issued and its rejection settling. `issued` must
 * be awaited before rebinding - `refetch()` does not reach the returned
 * promise's executor synchronously - and `settle` THROWS if the request never
 * arrived, so a mis-ordered harness fails as itself rather than as a wrong
 * verdict.
 */
function pendingRefetch(): {
  readonly issued: Promise<void>;
  readonly settle: (error: HostRpcError | null) => void;
  readonly refetch: () => Promise<{ readonly error: HostRpcError | null }>;
} {
  let markIssued: () => void = () => undefined;
  let resolvePending:
    ((result: { readonly error: HostRpcError | null }) => void) | null = null;
  const issued = new Promise<void>((resolve) => {
    markIssued = resolve;
  });
  return {
    issued,
    settle: (error) => {
      if (resolvePending === null) {
        throw new Error("the refetch was never issued");
      }
      resolvePending({ error });
    },
    refetch: () =>
      new Promise<{ readonly error: HostRpcError | null }>((resolve) => {
        resolvePending = resolve;
        markIssued();
      }),
  };
}

function renderEntries() {
  // `@/hooks/host/use-reactive-host-readiness` and `@/hooks/host/use-host-queries`
  // are mocked wholesale above and ignore their arguments entirely, so `client`
  // is never actually read by anything this suite exercises - `null` is enough
  // (this file's whole point is the refetch/host-swap toast logic downstream
  // of those two hooks, not client resolution itself).
  return renderHook(() =>
    useEpicMentionEntries({ requests: [], client: null }),
  );
}

afterEach(() => {
  cleanup();
  toastFromHostError.mockReset();
  refetches.length = 0;
  readiness.hostId = "host-1";
});

describe("useEpicMentionEntries refresh reporting", () => {
  it("reports a rejected refresh", async () => {
    refetches.push(...settling(null, hostError("epic.mentionArtifacts")));

    const { result } = renderEntries();
    await result.current.refetch();

    expect(toastFromHostError).toHaveBeenCalledTimes(1);
    expect(toastFromHostError.mock.calls[0][1]).toBe(
      "Could not refresh artifacts",
    );
  });

  it("stays silent when every refresh succeeds", async () => {
    // The control. Without it, a hook that toasted unconditionally - or one
    // whose `refetch` rejected outright - would pass the case above.
    refetches.push(...settling(null, null));

    const { result } = renderEntries();
    await result.current.refetch();

    expect(toastFromHostError).not.toHaveBeenCalled();
  });

  it("reports once when several refreshes fail together", async () => {
    // A host that is down fails every query behind the list; the user asked
    // one question and gets one answer.
    refetches.push(
      ...settling(
        hostError("epic.mentionArtifacts"),
        hostError("epic.mentionTasks"),
      ),
    );

    const { result } = renderEntries();
    await result.current.refetch();

    expect(toastFromHostError).toHaveBeenCalledTimes(1);
  });

  it("suppresses the failure toast when the host was rebound mid-refresh", async () => {
    const pending = pendingRefetch();
    refetches.push(pending.refetch);

    const { result, rerender } = renderEntries();

    let refreshed: Promise<void> = Promise.resolve();
    act(() => {
      refreshed = result.current.refetch();
    });
    await act(async () => {
      await pending.issued;
    });

    // The composer rebinds to another host while the round-trip is still
    // open. Rerendering is what makes the effect re-sync `boundHostIdRef` -
    // the ref the settling `.then` compares against, not this render's
    // `readiness.hostId` closure.
    readiness.hostId = "host-2";
    rerender();

    await act(async () => {
      pending.settle(hostError("epic.mentionArtifacts"));
      await refreshed;
    });

    expect(toastFromHostError).not.toHaveBeenCalled();
  });

  it("still toasts a same-host failure", async () => {
    // The control for the case above: without the host-swap check, this
    // would also toast - the fix must not become "never toast".
    const pending = pendingRefetch();
    refetches.push(pending.refetch);

    const { result } = renderEntries();

    let refreshed: Promise<void> = Promise.resolve();
    act(() => {
      refreshed = result.current.refetch();
    });
    await act(async () => {
      await pending.issued;
    });

    await act(async () => {
      pending.settle(hostError("epic.mentionArtifacts"));
      await refreshed;
    });

    expect(toastFromHostError).toHaveBeenCalledTimes(1);
  });
});
