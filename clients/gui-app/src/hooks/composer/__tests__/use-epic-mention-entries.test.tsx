import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEpicMentionEntries } from "../use-epic-mention-entries";

const request = vi.fn();
const getActiveHostId = vi.fn(() => "host-test");

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    hostClient: {
      getActiveHostId,
      getRequestContextUserId: () => "user-test",
      onChange: () => () => undefined,
      request,
      requestWithSignal: request,
    },
  }),
}));

function wrapper(props: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useEpicMentionEntries", () => {
  afterEach(() => {
    cleanup();
    request.mockReset();
    getActiveHostId.mockReturnValue("host-test");
  });

  it("requests host-backed epic mention suggestions", async () => {
    request.mockResolvedValueOnce({
      entries: [
        {
          kind: "epic",
          id: "epic:epic-1",
          token: "epic:epic-1",
          epicId: "epic-1",
          label: "Login flow",
          description: "1 spec",
          status: "active",
          updatedAt: 123,
        },
      ],
    });

    const { result } = renderHook(
      () =>
        useEpicMentionEntries({
          requests: [
            {
              method: "epic.mentionEpics",
              params: { query: "login", limit: 8 },
            },
          ],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(request).toHaveBeenCalledWith(
      "epic.mentionEpics",
      { query: "login", limit: 8 },
      expect.any(AbortSignal),
    );
  });

  it("does not request suggestions without request descriptors", () => {
    renderHook(
      () =>
        useEpicMentionEntries({
          requests: [],
        }),
      { wrapper },
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("exposes a refetch that re-issues every epic.mention* query and returns a Promise", async () => {
    // Regression for the Artifacts refresh no-op: the top-bar button used to
    // call setStep(current), which the picker store early-returns from. The
    // button now awaits this refetch, so it must actually hit the host again.
    request.mockResolvedValue({
      entries: [
        {
          kind: "epic",
          id: "epic:epic-1",
          token: "epic:epic-1",
          epicId: "epic-1",
          label: "Login flow",
          description: "1 spec",
          status: "active",
          updatedAt: 123,
        },
      ],
    });

    const { result } = renderHook(
      () =>
        useEpicMentionEntries({
          requests: [
            {
              method: "epic.mentionEpics",
              params: { query: "login", limit: 8 },
            },
            {
              method: "epic.mentionSpecs",
              params: { query: "login", limit: 8 },
            },
          ],
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data.length).toBeGreaterThan(0));
    const callsAfterMount = request.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(2);

    const pending = result.current.refetch();
    expect(pending).toBeInstanceOf(Promise);
    await pending;

    await waitFor(() =>
      expect(request.mock.calls.length).toBeGreaterThan(callsAfterMount),
    );
    // Both underlying queries must be re-issued.
    const methodsAfterRefetch = request.mock.calls.map(
      (call: ReadonlyArray<unknown>) => call[0],
    );
    expect(
      methodsAfterRefetch.filter((m) => m === "epic.mentionEpics").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      methodsAfterRefetch.filter((m) => m === "epic.mentionSpecs").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
