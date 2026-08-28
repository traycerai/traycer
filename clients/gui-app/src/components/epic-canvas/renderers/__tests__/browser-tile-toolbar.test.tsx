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

const openExternalLink = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => openExternalLink,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({}),
}));

const REAL_COOKIE_STATE: BrowserCookieCryptoState = {
  mode: "real",
  persistence: "persistent",
  reason: "os-backed",
  storageBackend: null,
  encryptionAvailable: true,
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
    onAddressFocusChange: () => undefined,
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
  { name: "Open in default browser", role: "button" },
  { name: "Annotate page", role: "button" },
];

const ADVANCED_MENU_ITEMS = [
  /^Site information/,
  /^Zoom out/,
  /^Reset zoom/,
  /^Zoom in/,
  /^Viewport/,
  "Open browser DevTools",
] as const;

function openMoreMenu(): void {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "More browser controls" }),
    { button: 0 },
  );
}

function queryChrome(query: {
  readonly name: string;
  readonly role: "button" | "textbox";
}): HTMLElement | null {
  return screen.queryByRole(query.role, { name: query.name });
}

describe("<BrowserTileToolbar /> capability gating", () => {
  afterEach(() => {
    cleanup();
    openExternalLink.mutate.mockClear();
  });

  it("renders every chrome control when all capabilities are true", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION);

    for (const query of CHROME_QUERIES) {
      expect(queryChrome(query)).not.toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: "More browser controls" }),
    ).not.toBeNull();
    for (const name of ADVANCED_MENU_ITEMS) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }

    openMoreMenu();
    expect(
      screen.getByRole("group", {
        name: "Zoom controls, current zoom 100%",
      }),
    ).not.toBeNull();
    for (const name of ADVANCED_MENU_ITEMS) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeNull();
    }
    expect(screen.getByRole("menuitem", { name: "Zoom out" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Reset zoom" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Zoom in" })).not.toBeNull();
  });

  it("renders no chrome when every capability is false", () => {
    renderToolbar(DISABLED_CAPABILITIES, ANNOTATION);

    for (const query of CHROME_QUERIES) {
      expect(queryChrome(query)).toBeNull();
    }
    expect(
      screen.queryByRole("button", { name: "More browser controls" }),
    ).toBeNull();
  });

  it("opens the current page in the default browser", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, ANNOTATION);

    fireEvent.click(
      screen.getByRole("button", { name: "Open in default browser" }),
    );

    expect(openExternalLink.mutate).toHaveBeenCalledExactlyOnceWith(
      "https://example.com",
    );
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

  it("keeps viewport presets open for quick switching", () => {
    const onViewportPresetChange = vi.fn();
    const controller = {
      ...makeController(
        { ...DISABLED_CAPABILITIES, viewportPreset: true },
        null,
      ),
      onViewportPresetChange,
    };
    render(
      <TooltipProvider>
        <BrowserTileToolbar controller={controller} pictureInPicture={null} />
      </TooltipProvider>,
    );

    openMoreMenu();
    expect(screen.queryByRole("menuitemradio", { name: /^Mobile/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Viewport/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Mobile/ }));
    expect(onViewportPresetChange).toHaveBeenCalledWith("mobile");
    expect(screen.getByRole("menuitem", { name: /^Viewport/ })).not.toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: /^Mobile/ }),
    ).not.toBeNull();
  });

  it("progressively discloses site information from the More menu", () => {
    renderToolbar({ ...DISABLED_CAPABILITIES, siteInfo: true }, null);

    expect(screen.queryByText("Web page")).toBeNull();
    openMoreMenu();
    expect(
      screen.getByRole("menuitem", {
        name: /Served over the network from this page's origin/,
      }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /^Site information/ }),
    );

    expect(
      screen.getByText("Served over the network from this page's origin."),
    ).not.toBeNull();
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

  it.each([
    { flag: "zoom" as const, names: [/^Zoom/] },
    { flag: "viewportPreset" as const, names: [/^Viewport/] },
    { flag: "devtools" as const, names: ["Open browser DevTools"] },
    { flag: "siteInfo" as const, names: [/^Site information/] },
  ])("hides advanced controls when $flag is false", ({ flag, names }) => {
    renderToolbar(
      { ...PRIMARY_TILE_CHROME_CAPABILITIES, [flag]: false },
      ANNOTATION,
    );

    openMoreMenu();
    for (const name of names) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
  });
});
