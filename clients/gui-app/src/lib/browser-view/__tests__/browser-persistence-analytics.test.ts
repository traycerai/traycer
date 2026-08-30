import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Analytics,
  AnalyticsEvent,
  sanitizeAnalyticsProperties,
} from "@/lib/analytics";
import {
  __resetBrowserPersistenceAnalyticsForTests,
  trackBrowserLoginsForgotten,
  trackBrowserPersistence,
  trackBrowserPersistenceStateAtFirstTile,
  type BrowserPersistenceAnalyticsEvent,
} from "@/lib/browser-view/browser-persistence-analytics";
import {
  useBrowserPersistenceState,
  type BrowserPersistenceController,
} from "@/lib/browser-view/use-browser-persistence-state";
import { BrowserPersistenceExplainerCard } from "@/components/epic-canvas/renderers/browser-persistence-explainer-card";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type {
  BrowserCookieCryptoReason,
  BrowserPersistenceDecision,
  BrowserPersistenceState,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  refreshBrowserSessionsPersistenceState: vi.fn(),
}));

/**
 * Every variant the funnel can emit, with every enum member of every payload
 * key. The hygiene rule is asserted against THIS list, so no event and no
 * value can be added without being proven payload-safe first.
 */
const ALL_EVENTS: ReadonlyArray<BrowserPersistenceAnalyticsEvent> = [
  { name: "browser_persistence_card_shown" },
  { name: "browser_persistence_card_action", action: "enable" },
  { name: "browser_persistence_card_action", action: "not_now" },
  {
    name: "browser_persistence_enable_result",
    result: "os_backed",
    durationMs: 1234,
    source: "card",
  },
  {
    name: "browser_persistence_enable_result",
    result: "keychain_denied",
    durationMs: 0,
    source: "shield",
  },
  {
    name: "browser_persistence_enable_result",
    result: "relaunch_pending",
    durationMs: 9_999_999,
    source: "settings",
  },
  {
    name: "browser_persistence_enable_result",
    result: "unavailable",
    durationMs: -5,
    source: "card",
  },
  { name: "browser_persistence_relaunch_clicked", source: "card" },
  { name: "browser_persistence_relaunch_clicked", source: "shield" },
  { name: "browser_persistence_relaunch_clicked", source: "settings" },
  {
    name: "browser_persistence_state_at_first_tile",
    reason: "os-backed",
    backend: "gnome_libsecret",
    platform: "linux",
  },
  {
    name: "browser_persistence_state_at_first_tile",
    reason: "keychain-denied",
    backend: null,
    platform: "darwin",
  },
  {
    name: "browser_persistence_state_at_first_tile",
    reason: "not-enabled",
    backend: "unknown",
    platform: "win32",
  },
  {
    name: "browser_persistence_state_at_first_tile",
    reason: "linux-basic-text",
    backend: "basic_text",
    platform: "linux",
  },
  {
    name: "browser_persistence_state_at_first_tile",
    reason: "encryption-unavailable",
    backend: "kwallet6",
    platform: "other",
  },
  {
    name: "browser_persistence_state_at_first_tile",
    reason: "unresolved",
    backend: "kwallet5",
    platform: "darwin",
  },
  { name: "browser_logins_forgotten", source: "shield" },
  { name: "browser_logins_forgotten", source: "settings" },
  { name: "browser_site_cleared", source: "tile" },
  { name: "browser_site_cleared", source: "settings" },
];

const EXPECTED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "browser_persistence_card_shown",
  "browser_persistence_card_action",
  "browser_persistence_enable_result",
  "browser_persistence_relaunch_clicked",
  "browser_persistence_state_at_first_tile",
  "browser_logins_forgotten",
  "browser_site_cleared",
]);

/** A key that would carry browsing itself rather than a state name. */
const FORBIDDEN_KEY =
  /(^|_)(cookie|domain|host|hostname|origin|site|uri|url)s?(_|$)/i;

/**
 * Anything with a scheme, a path, an `@`, or two dot-separated labels counts
 * as a hostname or URL. The funnel's own vocabulary (`os_backed`,
 * `gnome_libsecret`, `macos`) has no dots by construction, so the rule can be
 * this strict without being noisy.
 */
function looksLikeHostOrUrl(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  if (value.includes("/") || value.includes("@")) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(value);
}

