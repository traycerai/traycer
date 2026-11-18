import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import {
  DesktopMenuHeader,
  type DesktopMenuHeaderVariant,
} from "@/components/layout/header/desktop-menu-header";
import {
  WINDOW_LEADING_INSET_CLASS,
  WINDOW_TRAILING_INSET_CLASS,
} from "@/components/layout/header/title-bar-drag";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

type DesktopPlatform = "darwin" | "win32" | "linux";

function createDesktopHost(platform: DesktopPlatform): MockRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  Object.assign(host, {
    menu: {
      platform,
      onCommand: (_handler: (payload: DesktopMenuCommandPayload) => void) => ({
        dispose: () => undefined,
      }),
      getSnapshot: () =>
        Promise.resolve({
          revision: 1,
          menus: [
            { id: "file", label: "File", items: [] },
            { id: "edit", label: "Edit", items: [] },
            { id: "view", label: "View", items: [] },
            { id: "window", label: "Window", items: [] },
            { id: "help", label: "Help", items: [] },
          ],
        }),
      executeItem: () => Promise.resolve(),
      onChange: (_handler: () => void) => ({ dispose: () => undefined }),
      openTopLevel: () => Promise.resolve(),
    },
  });
  return host;
}

function renderHeader(
  host: MockRunnerHost,
  variant: DesktopMenuHeaderVariant,
): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostProvider runnerHost={host}>
        <DesktopMenuHeader variant={variant} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useTitleBarDragStore
    .getState()
    .setSuppressed("desktop-menu-header-test", false);
});

for (const platform of ["win32", "linux"] as const) {
  it(`renders one shared menu row for ${platform}`, () => {
    renderHeader(createDesktopHost(platform), "boot");

    const header = screen.getByTestId("desktop-menu-header");
    expect(header.className).toContain("h-10");
    expect(header.classList.contains(WINDOW_LEADING_INSET_CLASS)).toBe(true);
    expect(header.classList.contains(WINDOW_TRAILING_INSET_CLASS)).toBe(true);
    expect(
      screen.getAllByRole("navigation", { name: "Application menu" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
  });
}

it.each([
  ["boot", "desktop-menu-header"],
  ["title-band", "app-title-band"],
] as const)(
  "drops the drag region while a title-bar overlay is open (%s)",
  (variant, testId) => {
    renderHeader(createDesktopHost("linux"), variant);
    const row = screen.getByTestId(testId);
    expect(row.classList.contains("[-webkit-app-region:drag]")).toBe(true);

    act(() => {
      useTitleBarDragStore
        .getState()
        .setSuppressed("desktop-menu-header-test", true);
    });
    expect(row.classList.contains("[-webkit-app-region:no-drag]")).toBe(true);
    expect(row.classList.contains("[-webkit-app-region:drag]")).toBe(false);
  },
);

it("reserves the same h-10 boot slot when desktop menus are inactive", () => {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostProvider runnerHost={createDesktopHost("darwin")}>
        <DesktopMenuHeader variant="boot" />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  const reservation = container.querySelector('[aria-hidden="true"]');
  expect(reservation).not.toBeNull();
  expect(reservation?.className).toContain("h-10");
  expect(
    screen.queryByRole("navigation", { name: "Application menu" }),
  ).toBeNull();
});

it("reserves a boot slot in a browser tree without a host bridge", () => {
  const { container } = render(<DesktopMenuHeader variant="boot" />);
  const reservation = container.querySelector('[aria-hidden="true"]');
  expect(reservation).not.toBeNull();
  expect(reservation?.className).toContain("h-10");
});

describe("title-band variant", () => {
  for (const platform of ["win32", "linux"] as const) {
    it(`draws the menu bar in a band-height row for ${platform}`, () => {
      renderHeader(createDesktopHost(platform), "title-band");

      const band = screen.getByTestId("app-title-band");
      expect(band.classList.contains("h-[var(--app-title-band-height)]")).toBe(
        true,
      );
      expect(band.classList.contains("h-10")).toBe(false);
      expect(band.classList.contains(WINDOW_LEADING_INSET_CLASS)).toBe(true);
      expect(band.classList.contains(WINDOW_TRAILING_INSET_CLASS)).toBe(true);
      expect(band.classList.contains("after:h-px")).toBe(true);
      expect(band.classList.contains("flex")).toBe(true);
      // A menu-bearing band displays even without a window-controls overlay.
      expect(band.classList.contains("hidden")).toBe(false);
      expect(band.classList.contains("wco:flex")).toBe(false);
      expect(
        screen.getAllByRole("navigation", { name: "Application menu" }),
      ).toHaveLength(1);
      expect(screen.queryByTestId("desktop-menu-header")).toBeNull();
    });
  }

  it("is an empty drag band shown only under a window-controls overlay without desktop menus", () => {
    renderHeader(createDesktopHost("darwin"), "title-band");

    const band = screen.getByTestId("app-title-band");
    expect(band.classList.contains("h-[var(--app-title-band-height)]")).toBe(
      true,
    );
    // The surface's `flex` must be merged away, or the band would show
    // outside a window-controls overlay.
    expect(band.classList.contains("hidden")).toBe(true);
    expect(band.classList.contains("flex")).toBe(false);
    expect(band.classList.contains("wco:flex")).toBe(true);
    expect(band.classList.contains(WINDOW_LEADING_INSET_CLASS)).toBe(false);
    expect(band.classList.contains("[-webkit-app-region:drag]")).toBe(true);
    expect(band.getAttribute("aria-hidden")).toBe("true");
    expect(band.childElementCount).toBe(0);
    expect(
      screen.queryByRole("navigation", { name: "Application menu" }),
    ).toBeNull();
  });
});
