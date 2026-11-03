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
  type VoiceFocus,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionChrome } from "@/components/layout/voice/voice-session-chrome";
import { VoiceColumnTopRow } from "../voice-top-row";

const BOT_ID = "bot-1";
const FOCUS: VoiceFocus = {
  botId: BOT_ID,
  hostId: "host-a",
  threadId: null,
  anchorMessageId: null,
  anchorThread: null,
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

// The strip's own boundaries, as the strip suite stands them.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", () => ({ activateTabIntent: () => true }));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: ["host-a"], resolved: true }),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/providers/use-runner-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/use-runner-host")>()),
  useRunnerHost: () => ({
    openMicrophoneSettings: vi.fn(),
    signInUrl: "https://platform.test/sign-in",
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data: {
      bots: [{ botId: "bot-1", title: "Tracy", environmentId: "env-1" }],
    },
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: [{ environmentId: "env-1", label: "Personal" }] },
  }),
}));

interface ChromeCase {
  readonly label: string;
  readonly chrome: AppColumnChrome;
  /** The test id of the element Talk is drawn in for this chrome. */
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

const SURFACES: ReadonlyArray<{ readonly id: string }> = [
  { id: "settings" },
  { id: "empty-landing" },
  { id: "task-tab" },
  { id: "tracy-surface" },
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

function offerVoice(): void {
  act(() => {
    useVoiceSessionStore.setState({
      availability: "live",
      driver: makeDriver(),
    });
  });
}

function talkButtons(): ReadonlyArray<HTMLElement> {
  return screen.queryAllByRole("button", { name: "Talk" });
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
    "has the row to itself in a deployment with no voice, with the $label",
    ({ chrome, row }) => {
      renderColumn(chrome, "task-tab");

      expect(
        within(rowOf(row)).getByRole("button", { name: "Soundtrack" }),
      ).toBeTruthy();
      expect(talkButtons()).toHaveLength(0);
    },
  );

  it("stays beside the session strip while a session is live", () => {
    offerVoice();
    renderColumn(RIGHT_NONE.chrome, "task-tab");
    act(() => {
      useVoiceSessionStore.setState({ phase: "live", focus: FOCUS });
    });

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

describe("Talk in the window's top row", () => {
  it.each(CHROME_CASES)(
    "is mounted exactly once, in the top row, with the $label",
    ({ chrome, row }) => {
      offerVoice();
      renderColumn(chrome, "task-tab");

      const talk = talkButtons();
      expect(talk).toHaveLength(1);
      expect(rowOf(row).contains(talk[0] ?? null)).toBe(true);
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
    "draws no row, and takes no height, while voice is dormant or unknown, with the $label",
    ({ chrome, row }) => {
      offerVoice();
      renderColumn(chrome, "task-tab");
      expect(screen.queryByTestId(row)).not.toBeNull();

      act(() => useVoiceSessionStore.getState().setAvailability("dormant"));
      expect(screen.queryByTestId(row)).toBeNull();
      expect(screen.queryByTestId("app-header-centre-gap")).toBeNull();
      expect(talkButtons()).toHaveLength(0);

      act(() => useVoiceSessionStore.getState().setAvailability("unknown"));
      expect(screen.queryByTestId(row)).toBeNull();
      expect(screen.queryByTestId("app-header-centre-gap")).toBeNull();
      expect(talkButtons()).toHaveLength(0);
    },
  );

  it("stays in a desktop window zoomed under the phone breakpoint, whose header stays the desktop one", () => {
    viewport.phone = true;
    desktopMenus.active = true;
    offerVoice();
    renderColumn({ placement: "top", titleBand: "header" }, "zoomed");

    expect(
      within(screen.getByTestId("app-header-centre-zone")).getAllByRole(
        "button",
        { name: "Talk" },
      ),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Talk" })).toHaveLength(1);
  });

  it("draws the strip and no phone chrome for a live session in that window", () => {
    viewport.phone = true;
    desktopMenus.active = true;
    offerVoice();
    useVoiceSessionStore.setState({ phase: "live" });
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

  it("is not drawn in the phone layout, whatever the session is doing", () => {
    viewport.phone = true;
    offerVoice();
    renderColumn({ placement: "left", titleBand: "none" }, "task-tab");

    expect(screen.queryByTestId("voice-top-row")).toBeNull();
    expect(talkButtons()).toHaveLength(0);

    act(() => {
      useVoiceSessionStore.setState({ phase: "live", focus: FOCUS });
    });
    expect(screen.queryByTestId("voice-top-row")).toBeNull();
    expect(screen.queryByTestId("voice-session-strip")).toBeNull();
  });

  it.each(CHROME_CASES)(
    "gives the row to the session strip while it is live, and gets it back after Dismiss, with the $label",
    async ({ chrome, row }) => {
      offerVoice();
      renderColumn(chrome, "task-tab");
      const rowElement = rowOf(row);
      expect(rowElement.contains(talkButtons()[0] ?? null)).toBe(true);

      act(() => {
        useVoiceSessionStore.getState().sessionConnecting();
        useVoiceSessionStore.setState({ phase: "live", focus: FOCUS });
      });

      expect(talkButtons()).toHaveLength(0);
      const strip = screen.getByRole("region", { name: "Voice session" });
      expect(rowOf(row)).toBe(rowElement);
      expect(rowElement.contains(strip)).toBe(true);
      expect(
        within(rowElement).getByRole("button", { name: "End" }),
      ).toBeTruthy();

      act(() => useVoiceSessionStore.getState().sessionEnded("ended"));

      // The line about the end stays in the same row until it is dismissed.
      expect(talkButtons()).toHaveLength(0);
      expect(
        within(rowElement).getByTestId("voice-strip-state").textContent,
      ).toBe("Voice ended.");
      await userEvent.click(
        within(rowElement).getByRole("button", { name: "Dismiss" }),
      );

      expect(rowOf(row)).toBe(rowElement);
      expect(talkButtons()).toHaveLength(1);
      expect(rowElement.contains(talkButtons()[0] ?? null)).toBe(true);
      expect(screen.queryByTestId("voice-session-strip")).toBeNull();
    },
  );

  it.each([TOP_HEADER, RIGHT_NONE])(
    "keeps exactly one Talk, and the same one, as the surface changes from Settings to the landing, a task and the Tracy surface, with the $label",
    ({ chrome }) => {
      offerVoice();
      const view = renderColumn(chrome, "settings");
      const first = talkButtons()[0];
      expect(talkButtons()).toHaveLength(1);

      for (const surface of SURFACES) {
        view.rerender(<Column chrome={chrome} surfaceId={surface.id} />);
        expect(screen.getByTestId(`surface-${surface.id}`)).toBeTruthy();
        expect(talkButtons()).toHaveLength(1);
        expect(talkButtons()[0]).toBe(first);
      }
    },
  );
});
