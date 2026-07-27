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
});
