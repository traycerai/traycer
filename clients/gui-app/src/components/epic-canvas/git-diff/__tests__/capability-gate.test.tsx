import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GitGetCapabilitiesResponse } from "@traycer/protocol/host";
import { CapabilityGate } from "../capability-gate";

const request = vi.fn();
const mockHostClient = {
  request,
  requestWithSignal: request,
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: unknown) => ({
    hostId: "test-host",
    isReady: client !== null,
  }),
}));

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function childrenRegion() {
  return <section aria-label="Test children">Test children</section>;
}

describe("CapabilityGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders skeleton while pending", () => {
    mockHostClient.request.mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves
        }),
    );

    const wrapper = makeWrapper();
    const { unmount } = render(
      <CapabilityGate hostId="test-host" runningDir="/test/dir">
        {childrenRegion()}
      </CapabilityGate>,
      { wrapper },
    );

    expect(screen.queryByRole("region", { name: "Test children" })).toBe(null);
    unmount();
  });

  it("renders children when available: true", async () => {
    const response: GitGetCapabilitiesResponse = {
      available: true,
      gitVersion: "2.42.0",
      reason: null,
    };

    mockHostClient.request.mockResolvedValue(response);

    const wrapper = makeWrapper();
    render(
      <CapabilityGate hostId="test-host" runningDir="/test/dir">
        {childrenRegion()}
      </CapabilityGate>,
      { wrapper },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("region", { name: "Test children" }),
      ).toBeDefined();
    });
  });

  it("renders HostUnsupported when available: false", async () => {
    const response: GitGetCapabilitiesResponse = {
      available: false,
      gitVersion: null,
      reason: "git not found in PATH",
    };

    mockHostClient.request.mockResolvedValue(response);

    const wrapper = makeWrapper();
    render(
      <CapabilityGate hostId="test-host" runningDir="/test/dir">
        {childrenRegion()}
      </CapabilityGate>,
      { wrapper },
    );

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(
        within(alert).getByRole("heading", { name: "Git panel unavailable" }),
      ).toBeDefined();
      expect(within(alert).getByText("git not found in PATH")).toBeDefined();
    });
    expect(screen.queryByRole("region", { name: "Test children" })).toBe(null);
  });

  it("renders HostUnsupported with custom reason when available: false", async () => {
    const response: GitGetCapabilitiesResponse = {
      available: false,
      gitVersion: null,
      reason: "repo exceeds 5M files (refused mode)",
      repoMode: "refused",
    };

    mockHostClient.request.mockResolvedValue(response);

    const wrapper = makeWrapper();
    render(
      <CapabilityGate hostId="test-host" runningDir="/test/dir">
        {childrenRegion()}
      </CapabilityGate>,
      { wrapper },
    );

    await waitFor(() => {
      expect(
        within(screen.getByRole("alert")).getByText(
          "repo exceeds 5M files (refused mode)",
        ),
      ).toBeDefined();
    });
  });

  it("renders HostUnsupported with MethodNotFound error message", async () => {
    const error = new HostRpcError({
      code: "RPC_ERROR",
      message: "Method not found",
      requestId: "req-123",
      method: "git.getCapabilities",
      fatalDetails: null,
    });

    mockHostClient.request.mockRejectedValue(error);

    const wrapper = makeWrapper();
    render(
      <CapabilityGate hostId="test-host" runningDir="/test/dir">
        {childrenRegion()}
      </CapabilityGate>,
      { wrapper },
    );

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(
        within(alert).getByRole("heading", { name: "Git panel unavailable" }),
      ).toBeDefined();
      expect(
        within(alert).getByText("host too old (no git.* methods)"),
      ).toBeDefined();
    });
    expect(screen.queryByRole("region", { name: "Test children" })).toBe(null);
  });

  it("treats RPC_ERROR without 'method' in message as regular error", async () => {
    const error = new HostRpcError({
      code: "RPC_ERROR",
      message: "Internal server error",
      requestId: "req-123",
      method: "git.getCapabilities",
      fatalDetails: null,
    });

    mockHostClient.request.mockRejectedValue(error);

    const wrapper = makeWrapper();
    render(
      <CapabilityGate hostId="test-host" runningDir="/test/dir">
        {childrenRegion()}
      </CapabilityGate>,
      { wrapper },
    );

    // Query will be in error state, component still renders unsupported message
    await waitFor(
      () => {
        expect(
          within(screen.getByRole("alert")).getByRole("heading", {
            name: "Git panel unavailable",
          }),
        ).toBeDefined();
      },
      { timeout: 1500 },
    );
  });

  it("does not fetch when hostId is null", () => {
    const wrapper = makeWrapper();
    render(
      <CapabilityGate hostId={null} runningDir="/test/dir">
        {childrenRegion()}
      </CapabilityGate>,
      { wrapper },
    );

    expect(mockHostClient.request).not.toHaveBeenCalled();
  });
});