function persistenceState(input: {
  readonly decision: BrowserPersistenceDecision;
  readonly reason: BrowserCookieCryptoReason;
}): BrowserPersistenceState {
  const enabled = input.reason === "os-backed";
  return {
    decision: input.decision,
    cryptoState: {
      mode: enabled ? "real" : "degraded",
      persistence: enabled ? "persistent" : "ephemeral",
      reason: input.reason,
      storageBackend: null,
      encryptionAvailable: enabled,
    },
    promptsOnEnable: true,
    appName: "Traycer",
    platform: "darwin",
  };
}

const UNDECIDED_STATE = persistenceState({
  decision: { kind: "undecided" },
  reason: "not-enabled",
});

function controllerFor(input: {
  readonly enable: (source: "card" | "settings" | "shield") => void;
  readonly decline: () => void;
}): BrowserPersistenceController {
  return {
    state: UNDECIDED_STATE,
    pending: false,
    enable: input.enable,
    decline: input.decline,
    relaunch: () => undefined,
  };
}

function card(controller: BrowserPersistenceController): ReactElement {
  return createElement(BrowserPersistenceExplainerCard, {
    persistence: controller,
    agentDriven: false,
  });
}

/** JSX-free so this suite can live in a `.ts` file next to the module it
 * covers; the hook is what is under test, not the markup. */
function Probe(props: { readonly bridge: BrowserViewBridge }): ReactElement {
  const persistence = useBrowserPersistenceState(props.bridge);
  return createElement(
    "div",
    null,
    createElement(
      "span",
      { "data-testid": "reason" },
      persistence.state?.cryptoState.reason ?? "unread",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          persistence.enable("shield");
        },
      },
      "enable",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          persistence.relaunch("shield");
        },
      },
      "relaunch",
    ),
  );
}

beforeEach(() => {
  __resetBrowserPersistenceAnalyticsForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("browser persistence analytics payloads", () => {
  it("covers every event in the typed map", () => {
    expect(new Set(ALL_EVENTS.map((event) => event.name))).toEqual(
      EXPECTED_EVENT_NAMES,
    );
  });

  it("emits state names only - never a hostname, a URL, or a site key", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();

    ALL_EVENTS.forEach((event) => {
      trackBrowserPersistence(event);
    });

    expect(track).toHaveBeenCalledTimes(ALL_EVENTS.length);
    track.mock.calls.forEach(([event, properties]) => {
      expect(EXPECTED_EVENT_NAMES.has(String(event))).toBe(true);
      // The runtime schema has to accept it too: an event the sanitizer drops
      // is a funnel that silently reports nothing.
      expect(sanitizeAnalyticsProperties(event, properties)).not.toBeNull();
      if (properties === null) return;
      const payload: Record<string, unknown> = { ...properties };
      Object.keys(payload).forEach((key) => {
        expect(FORBIDDEN_KEY.test(key)).toBe(false);
        const value = payload[key];
        if (typeof value !== "string") return;
        expect(looksLikeHostOrUrl(value)).toBe(false);
      });
    });
  });

  it("clamps a duration into the measure range rather than losing the event", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();

    trackBrowserPersistence({
      name: "browser_persistence_enable_result",
      result: "unavailable",
      durationMs: -5,
      source: "card",
    });
    trackBrowserPersistence({
      name: "browser_persistence_enable_result",
      result: "relaunch_pending",
      durationMs: 9_999_999,
      source: "card",
    });

    expect(track).toHaveBeenNthCalledWith(
      1,
      AnalyticsEvent.BrowserPersistenceEnableResult,
      { result: "unavailable", duration_ms: 0, source: "card" },
    );
    expect(track).toHaveBeenNthCalledWith(
      2,
      AnalyticsEvent.BrowserPersistenceEnableResult,
      { result: "relaunch_pending", duration_ms: 1_000_000, source: "card" },
    );
  });

  it("reports the first-tile state once per session, however many tiles ask", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const state = persistenceState({
      decision: { kind: "enabled", decidedAt: 1 },
      reason: "os-backed",
    });

    trackBrowserPersistenceStateAtFirstTile(state);
    trackBrowserPersistenceStateAtFirstTile(state);
    trackBrowserPersistenceStateAtFirstTile(state);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.BrowserPersistenceStateAtFirstTile,
      { reason: "os_backed", backend: "none", platform: "macos" },
    );
  });

  it("names the surface a forget came from", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();

    trackBrowserLoginsForgotten("settings");

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.BrowserLoginsForgotten, {
      source: "settings",
    });
  });
});

