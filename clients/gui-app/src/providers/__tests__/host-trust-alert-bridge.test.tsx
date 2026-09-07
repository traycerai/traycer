import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostTrustAlertBridge } from "@/providers/host-trust-alert-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const toast = vi.hoisted(() => ({
  warning: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({ toast }));

interface TrustEmitters {
  readonly mismatch: (entry: {
    readonly hostId: string;
    readonly pinLocation: string;
  }) => void;
  readonly pending: (entry: {
    readonly hostname: string;
    readonly error: string;
  }) => void;
}

/**
 * The desktop platform bridge, with only the two subscriptions this reader
 * probes for. Anything else on it is irrelevant to whether the refusal
 * reaches a person.
 */
function renderWithTrustBridge(): TrustEmitters {
  const handlers: {
    mismatch: null | ((entry: { hostId: string; pinLocation: string }) => void);
    pending: null | ((entry: { hostname: string; error: string }) => void);
  } = { mismatch: null, pending: null };
  const runnerHost = Object.assign(
    new MockRunnerHost({
      signInUrl: "https://example.com",
      authnBaseUrl: "https://auth.example.com",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    }),
    {
      platform: {
        hostKeyPin: {
          onMismatch: (
            handler: (entry: { hostId: string; pinLocation: string }) => void,
          ) => {
            handlers.mismatch = handler;
            return {
              dispose: () => {
                handlers.mismatch = null;
              },
            };
          },
        },
        certTrust: {
          onPending: (
            handler: (entry: { hostname: string; error: string }) => void,
          ) => {
            handlers.pending = handler;
            return {
              dispose: () => {
                handlers.pending = null;
              },
            };
          },
        },
      },
    },
  );
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <HostTrustAlertBridge />
    </RunnerHostProvider>,
  );
  return {
    mismatch: (entry) => {
      if (handlers.mismatch === null) throw new Error("no mismatch reader");
      act(() => handlers.mismatch?.(entry));
    },
    pending: (entry) => {
      if (handlers.pending === null) throw new Error("no pending reader");
      act(() => handlers.pending?.(entry));
    },
  };
}

describe("<HostTrustAlertBridge />", () => {
  afterEach(() => {
    cleanup();
    toast.warning.mockClear();
  });

  it("names the host and the recovery when a host key no longer matches its pin", () => {
    renderWithTrustBridge().mismatch({
      hostId: "host-there",
      pinLocation: "/Users/me/pins.json",
    });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [message] = toast.warning.mock.calls[0] ?? [];
    expect(message).toContain("host-there");
    expect(message).toContain("/Users/me/pins.json");
  });

  it("names the server and the recovery for an untrusted certificate", () => {
    renderWithTrustBridge().pending({
      hostname: "proxy.internal",
      error: "ERR_CERT_AUTHORITY_INVALID",
    });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [message] = toast.warning.mock.calls[0] ?? [];
    expect(message).toContain("proxy.internal");
    expect(message).toContain("system trust store");
  });

  it("mounts nothing on a shell with no platform bridge", () => {
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://example.com",
      authnBaseUrl: "https://auth.example.com",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostTrustAlertBridge />
      </RunnerHostProvider>,
    );

    expect(toast.warning).not.toHaveBeenCalled();
  });
});
