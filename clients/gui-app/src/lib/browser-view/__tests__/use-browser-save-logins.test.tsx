import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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

describe("useBrowserSaveLogins", () => {
  it("re-reads on every mount, so a change made elsewhere cannot go stale", async () => {
    const bridge = new FakeBrowserViewBridge({ saveLogins: true });
    const first = render(<Probe bridge={bridge} />);
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });
    first.unmount();

    // Another window turned saving off. Nothing pushes that here, so only a
    // fresh read on the next mount can show it.
    await bridge.setSaveLogins(false);

    render(<Probe bridge={bridge} />);
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("false");
    });
  });

  it("round-trips a set through the bridge", async () => {
    const bridge = new FakeBrowserViewBridge({ saveLogins: true });
    render(<Probe bridge={bridge} />);
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
    render(<Probe bridge={bridge} />);
    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });

    await userEvent.click(screen.getByRole("button", { name: "turn off" }));

    await waitFor(() => {
      expect(screen.getByTestId("enabled").textContent).toBe("true");
    });
  });
});
