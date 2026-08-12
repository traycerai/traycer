import { cleanup, renderHook } from "@testing-library/react";
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

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (error: HostRpcError, fallback: string) => {
    toastFromHostError(error, fallback);
  },
}));

vi.mock("@/lib/host", () => ({ useHostBinding: () => null }));

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

function renderEntries() {
  return renderHook(() => useEpicMentionEntries({ requests: [] }));
}

afterEach(() => {
  cleanup();
  toastFromHostError.mockReset();
  refetches.length = 0;
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
});
