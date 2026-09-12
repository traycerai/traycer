import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "@/components/epic-canvas/renderers/tile-controller";
import { useElectronTabChrome } from "@/components/epic-canvas/renderers/use-electron-tile-chrome";
import type { BrowserViewElectronTabControlAction } from "@traycer-clients/shared/platform/browser-view";

/**
 * These cover the parts of the hook that are about GUEST LIFETIME rather than
 * about a button: what it persists, and what it restates when the webContents
 * underneath the tile is replaced.
 *
 * That distinction is where the defects were. A tile's chrome outlives its guest
 * - a crash or a cross-window move produces a fresh webContents while the tab, the
 * pane and this hook all stay put - and anything the chrome remembers on the
 * guest's behalf has to be re-sent, while anything the guest reports before that
 * happens must not be written back as the tile's own value.
 */

const TILE_KEY = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
} as const;

interface HookProps {
  readonly registrationId: string | null;
  readonly zoomPercent: number;
  readonly zoomReports: number;
  readonly initialZoomFactor: number;
}

interface HookView {
  readonly result: {
    readonly current: ReturnType<typeof useElectronTabChrome>;
  };
  readonly rerender: (props: HookProps) => void;
  readonly control: Mock<
    (action: BrowserViewElectronTabControlAction) => Promise<void>
  >;
  readonly persistZoomFactor: Mock<(factor: number) => void>;
}

function mount(initial: HookProps): HookView {
  const control =
    vi.fn<(action: BrowserViewElectronTabControlAction) => Promise<void>>();
  control.mockResolvedValue(undefined);
  const persistZoomFactor = vi.fn<(factor: number) => void>();
  const { rerender, result } = renderHook(
    (props: HookProps) =>
      useElectronTabChrome({
        profile: "primary",
        control,
        surfaceServices: null,
        registrationId: props.registrationId,
        tileKey: TILE_KEY,
        initialUrl: "http://localhost:3000",
        capabilities: PRIMARY_TILE_CHROME_CAPABILITIES,
        annotation: null,
        statusUrl: "http://localhost:3000",
        canGoBack: false,
        canGoForward: false,
        zoomPercent: props.zoomPercent,
        zoomReports: props.zoomReports,
        faviconUrl: null,
        persistZoomFactor,
        initialZoomFactor: props.initialZoomFactor,
        onAttemptedUrl: () => undefined,
      }),
    { initialProps: initial },
  );
  return { result, rerender, control, persistZoomFactor };
}

function zoomFactorsSent(
  control: Mock<(action: BrowserViewElectronTabControlAction) => Promise<void>>,
): number[] {
  return control.mock.calls
    .map(([action]) => action)
    .filter(
      (action): action is Extract<typeof action, { kind: "setZoomFactor" }> =>
        action.kind === "setZoomFactor",
    )
    .map((action) => action.factor);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useElectronTabChrome zoom restore", () => {
  it("applies a remembered zoom to a new guest", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 0,
      initialZoomFactor: 1.5,
    });

    await waitFor(() => {
      expect(zoomFactorsSent(view.control)).toEqual([1.5]);
    });
  });

  it("sends nothing for a tile that remembers the default", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 0,
      initialZoomFactor: 1,
    });

    await waitFor(() => {
      expect(zoomFactorsSent(view.control)).toEqual([]);
    });
  });

  it("re-applies to a REPLACED guest at the same page session", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 150,
      zoomReports: 1,
      initialZoomFactor: 1.5,
    });
    await waitFor(() => {
      expect(zoomFactorsSent(view.control)).toEqual([1.5]);
    });

    // A crash or a cross-window move: same tab, fresh webContents at Chromium's
    // own default. The page session is unchanged, so only the registration can
    // reveal it.
    view.rerender({
      registrationId: "guest-2",
      zoomPercent: 100,
      zoomReports: 2,
      initialZoomFactor: 1.5,
    });

    await waitFor(() => {
      expect(zoomFactorsSent(view.control)).toEqual([1.5, 1.5]);
    });
  });

  it("does not re-apply on a re-render that keeps the same guest", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 150,
      zoomReports: 1,
      initialZoomFactor: 1.5,
    });
    await waitFor(() => {
      expect(zoomFactorsSent(view.control)).toEqual([1.5]);
    });

    view.rerender({
      registrationId: "guest-1",
      zoomPercent: 150,
      zoomReports: 2,
      initialZoomFactor: 1.5,
    });

    expect(zoomFactorsSent(view.control)).toEqual([1.5]);
  });
});

