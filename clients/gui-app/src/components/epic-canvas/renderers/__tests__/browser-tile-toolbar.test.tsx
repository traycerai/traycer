import "../../../../../__tests__/test-browser-apis";
import type { SyntheticEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import {
  PRIMARY_TILE_CHROME_CAPABILITIES,
  type TileChromeCapabilities,
  type TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import type { BrowserAnnotationSessionController } from "@/hooks/browser/use-browser-annotation-session";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";

const REAL_COOKIE_STATE: BrowserCookieCryptoState = {
  mode: "real",
  persistence: "persistent",
  reason: "os-backed",
  storageBackend: null,
  encryptionAvailable: true,
  mockKeychainEnabled: false,
};

const ANNOTATION: BrowserAnnotationSessionController = {
  isActive: false,
  canStart: true,
  zoomLocked: false,
  toggle: () => undefined,
};

const DISABLED_CAPABILITIES: TileChromeCapabilities = {
  navigate: false,
  back: false,
  forward: false,
  reload: false,
  zoom: false,
  viewportPreset: false,
  devtools: false,
  find: false,
  siteInfo: false,
  annotate: false,
};

function preventNavigate(
  event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
): void {
  event.preventDefault();
}

function makeController(
  capabilities: TileChromeCapabilities,
  annotation: BrowserAnnotationSessionController | null,
): TileController {
  return {
    capabilities,
    url: "https://example.com",
    addressValue: "https://example.com",
    canGoBack: true,
    canGoForward: true,
    zoomPercent: 100,
    viewportPreset: "responsive",
    disabled: false,
    cookieCryptoState: REAL_COOKIE_STATE,
    zoomLocked: annotation?.zoomLocked === true,
    annotation,
    onNavigate: preventNavigate,
    onAddressChange: () => undefined,
    onBack: () => undefined,
    onForward: () => undefined,
    onReload: () => undefined,
    onZoomOut: () => undefined,
    onZoomIn: () => undefined,
    onResetZoom: () => undefined,
    onViewportPresetChange: () => undefined,
    onOpenDevTools: () => undefined,
  };
}

function renderToolbar(
  capabilities: TileChromeCapabilities,
  annotation: BrowserAnnotationSessionController | null,
): void {
  render(
    <TooltipProvider>
      <BrowserTileToolbar
        controller={makeController(capabilities, annotation)}
        pictureInPicture={null}
      />
    </TooltipProvider>,
  );
}

const CHROME_QUERIES: ReadonlyArray<{
  readonly name: string;
  readonly role: "button" | "textbox";
}> = [
  { name: "Back", role: "button" },
  { name: "Forward", role: "button" },
  { name: "Reload", role: "button" },
  { name: "Browser address", role: "textbox" },
  { name: "Zoom out", role: "button" },
  { name: "Reset zoom", role: "button" },
  { name: "Zoom in", role: "button" },
  { name: "Browser viewport preset", role: "button" },
  { name: "Open browser DevTools", role: "button" },
  { name: "Site information", role: "button" },
  { name: "Annotate page", role: "button" },
];

function queryChrome(query: {
  readonly name: string;
  readonly role: "button" | "textbox";
}): HTMLElement | null {
  return screen.queryByRole(query.role, { name: query.name });
}

describe("<BrowserTileToolbar /> capability gating", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders every chrome control when all capabilities are true", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION);

    for (const query of CHROME_QUERIES) {
      expect(queryChrome(query)).not.toBeNull();
    }
  });

  it("renders no chrome when every capability is false", () => {
    renderToolbar(DISABLED_CAPABILITIES, ANNOTATION);

    for (const query of CHROME_QUERIES) {
      expect(queryChrome(query)).toBeNull();
    }
  });

  it("renders the explicit picture-in-picture conversion action", () => {
    const convert = vi.fn();
    render(
      <TooltipProvider>
        <BrowserTileToolbar
          controller={makeController(DISABLED_CAPABILITIES, null)}
          pictureInPicture={{ disabled: false, convert }}
        />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Convert to picture-in-picture" }),
    );
    expect(convert).toHaveBeenCalledOnce();
  });

  it.each([
    { flag: "back" as const, name: "Back", role: "button" as const },
    { flag: "forward" as const, name: "Forward", role: "button" as const },
    { flag: "reload" as const, name: "Reload", role: "button" as const },
    {
      flag: "navigate" as const,
      name: "Browser address",
      role: "textbox" as const,
    },
    { flag: "zoom" as const, name: "Zoom out", role: "button" as const },
    { flag: "zoom" as const, name: "Reset zoom", role: "button" as const },
    { flag: "zoom" as const, name: "Zoom in", role: "button" as const },
    {
      flag: "viewportPreset" as const,
      name: "Browser viewport preset",
      role: "button" as const,
    },
    {
      flag: "devtools" as const,
      name: "Open browser DevTools",
      role: "button" as const,
    },
    {
      flag: "siteInfo" as const,
      name: "Site information",
      role: "button" as const,
    },
    {
      flag: "annotate" as const,
      name: "Annotate page",
      role: "button" as const,
    },
  ])("omits $name when $flag is false", ({ flag, name, role }) => {
    renderToolbar(
      { ...PRIMARY_TILE_CHROME_CAPABILITIES, [flag]: false },
      ANNOTATION,
    );

    expect(screen.queryByRole(role, { name })).toBeNull();
  });
});