describe("explainer card funnel", () => {
  it("counts one impression per session, not one per render", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const view = render(
      card(
        controllerFor({ enable: () => undefined, decline: () => undefined }),
      ),
    );

    // A NEW controller object, so `memo` cannot bail out: this is a real
    // re-render of a card that was already on screen.
    view.rerender(
      card(
        controllerFor({ enable: () => undefined, decline: () => undefined }),
      ),
    );

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.BrowserPersistenceCardShown,
      null,
    );
  });

  it("records each button as its own action, with the card as the source", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const enable = vi.fn();
    const decline = vi.fn();
    render(card(controllerFor({ enable, decline })));

    await userEvent.click(
      screen.getByRole("button", { name: "Enable saved logins" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(track).toHaveBeenNthCalledWith(
      1,
      AnalyticsEvent.BrowserPersistenceCardShown,
      null,
    );
    expect(track).toHaveBeenNthCalledWith(
      2,
      AnalyticsEvent.BrowserPersistenceCardAction,
      { action: "enable" },
    );
    expect(track).toHaveBeenNthCalledWith(
      3,
      AnalyticsEvent.BrowserPersistenceCardAction,
      { action: "not_now" },
    );
    expect(track).toHaveBeenCalledTimes(3);
    expect(enable).toHaveBeenCalledWith("card");
    expect(decline).toHaveBeenCalledTimes(1);
  });
});

/**
 * A still clock for the funnel tests. `expect.any(Number)` is the obvious
 * matcher for `duration_ms`, but it is typed `any` and these payload literals
 * are type-checked; freezing the clock makes the duration a value the
 * assertion can name, and the SHAPE is what these tests are about.
 */
function freezeClock(): void {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
}

describe("enable funnel through the shared hook", () => {
  it("settles one result per enable, carrying the surface and a duration", async () => {
    freezeClock();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const bridge = new FakeBrowserViewBridge();
    render(createElement(Probe, { bridge }));
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("not-enabled");
    });

    await userEvent.click(screen.getByRole("button", { name: "enable" }));
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("os-backed");
    });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.BrowserPersistenceEnableResult,
      {
        result: "os_backed",
        duration_ms: 0,
        source: "shield",
      },
    );
  });

  it("reports a denial and a relaunch-pending machine as themselves", async () => {
    freezeClock();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const bridge = new FakeBrowserViewBridge();
    bridge.setEnableOutcome(
      persistenceState({
        decision: { kind: "undecided" },
        reason: "keychain-denied",
      }),
    );
    render(createElement(Probe, { bridge }));
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("not-enabled");
    });

    await userEvent.click(screen.getByRole("button", { name: "enable" }));
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("keychain-denied");
    });
    bridge.setEnableOutcome(
      persistenceState({
        decision: { kind: "relaunch-pending", decidedAt: 2 },
        reason: "keychain-denied",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "enable" }));

    await waitFor(() => {
      expect(track).toHaveBeenCalledTimes(2);
    });
    expect(track).toHaveBeenNthCalledWith(
      1,
      AnalyticsEvent.BrowserPersistenceEnableResult,
      {
        result: "keychain_denied",
        duration_ms: 0,
        source: "shield",
      },
    );
    expect(track).toHaveBeenNthCalledWith(
      2,
      AnalyticsEvent.BrowserPersistenceEnableResult,
      {
        result: "relaunch_pending",
        duration_ms: 0,
        source: "shield",
      },
    );
  });

  it("emits the relaunch click once, at the gesture", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const bridge = new FakeBrowserViewBridge();
    render(createElement(Probe, { bridge }));
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("not-enabled");
    });

    await userEvent.click(screen.getByRole("button", { name: "relaunch" }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      AnalyticsEvent.BrowserPersistenceRelaunchClicked,
      { source: "shield" },
    );
  });

  it("does not re-fire a result when another window pushes new state", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const bridge = new FakeBrowserViewBridge();
    render(createElement(Probe, { bridge }));
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("not-enabled");
    });

    await userEvent.click(screen.getByRole("button", { name: "enable" }));
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("os-backed");
    });
    bridge.emitPersistenceState(
      persistenceState({
        decision: { kind: "enabled", decidedAt: 3 },
        reason: "os-backed",
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("reason").textContent).toBe("os-backed");
    });

    expect(track).toHaveBeenCalledTimes(1);
  });
});
