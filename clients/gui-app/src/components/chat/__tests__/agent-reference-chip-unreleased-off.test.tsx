/**
 * The build without bots (`unreleased-features.ts`): an id-shaped token that
 * names no agent of the open epic is the id as written. There are no task
 * chips, so nothing is read to title one — asserted through the real markdown
 * path, with a signed-in account and a host that would answer the read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { useAuthStore } from "@/stores/auth/auth-store";

const USER_ID = "user-test";
const TASK_ID = "6f1c2a9e-4b7d-4e21-9c3a-1d2e3f4a5b6c";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const mocks = vi.hoisted(() => {
  const request =
    vi.fn<(method: string, params: unknown) => Promise<unknown>>();
  return {
    request,
    client: {
      getActiveHostId: () => "host-test",
      getRequestContextUserId: () => USER_ID,
      onChange: () => () => undefined,
      request,
      requestWithSignal: request,
    },
  };
});

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useOptionalHostClient: () => mocks.client,
}));

let queryClient: QueryClient;

function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.request.mockResolvedValue({ tasks: {} });
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: USER_ID, userName: "U", email: "u@example.com" },
      { userId: USER_ID, username: "U" },
      [],
    );
});

afterEach(() => {
  cleanup();
  mocks.request.mockReset();
  useAuthStore.getState().setSignedOut();
});

describe("a task id in a message without bots", () => {
  it("stays the id as written and reads no task context", async () => {
    const { container } = render(
      <TextSegment
        findUnitId={null}
        markdown={`In flight: ${TASK_ID} today.`}
        isStreaming={false}
        nextStepActions={null}
      />,
      { wrapper: Providers },
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain(TASK_ID);
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
