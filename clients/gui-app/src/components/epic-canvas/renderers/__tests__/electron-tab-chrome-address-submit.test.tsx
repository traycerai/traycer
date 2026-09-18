import "../../../../../__tests__/test-browser-apis";
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "@/components/epic-canvas/renderers/tile-controller";
import { useElectronTabChrome } from "@/components/epic-canvas/renderers/use-electron-tile-chrome";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type {
  BrowserViewElectronTabControlAction,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

const TILE_KEY: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "session-1",
};

/**
 * Wires the real `useElectronTabChrome` hook into the real toolbar, so a
 * submit exercises the hook's own `navigateToUrl` rather than a mock of it
 * (`agent-browser-tile.test.tsx` mocks the hook, so it cannot see this bug).
 */
function AddressBarHarness(props: {
  readonly liveUrl: string;
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
}): ReactElement {
  const chrome = useElectronTabChrome({
    profile: "primary",
    control: props.control,
    surfaceServices: null,
    tileKey: TILE_KEY,
    initialUrl: props.liveUrl,
    capabilities: PRIMARY_TILE_CHROME_CAPABILITIES,
    annotation: null,
    statusUrl: props.liveUrl,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    onAttemptedUrl: () => undefined,
  });
  return (
    <TooltipProvider>
      <BrowserTileToolbar
        controller={chrome.controller}
        pictureInPicture={null}
        loading={false}
      />
    </TooltipProvider>
  );
}

function addressField(): HTMLInputElement {
  const field = screen.getByRole("textbox", { name: "Browser address" });
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("expected the address field to be an <input>");
  }
  return field;
}

async function submitAddress(user: UserEvent, value: string): Promise<void> {
  const input = addressField();
  await user.clear(input);
  await user.type(input, `${value}{Enter}`);
}

describe("address bar submit routes through the real chrome hook", () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ browserSearchEngine: "google" });
  });

  it("reloads, and does not navigate, when Enter submits the exact current address", async () => {
    const control = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    const liveUrl = "https://example.com/dashboard";
    render(<AddressBarHarness liveUrl={liveUrl} control={control} />);

    await submitAddress(user, liveUrl);

    expect(control).toHaveBeenCalledExactlyOnceWith({ kind: "reload" });
  });

  it("reloads when Enter submits an address that normalizes to the current one", async () => {
    const control = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    // The live URL is scheme-qualified already; typing the bare host with no
    // scheme still normalizes to the same `https://example.com`, so this must
    // reload rather than fall through to a literal-string mismatch.
    const liveUrl = "https://example.com";
    render(<AddressBarHarness liveUrl={liveUrl} control={control} />);

    await submitAddress(user, "example.com");

    expect(control).toHaveBeenCalledExactlyOnceWith({ kind: "reload" });
  });

  it("navigates, and does not reload, when Enter submits a different address", async () => {
    const control = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    const liveUrl = "https://example.com/";
    render(<AddressBarHarness liveUrl={liveUrl} control={control} />);

    await submitAddress(user, "https://other.example/page");

    expect(control).toHaveBeenCalledExactlyOnceWith({
      kind: "navigate",
      url: "https://other.example/page",
    });
  });
});
