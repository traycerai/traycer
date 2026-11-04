import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import { AppHeader } from "@/components/layout/header/app-header";
import type { AppColumnChrome } from "@/components/layout/header/app-title-band-kind";
import { SheetJoinScope } from "@/components/layout/tabs/sheet-join";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallFocus,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionChrome } from "@/components/layout/voice/voice-session-chrome";
import { VoiceColumnTopRow } from "../voice-top-row";

const BOT_ID = "bot-1";
const FOCUS: CallFocus = {
  botId: BOT_ID,
  hostId: "host-a",
  threadId: null,
};

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
  /** The test id of the element the strip is drawn in for this chrome. */
  readonly row: "app-header-centre-zone" | "voice-top-row";
}

const TOP_HEADER: ChromeCase = {
  label: "top strip under the header",
  chrome: { placement: "top", titleBand: "header" },
  row: "app-header-centre-zone",
};
const RIGHT_NONE: ChromeCase = {
  label: "right strip with no band",
  chrome: { placement: "right", titleBand: "none" },
  row: "voice-top-row",
};
const CHROME_CASES: ReadonlyArray<ChromeCase> = [
  TOP_HEADER,
  {
    label: "left strip under a title band",
    chrome: { placement: "left", titleBand: "band" },
    row: "voice-top-row",
  },
  {
    label: "right strip under a title band",
    chrome: { placement: "right", titleBand: "band" },
    row: "voice-top-row",
  },
  {
    label: "left strip with no band",
    chrome: { placement: "left", titleBand: "none" },
    row: "voice-top-row",
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
          voiceTopRow={
            titleBand === "header" ? null : (
              <VoiceColumnTopRow titleBand={titleBand} />
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

function makeDriver(): VoiceSessionDriver {
  return {
    start: vi.fn<VoiceSessionDriver["start"]>(),
    end: vi.fn<VoiceSessionDriver["end"]>(),
    setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
  };
}

function startCall(): void {
  act(() => {
    useVoiceSessionStore.getState().sessionConnecting(FOCUS, "Tracy");
    useVoiceSessionStore.setState({ phase: "live", driver: makeDriver() });
  });
}

function rowOf(testId: ChromeCase["row"]): HTMLElement {
  return screen.getByTestId(testId);
}

beforeEach(() => {
  viewport.phone = false;
  desktopMenus.active = false;
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useTracySurfaceStore.getState().openSurface("host-a");
  useTracySurfaceStore.getState().selectChannel(BOT_ID);
});

afterEach(() => {
  cleanup();
  useBotOpenThreadStore.getState().setRail(BOT_ID, null);
});

describe("the soundtrack's toggle in the window's top row", () => {
  beforeEach(() => {
    vi.stubEnv("MODE", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(CHROME_CASES)(
    "has the row to itself while no call runs, with the $label",
    ({ chrome, row }) => {
      renderColumn(chrome, "task-tab");

      expect(
        within(rowOf(row)).getByRole("button", { name: "Soundtrack" }),
      ).toBeTruthy();
      expect(screen.queryByTestId("voice-session-strip")).toBeNull();
    },
  );

  it("stays beside the call strip while a call is live", () => {
    renderColumn(RIGHT_NONE.chrome, "task-tab");
    startCall();

    const row = within(rowOf(RIGHT_NONE.row));
    expect(row.getByTestId("voice-session-strip")).toBeTruthy();
    expect(row.getByRole("button", { name: "Soundtrack" })).toBeTruthy();
  });

  it("is not drawn in the phone layout", () => {
    viewport.phone = true;
    renderColumn(RIGHT_NONE.chrome, "task-tab");

    expect(screen.queryByTestId("voice-top-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Soundtrack" })).toBeNull();
  });
});

describe("the call strip in the window's top row", () => {
  it.each(CHROME_CASES)(
    "is mounted exactly once, in the top row, while a call runs, with the $label",
    ({ chrome, row }) => {
      startCall();
      renderColumn(chrome, "task-tab");

      const strips = screen.getAllByRole("region", { name: "Call" });
      expect(strips).toHaveLength(1);
      expect(rowOf(row).contains(strips[0] ?? null)).toBe(true);
      if (chrome.titleBand === "header") {
        // The header carries it, beside the tabs; the frame adds no row.
        expect(screen.queryByTestId("voice-top-row")).toBeNull();
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

  it.each(CHROME_CASES)(
    "draws no row, and takes no height, with no call and nothing else to carry, with the $label",
    ({ chrome, row }) => {
      renderColumn(chrome, "task-tab");

      expect(screen.queryByTestId(row)).toBeNull();
      expect(screen.queryByTestId("app-header-centre-gap")).toBeNull();
      expect(screen.queryByRole("region", { name: "Call" })).toBeNull();
    },
  );

  it.each(CHROME_CASES)(
    "needs no offer from the server to draw a call that runs, with the $label",
    ({ chrome, row }) => {
      // Voice availability gates where a call is placed, never the strip of
      // one that already runs.
      useVoiceSessionStore.getState().setAvailability("dormant");
      startCall();
      renderColumn(chrome, "task-tab");

      expect(
        within(rowOf(row)).getByRole("button", { name: "End" }),
      ).toBeTruthy();
    },
  );

  it("stays in a desktop window zoomed under the phone breakpoint, whose header stays the desktop one, with no phone chrome", () => {
    viewport.phone = true;
    desktopMenus.active = true;
    startCall();
    renderColumn({ placement: "top", titleBand: "header" }, "zoomed");
    render(<VoiceSessionChrome />);

    expect(
      within(screen.getByTestId("app-header-centre-zone")).getByTestId(
        "voice-strip-end",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("voice-phone-bar")).toBeNull();
    expect(screen.queryByTestId("voice-phone-view")).toBeNull();
  });

  it("is not drawn in the phone layout, whatever the call is doing", () => {
    viewport.phone = true;
    renderColumn({ placement: "left", titleBand: "none" }, "task-tab");

    expect(screen.queryByTestId("voice-top-row")).toBeNull();

    startCall();
    expect(screen.queryByTestId("voice-top-row")).toBeNull();
    expect(screen.queryByTestId("voice-session-strip")).toBeNull();
  });

  it.each(CHROME_CASES)(
    "holds the row for the line about the end until Dismiss, then gives it back, with the $label",
    async ({ chrome, row }) => {
      renderColumn(chrome, "task-tab");
      startCall();
      const rowElement = rowOf(row);
      expect(
        within(rowElement).getByRole("button", { name: "End" }),
      ).toBeTruthy();

      act(() => useVoiceSessionStore.getState().sessionEnded("ended"));

      // The line about the end stays in the same row until it is dismissed.
      expect(rowOf(row)).toBe(rowElement);
      expect(
        within(rowElement).getByTestId("voice-strip-state").textContent,
      ).toBe("Call ended.");
      await userEvent.click(
        within(rowElement).getByRole("button", { name: "Dismiss" }),
      );

      expect(screen.queryByTestId(row)).toBeNull();
      expect(screen.queryByTestId("voice-session-strip")).toBeNull();
    },
  );

  it.each([TOP_HEADER, RIGHT_NONE])(
    "keeps exactly one strip, and the same one, when the surface content is replaced, with the $label",
    ({ chrome }) => {
      startCall();
      const view = renderColumn(chrome, "surface-a");
      const first = screen.getByRole("region", { name: "Call" });

      view.rerender(<Column chrome={chrome} surfaceId="surface-b" />);
      expect(screen.getByTestId("surface-surface-b")).toBeTruthy();
      expect(screen.getAllByRole("region", { name: "Call" })).toHaveLength(1);
      expect(screen.getByRole("region", { name: "Call" })).toBe(first);
    },
  );
});
