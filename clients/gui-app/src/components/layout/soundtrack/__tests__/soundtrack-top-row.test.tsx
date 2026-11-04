import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import { AppHeader } from "@/components/layout/header/app-header";
import type { AppColumnChrome } from "@/components/layout/header/app-title-band-kind";
import { SheetJoinScope } from "@/components/layout/tabs/sheet-join";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SoundtrackColumnTopRow } from "../soundtrack-top-row";

const viewport = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewport.phone,
  isMobileViewport: () => viewport.phone,
}));

const desktopMenus = vi.hoisted(() => ({ active: false }));
vi.mock("@/components/layout/header/use-desktop-menu-bar-active", () => ({
  useDesktopMenuBarActive: () => desktopMenus.active,
}));

// The header's own children need host, query and auth providers this suite is
// not about; the tab strip is the one stand-in with a name, so a test can see
// that the header drew it beside the zone.
vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div role="tablist" aria-label="Open tabs" />,
}));
vi.mock("@/hooks/appearance/use-header-tab-appearance", () => ({
  useHeaderTabAppearance: () => null,
}));
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => null,
}));
vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => null,
}));
vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => null,
}));
vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => null,
}));
vi.mock("@/components/auth/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => null,
}));
vi.mock("@/components/layout/header/desktop-menu-bar", () => ({
  DesktopMenuBar: () => null,
}));
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => null,
}));

// The strip's own boundary: its ended line reads the billing account.
vi.mock("@/providers/use-runner-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/use-runner-host")>()),
  useRunnerHost: () => ({
    openMicrophoneSettings: vi.fn(),
    signInUrl: "https://platform.test/sign-in",
  }),
}));

interface ChromeCase {
  readonly label: string;
  readonly chrome: AppColumnChrome;
  /** The test id of the element the toggle is drawn in for this chrome. */
  readonly row: "app-header-centre-zone" | "soundtrack-top-row";
}

const TOP_HEADER: ChromeCase = {
  label: "top strip under the header",
  chrome: { placement: "top", titleBand: "header" },
  row: "app-header-centre-zone",
};
const RIGHT_NONE: ChromeCase = {
  label: "right strip with no band",
  chrome: { placement: "right", titleBand: "none" },
  row: "soundtrack-top-row",
};
const CHROME_CASES: ReadonlyArray<ChromeCase> = [
  TOP_HEADER,
  {
    label: "left strip under a title band",
    chrome: { placement: "left", titleBand: "band" },
    row: "soundtrack-top-row",
  },
  {
    label: "right strip under a title band",
    chrome: { placement: "right", titleBand: "band" },
    row: "soundtrack-top-row",
  },
  {
    label: "left strip with no band",
    chrome: { placement: "left", titleBand: "none" },
    row: "soundtrack-top-row",
  },
  RIGHT_NONE,
];

/** The app column as `AppShell` composes it, with a stand-in for the surface. */
function Column(props: {
  readonly chrome: AppColumnChrome;
  readonly surfaceId: string;
}): ReactNode {
  const { chrome } = props;
  const { titleBand } = chrome;
  return (
    <SheetJoinScope>
      <TooltipProvider>
        <AppColumnFrame
          {...chrome}
          columnRef={() => undefined}
          header={<AppHeader variant="app" />}
          soundtrackTopRow={
            titleBand === "header" ? null : (
              <SoundtrackColumnTopRow titleBand={titleBand} />
            )
          }
          strip={<nav data-testid="strip-slot" />}
          banners={<div />}
          surface={<div data-testid={`surface-${props.surfaceId}`} />}
          mainTail={null}
          tail={null}
        />
      </TooltipProvider>
    </SheetJoinScope>
  );
}

function renderColumn(chrome: AppColumnChrome, surfaceId: string) {
  return render(<Column chrome={chrome} surfaceId={surfaceId} />, {
    wrapper: WithTestQueryClient,
  });
}

function rowOf(testId: ChromeCase["row"]): HTMLElement {
  return screen.getByTestId(testId);
}

beforeEach(() => {
  viewport.phone = false;
  desktopMenus.active = false;
});

afterEach(() => {
  cleanup();
});

describe("the soundtrack's toggle in the window's top row", () => {
  beforeEach(() => {
    vi.stubEnv("MODE", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(CHROME_CASES)(
    "has the row to itself, with the $label",
    ({ chrome, row }) => {
      renderColumn(chrome, "task-tab");

      expect(
        within(rowOf(row)).getByRole("button", { name: "Soundtrack" }),
      ).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Call" })).toBeNull();
    },
  );

  it.each(CHROME_CASES)(
    "is mounted exactly once, in the top row, with the $label",
    ({ chrome, row }) => {
      renderColumn(chrome, "task-tab");

      const toggles = screen.getAllByRole("button", { name: "Soundtrack" });
      expect(toggles).toHaveLength(1);
      expect(rowOf(row).contains(toggles[0] ?? null)).toBe(true);
      if (chrome.titleBand === "header") {
        // The header carries it, beside the tabs; the frame adds no row.
        expect(screen.queryByTestId("soundtrack-top-row")).toBeNull();
        expect(screen.getByTestId("app-header").contains(rowOf(row))).toBe(
          true,
        );
      } else {
        expect(rowOf(row).getAttribute("data-title-band")).toBe(
          chrome.titleBand,
        );
      }
    },
  );

  it.each([TOP_HEADER, RIGHT_NONE])(
    "keeps the same toggle when the surface content is replaced, with the $label",
    ({ chrome }) => {
      const view = renderColumn(chrome, "surface-a");
      const first = screen.getByRole("button", { name: "Soundtrack" });

      view.rerender(<Column chrome={chrome} surfaceId="surface-b" />);

      expect(screen.getByTestId("surface-surface-b")).toBeTruthy();
      expect(
        screen.getAllByRole("button", { name: "Soundtrack" }),
      ).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Soundtrack" })).toBe(first);
    },
  );

  it("is not drawn in the phone layout", () => {
    viewport.phone = true;
    renderColumn(RIGHT_NONE.chrome, "task-tab");

    expect(screen.queryByTestId("soundtrack-top-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Soundtrack" })).toBeNull();
  });

  it("stays in a desktop window zoomed under the phone breakpoint, whose header stays the desktop one", () => {
    viewport.phone = true;
    desktopMenus.active = true;
    renderColumn({ placement: "top", titleBand: "header" }, "zoomed");

    expect(
      within(screen.getByTestId("app-header-centre-zone")).getByRole("button", {
        name: "Soundtrack",
      }),
    ).toBeTruthy();
  });
});

describe("a build with no soundtrack to play", () => {
  it.each(CHROME_CASES)(
    "draws no row and takes no height, with the $label",
    ({ chrome, row }) => {
      renderColumn(chrome, "task-tab");

      expect(screen.queryByTestId(row)).toBeNull();
      expect(screen.queryByTestId("app-header-centre-gap")).toBeNull();
      expect(screen.queryByRole("button", { name: "Soundtrack" })).toBeNull();
    },
  );
});
