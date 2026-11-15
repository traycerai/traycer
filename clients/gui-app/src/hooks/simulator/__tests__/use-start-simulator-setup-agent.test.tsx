import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SimulatorStatusResponse } from "@traycer/protocol/host/simulator/schemas";
import { useStartSimulatorSetupAgent } from "@/hooks/simulator/use-start-simulator-setup-agent";
import { browserTabId } from "@/lib/browser-tab-identity";
import { setMobileApp } from "@/lib/mobile-app";
import { simulatorSetupPromptContent } from "@/lib/simulator-view/simulator-setup-agent";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  composerSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

/**
 * "Set up with an agent" against the real stores: the composer pin and the
 * landing drafts are the effects, and a host whose lease is gone is refused
 * rather than placed on whichever host the window falls back to.
 */

const navigation = vi.hoisted(() => ({ activate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: navigation.activate,
}));

const HOST = "host-1";
const STATUS: SimulatorStatusResponse = {
  platforms: [
    {
      platform: "android",
      available: false,
      reason: "No Android SDK.",
      setupSupported: true,
    },
  ],
  packState: { kind: "unsupported", reason: null, progress: null },
  packVersion: null,
  installed: null,
};
const INPUT = { hostName: "Studio Mac", status: STATUS };

const ready = (hostId: string): HostLeaseSnapshot => ({
  hostId,
  status: "ready",
  dead: null,
});

function attach(leases: readonly HostLeaseSnapshot[]): void {
  useSelectionAuthorityStore.setState({ attached: true, leases });
}

function composerPin(): string | undefined {
  return useSurfaceHostSelectionStore.getState().selections[
    composerSurfaceKey(browserTabId())
  ];
}

beforeEach(() => {
  navigation.activate.mockReset();
  useSelectionAuthorityStore.getState().reset();
  useSurfaceHostSelectionStore.setState({ selections: {} });
});

afterEach(() => {
  setMobileApp(false);
  useSelectionAuthorityStore.getState().reset();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useSettingsStore.setState({ composerMode: "chat" });
});

describe("useStartSimulatorSetupAgent", () => {
  it.each([false, true])(
    "opens a fresh chat draft with the setup prompt, names its host, leaves the window pin and an existing draft alone (mobile app: %s)",
    (mobile) => {
      setMobileApp(mobile);
      attach([ready(HOST)]);
      const existing = useLandingDraftStore
        .getState()
        .createDraftWithId("existing-draft", null);
      useLandingDraftStore.getState().setDraftContent(
        existing,
        simulatorSetupPromptContent({
          hostId: "other",
          hostName: "Other",
          status: STATUS,
        }),
        null,
      );
      const before = useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === existing)?.content;
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(composerSurfaceKey(browserTabId()), "window-pinned-host");

      const { result } = renderHook(() => useStartSimulatorSetupAgent(HOST));
      expect(result.current.hostReachable).toBe(true);
      act(() => result.current.start(INPUT));

      expect(composerPin()).toBe("window-pinned-host");
      const drafts = useLandingDraftStore.getState().drafts;
      const created = drafts.find((draft) => draft.id !== existing);
      expect(created?.content).toEqual(
        simulatorSetupPromptContent({
          hostId: HOST,
          hostName: "Studio Mac",
          status: STATUS,
        }),
      );
      expect(created?.namedHostId).toBe(HOST);
      expect(created?.composerMode).toBe("chat");
      expect(drafts.find((draft) => draft.id === existing)?.content).toEqual(
        before,
      );
      expect(navigation.activate).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps each draft on the host it was opened for when a second setup starts for another host", () => {
    attach([ready(HOST), ready("host-2")]);
    const first = renderHook(() => useStartSimulatorSetupAgent(HOST));
    act(() => first.result.current.start(INPUT));
    const second = renderHook(() => useStartSimulatorSetupAgent("host-2"));
    act(() => second.result.current.start(INPUT));
    const bound = useLandingDraftStore
      .getState()
      .drafts.map((draft) => draft.namedHostId);
    expect(bound.sort()).toEqual([HOST, "host-2"]);
    expect(composerPin()).toBeUndefined();
  });

  it("opens a chat draft even when the person's last-used mode is the terminal agent", () => {
    useSettingsStore.setState({ composerMode: "terminal" });
    attach([ready(HOST)]);
    const { result } = renderHook(() => useStartSimulatorSetupAgent(HOST));
    act(() => result.current.start(INPUT));
    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.composerMode),
    ).toEqual(["chat"]);
  });

  it("refuses a host whose lease is dead or missing: no pin, no draft, no navigation", () => {
    for (const leases of [
      [{ hostId: HOST, status: "dead", dead: { reason: "offline" } }],
      [ready("another-host")],
    ] satisfies HostLeaseSnapshot[][]) {
      attach(leases);
      const { result, unmount } = renderHook(() =>
        useStartSimulatorSetupAgent(HOST),
      );
      expect(result.current.hostReachable).toBe(false);
      act(() => result.current.start(INPUT));
      expect(composerPin()).toBeUndefined();
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
      expect(navigation.activate).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("writes nothing without a host", () => {
    attach([ready(HOST)]);
    const { result } = renderHook(() => useStartSimulatorSetupAgent(null));
    expect(result.current.hostReachable).toBe(false);
    act(() => result.current.start(INPUT));
    expect(useSurfaceHostSelectionStore.getState().selections).toEqual({});
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(navigation.activate).not.toHaveBeenCalled();
  });
});
