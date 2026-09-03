import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";

const mocks = vi.hoisted(() => ({
  requestWithSignal: vi.fn((method: string) => {
    if (method !== "resources.listLocalServers") {
      return Promise.reject(new Error(`unexpected method ${method}`));
    }
    return Promise.resolve({
      servers: [{ port: 5173, processName: "vite", pid: 1 }],
    });
  }),
}));

// A real client would carry a transport. This one carries exactly what the
// query calls, so "the device was asked" is an observation and not a mock's
// opinion about `enabled`.
const CLIENT = {
  requestWithSignal: mocks.requestWithSignal,
  request: mocks.requestWithSignal,
  requestWithResponseTimeout: mocks.requestWithSignal,
  getActiveHostId: () => "host-a",
};

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => CLIENT,
  useHostDirectoryEntryForHostId: () => ({ kind: "local" }),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ canExecute: true, hostId: "host-a" }),
}));

import { BrowserStartPage } from "../browser-start-page";

const SCOPE: HostResourceScope = { kind: "independent" };

let queryClient = new QueryClient();

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function startPage(visible: boolean): ReactNode {
  return (
    <BrowserStartPage
      scope={SCOPE}
      hostId="host-a"
      browserRunsOnHost
      visible={visible}
      onNavigate={() => undefined}
    />
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.requestWithSignal.mockClear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

/**
 * The start page POLLS, and every surface that hosts it keeps its tabs mounted
 * while they are inactive, while the panel is collapsed, and while the pane is
 * backgrounded. A blank tab is also what the Start Page panel opens by default,
 * so a retained one is the common case rather than a corner.
 */
describe("<BrowserStartPage /> visibility gate", () => {
  it("asks the device for nothing while the tile is off screen", async () => {
    render(<Wrapper>{startPage(false)}</Wrapper>);

    // Give the query every chance to run before concluding it did not.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.requestWithSignal).not.toHaveBeenCalled();
    expect(screen.queryByText("vite")).toBeNull();
  });

  it("asks, and shows what it finds, once the tile is on screen", async () => {
    const view = render(<Wrapper>{startPage(false)}</Wrapper>);
    expect(mocks.requestWithSignal).not.toHaveBeenCalled();

    view.rerender(<Wrapper>{startPage(true)}</Wrapper>);

    await waitFor(() => {
      expect(mocks.requestWithSignal).toHaveBeenCalled();
    });
    expect(await screen.findByText("vite")).toBeTruthy();
  });
});
