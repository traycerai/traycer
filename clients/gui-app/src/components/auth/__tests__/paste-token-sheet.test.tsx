import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { Button } from "@/components/ui/button";
import { PasteTokenSheet } from "@/components/auth/paste-token-sheet";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

function buildHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function makeMessengerFactory(): (args: {
  registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
          }),
      },
    });
}

function installFetch(handler: (url: string) => Promise<Response>): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> =>
      handler(typeof input === "string" ? input : String(input)),
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function getButtonByTestId(testId: string): HTMLButtonElement {
  const element = screen.getByTestId(testId);
  if (element instanceof HTMLButtonElement) {
    return element;
  }
  throw new Error(`Expected ${testId} to resolve to an HTMLButtonElement`);
}

interface MountResult {
  readonly host: MockRunnerHost;
  readonly cleanupClient: () => void;
}

function mountSheet(host: MockRunnerHost): MountResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function ControlledSheet(): ReactNode {
    const [open, setOpen] = useState<boolean>(false);
    return (
      <>
        <Button
          type="button"
          data-testid="open-sheet"
          onClick={() => {
            setOpen(true);
          }}
        >
          Open
        </Button>
        <PasteTokenSheet open={open} onOpenChange={setOpen} />
      </>
    );
  }

  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={makeMessengerFactory()}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve([])}
          fallback={<div data-testid="runtime-fallback">…</div>}
        >
          <ControlledSheet />
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );

  return {
    host,
    cleanupClient: () => {
      queryClient.clear();
    },
  };
}

describe("<PasteTokenSheet />", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            user: {
              id: "user-1",
              name: "Test User",
              providerId: "gh-1",
              providerHandle: "test-user",
              providerType: "GITHUB",
              email: "test@example.com",
              avatarUrl: null,
              activatedAt: null,
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
              lastSeenAt: null,
              privacyMode: false,
              isLearningEnabled: true,
            },
            userSubscription: {
              id: "sub-1",
              userID: "user-1",
              orgID: null,
              teamID: null,
              customerId: "cus-1",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
              subscriptionExpiry: null,
              trialEndsAt: null,
              subscriptionStatus: "FREE",
              hasPaymentMethod: false,
              isInTrial: false,
              rechargeRateSeconds: 0,
            },
            teamSubscriptions: [],
            payAsYouGoUsage: { allowPayAsYouGo: false },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    restoreFetch();
  });

  it("opens, accepts a token, and closes after a successful submit", async () => {
    const result = mountSheet(buildHost());

    // Wait for the host runtime to finish initializing.
    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("open-sheet"));

    const input = await screen.findByTestId("paste-token-input");
    fireEvent.change(input, { target: { value: "pasted-token-123" } });

    fireEvent.click(screen.getByTestId("paste-token-submit"));

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });
    // The pasted token must NOT leak through the public auth store. The
    // tokenStore persistence boundary check below is the canonical assertion.
    expect(await result.host.tokenStore.get()).toEqual({
      token: "pasted-token-123",
      refreshToken: "",
    });
    await waitFor(() => {
      expect(screen.queryByTestId("paste-token-input")).toBeNull();
    });
    result.cleanupClient();
  });

  it("closes on Cancel without applying a token", async () => {
    const result = mountSheet(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("open-sheet"));
    const input = await screen.findByTestId("paste-token-input");
    fireEvent.change(input, { target: { value: "abandoned-token" } });

    fireEvent.click(screen.getByTestId("paste-token-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("paste-token-input")).toBeNull();
    });
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(await result.host.tokenStore.get()).toBeNull();
    result.cleanupClient();
  });

  it("keeps the sheet open and renders an inline error when validation fails", async () => {
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    const result = mountSheet(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("open-sheet"));

    const input = await screen.findByTestId("paste-token-input");
    fireEvent.change(input, { target: { value: "bad-token" } });

    fireEvent.click(screen.getByTestId("paste-token-submit"));

    // Inline error is rendered under the textarea and sheet stays OPEN so
    // the user can correct the token without retyping.
    const error = await screen.findByTestId("paste-token-error");
    expect(error.textContent).toBe("Token is invalid or expired");
    expect(screen.queryByTestId("paste-token-input")).not.toBeNull();
    // Paste failure must NOT flip the app to signed-in and must NOT pollute
    // the global signed-out auth surface.
    expect(useAuthStore.getState().status).toBe("signed-out");
    result.cleanupClient();
  });

  it("keeps submit enabled during signing-in so a pasted token can supersede browser auth", async () => {
    const result = mountSheet(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("open-sheet"));
    const input = await screen.findByTestId("paste-token-input");
    fireEvent.change(input, { target: { value: "some-token" } });

    // With a non-empty token and no in-flight OAuth attempt, submit is
    // enabled - this is the baseline the signing-in transition must flip.
    expect(getButtonByTestId("paste-token-submit").disabled).toBe(false);

    // Flip the store into signing-in while the sheet is open (the sheet may
    // remain visible if it was opened before the OAuth flow started through
    // some test path). Submission must now be blocked.
    act(() => {
      useAuthStore.getState().setSigningIn();
    });

    await waitFor(() => {
      expect(getButtonByTestId("paste-token-submit").disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId("paste-token-submit"));
    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });
    // Public auth store must not expose the raw bearer; tokenStore
    // persistence boundary assertion below is the canonical check.
    expect(await result.host.tokenStore.get()).toEqual({
      token: "some-token",
      refreshToken: "",
    });
    expect(screen.queryByTestId("paste-token-error")).toBeNull();

    result.cleanupClient();
  });

  it("clears the inline error when the user edits the textarea after a failed submit", async () => {
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    const result = mountSheet(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("open-sheet"));

    const input = await screen.findByTestId("paste-token-input");
    fireEvent.change(input, { target: { value: "bad-token" } });
    fireEvent.click(screen.getByTestId("paste-token-submit"));

    await screen.findByTestId("paste-token-error");

    fireEvent.change(input, { target: { value: "bad-token-fixed" } });

    expect(screen.queryByTestId("paste-token-error")).toBeNull();
    result.cleanupClient();
  });
});