describe("useElectronTabChrome zoom persistence", () => {
  it("does not persist the seeded 100% before main has reported", () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 0,
      initialZoomFactor: 1.5,
    });

    // The seed is indistinguishable from a real 100% by value. Persisting it
    // wrote 1.0 over the 1.5 the tile was about to restore.
    expect(view.persistZoomFactor).not.toHaveBeenCalled();
  });

  it("persists a report that arrives after the restore", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 0,
      initialZoomFactor: 1.5,
    });
    await waitFor(() => {
      expect(zoomFactorsSent(view.control)).toEqual([1.5]);
    });

    // Main confirms the restored zoom.
    view.rerender({
      registrationId: "guest-1",
      zoomPercent: 150,
      zoomReports: 1,
      initialZoomFactor: 1.5,
    });

    await waitFor(() => {
      expect(view.persistZoomFactor).toHaveBeenCalledWith(1.5);
    });
  });

  it("never persists the default a replaced guest reports before its restore", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 150,
      zoomReports: 1,
      initialZoomFactor: 1.5,
    });
    await waitFor(() => {
      expect(zoomFactorsSent(view.control)).toEqual([1.5]);
    });
    view.rerender({
      registrationId: "guest-1",
      zoomPercent: 150,
      zoomReports: 2,
      initialZoomFactor: 1.5,
    });
    await waitFor(() => {
      expect(view.persistZoomFactor).toHaveBeenCalledWith(1.5);
    });
    view.persistZoomFactor.mockClear();

    // The replaced guest says 100% because that is what a fresh webContents is,
    // not because the tile's zoom changed.
    view.rerender({
      registrationId: "guest-2",
      zoomPercent: 100,
      zoomReports: 3,
      initialZoomFactor: 1.5,
    });

    expect(view.persistZoomFactor).not.toHaveBeenCalledWith(1);
  });

  it("persists a genuine user zoom on a settled guest", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 1,
      initialZoomFactor: 1,
    });
    // Default zoom: nothing to re-apply, so the gate opens immediately.
    view.rerender({
      registrationId: "guest-1",
      zoomPercent: 125,
      zoomReports: 2,
      initialZoomFactor: 1,
    });

    await waitFor(() => {
      expect(view.persistZoomFactor).toHaveBeenCalledWith(1.25);
    });
  });

  it("ignores a nonsense zoom report rather than persisting it", () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 0,
      zoomReports: 1,
      initialZoomFactor: 1,
    });

    expect(view.persistZoomFactor).not.toHaveBeenCalledWith(0);
  });
});

describe("useElectronTabChrome emulation restate", () => {
  function kindsSent(
    control: Mock<
      (action: BrowserViewElectronTabControlAction) => Promise<void>
    >,
  ): string[] {
    return control.mock.calls.map(([action]) => action.kind);
  }

  it("sends no appearance or mute for a fresh guest at the defaults", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 1,
      initialZoomFactor: 1,
    });

    // A new guest already IS system-scheme and unmuted; restating that would be a
    // round trip to change nothing.
    await waitFor(() => {
      expect(kindsSent(view.control)).not.toContain("setColorSchemePreference");
    });
    expect(kindsSent(view.control)).not.toContain("setAudioMuted");
  });

  it("restates a non-default appearance onto a replaced guest", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 1,
      initialZoomFactor: 1,
    });
    // The user picks Dark on this guest.
    act(() => {
      view.result.current.controller.onColorSchemePreferenceChange("dark");
    });
    await waitFor(() => {
      expect(kindsSent(view.control)).toContain("setColorSchemePreference");
    });
    const before = kindsSent(view.control).filter(
      (kind) => kind === "setColorSchemePreference",
    ).length;

    // The guest is replaced. Nothing in a status frame carries the scheme, so
    // without a restate the toolbar would show Dark over a page that is not.
    view.rerender({
      registrationId: "guest-2",
      zoomPercent: 100,
      zoomReports: 2,
      initialZoomFactor: 1,
    });

    await waitFor(() => {
      const after = kindsSent(view.control).filter(
        (kind) => kind === "setColorSchemePreference",
      ).length;
      expect(after).toBe(before + 1);
    });
  });

  it("restates mute onto a replaced guest", async () => {
    const view = mount({
      registrationId: "guest-1",
      zoomPercent: 100,
      zoomReports: 1,
      initialZoomFactor: 1,
    });
    act(() => {
      view.result.current.controller.onToggleMuted();
    });
    await waitFor(() => {
      expect(kindsSent(view.control)).toContain("setAudioMuted");
    });
    const before = kindsSent(view.control).filter(
      (kind) => kind === "setAudioMuted",
    ).length;

    view.rerender({
      registrationId: "guest-2",
      zoomPercent: 100,
      zoomReports: 2,
      initialZoomFactor: 1,
    });

    await waitFor(() => {
      const after = kindsSent(view.control).filter(
        (kind) => kind === "setAudioMuted",
      ).length;
      expect(after).toBe(before + 1);
    });
  });
});
