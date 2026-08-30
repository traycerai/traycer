import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBrowserPersistenceState } from "@/lib/browser-view/use-browser-persistence-state";
import type {
  BrowserPersistenceState,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import {
  FakeBrowserViewBridge,
  persistenceState,
} from "@/lib/browser-view/__tests__/fake-browser-view-bridge";

const refreshHostPersistenceState = vi.hoisted(() => vi.fn());

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  refreshBrowserSessionsPersistenceState: refreshHostPersistenceState,
}));

afterEach(() => {
  cleanup();
  refreshHostPersistenceState.mockClear();
});

function makeBridge(): {
  readonly bridge: BrowserViewBridge;
  readonly push: (state: BrowserPersistenceState) => void;
  readonly enableCalls: () => number;
} {
  const bridge = new FakeBrowserViewBridge();
  return {
    bridge,
    push: (state) => {
      bridge.emitPersistenceState(state);
    },
    enableCalls: () => bridge.persistenceEnableCallCount(),
  };
}

function Probe(props: { readonly bridge: BrowserViewBridge }) {
  const persistence = useBrowserPersistenceState(props.bridge);
  return (
    <div>
      <span data-testid="reason">
        {persistence.state?.cryptoState.reason ?? "unread"}
      </span>
      <button
        type="button"
        onClick={() => {
          persistence.enable("card");
        }}
      >
        enable
      </button>
    </div>
  );
}

describe("useBrowserPersistenceState", () => {
  it("shares one store, so every tile moves together on a push", async () => {
    const { bridge, push } = makeBridge();
    render(
      <>
        <Probe bridge={bridge} />
        <Probe bridge={bridge} />
      </>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByTestId("reason").map((node) => node.textContent),
      ).toEqual(["not-enabled", "not-enabled"]);
    });

    push(persistenceState({ enabled: true }));

    await waitFor(() => {
      expect(
        screen.getAllByTestId("reason").map((node) => node.textContent),
      ).toEqual(["os-backed", "os-backed"]);
    });
    // The host has to hear about it too, or its seed notice keeps telling the
    // agent that saved logins are off.
    expect(refreshHostPersistenceState).toHaveBeenCalled();
  });

  it("applies the state an enable resolves with", async () => {
    const { bridge, enableCalls } = makeBridge();
    render(<Probe bridge={bridge} />);
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("not-enabled");
    });

    await userEvent.click(screen.getByRole("button", { name: "enable" }));

    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("os-backed");
    });
    expect(enableCalls()).toBe(1);
  });
});
