import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { useBrowserSaveLogins } from "@/lib/browser-view/use-browser-save-logins";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";

afterEach(cleanup);

function Probe(props: { readonly bridge: BrowserViewBridge }) {
  const saveLogins = useBrowserSaveLogins(props.bridge);
  return (
    <div>
      <span data-testid="enabled">{String(saveLogins.enabled)}</span>
      <button type="button" onClick={() => saveLogins.setEnabled(false)}>
        turn off
      </button>
    </div>
  );
}

/**
 * ONE client per test, shared by every mount inside it: the remount cases are
 * about what a warm cache does, and a fresh client per mount would prove
 * nothing about it.
 */
function makeProbe(bridge: BrowserViewBridge): () => ReactNode {
  const client = new QueryClient();
  return () => (
    <QueryClientProvider client={client}>
      <Probe bridge={bridge} />
    </QueryClientProvider>
  );
}

describe("useBrowserSaveLogins", () => {
  it("re-reads on every mount, so a change made elsewhere cannot go stale", async () => {
    const bridge = new FakeBrowserViewBridge({ saveLogins: true });
    const probe = makeProbe(bridge);
    const first = render(probe());
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });
    first.unmount();

    // Another window turned saving off. Nothing pushes that here, so only a
    // fresh read on the next mount can show it - the cached `true` is what the
    // remount has to refuse to settle for.
    await bridge.setSaveLogins(false);

    render(probe());
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("false");
    });
  });

  it("round-trips a set through the bridge", async () => {
    const bridge = new FakeBrowserViewBridge({ saveLogins: true });
    const probe = makeProbe(bridge);
    render(probe());
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });

    await userEvent.click(screen.getByRole("button", { name: "turn off" }));

    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("false");
    });
  });

  it("leaves the last known value when a set rejects", async () => {
    const bridge = new FakeBrowserViewBridge({ saveLogins: true });
    // Rejected at CALL time, not here: a promise rejected during arrange goes
    // unhandled through the render and the waitFor below it.
    bridge.setNextSetSaveLoginsResult(() =>
      Promise.reject(new Error("denied")),
    );
    const probe = makeProbe(bridge);
    render(probe());
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });

    await userEvent.click(screen.getByRole("button", { name: "turn off" }));

    // Restored by re-reading the machine, not by remembering locally: the
    // refetch the failure triggers is what puts the toggle back.
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });
  });

  it("takes the value the machine settled on, and it survives a remount", async () => {
    const bridge = new FakeBrowserViewBridge({ saveLogins: true });
    // The write goes through the forced path - what a desktop that answers
    // with its own settled value looks like from here.
    bridge.setNextSetSaveLoginsResult(() => Promise.resolve(false));
    const probe = makeProbe(bridge);
    const first = render(probe());
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });

    await userEvent.click(screen.getByRole("button", { name: "turn off" }));
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("false");
    });
    first.unmount();

    // The bridge is the machine here, and a settled write is state it KEPT -
    // asserted on the read directly, because a remount would show the cached
    // value first and pass before its own refetch could contradict it.
    expect(await bridge.getSaveLogins()).toBe(false);

    render(probe());
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("false");
    });
  });
});
