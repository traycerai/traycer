import "../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";

const platformMock = vi.hoisted(() => ({ mac: false }));

vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

import { createMemoryHistory } from "@tanstack/react-router";
import { createAppRouter, type AppRouter } from "@/router";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import type { KeybindingRouterSource } from "@/lib/keybindings/router-adapter";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import {
  useCanvasTabLeaderModifierForIndex,
  useLeaderState,
  usePickerProfileLeaderForIndex,
  usePickerProviderLeaderForIndex,
  usePickerReasoningLeaderForIndex,
  useTabLeaderModifierForIndex,
} from "@/providers/keybinding-context";
import { usePickerLeaderScope } from "@/components/home/pickers/use-picker-leader-scope";
import type { ReasoningFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import type { ReactNode } from "react";
import type { ProviderId } from "@/components/home/data/landing-options";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

const LEADER_HINT_DELAY_MS = 300;

interface SeededTabs {
  readonly firstTabId: string;
  readonly secondTabId: string;
  readonly thirdTabId: string;
}

interface MutableRouterSource {
  readonly router: KeybindingRouterSource;
  readonly setPathname: (pathname: string) => void;
}

function LeaderProbe() {
  const leader = useLeaderState();
  const tabLeader = useTabLeaderModifierForIndex(0);
  const canvasLeader = useCanvasTabLeaderModifierForIndex(0, true);
  return (
    <div
      data-testid="leader-probe"
      data-mod-held={String(leader.modHeld)}
      data-alt-held={String(leader.altHeld)}
      data-mod-owner={leader.modOwnerScopeId ?? ""}
      data-alt-owner={leader.altOwnerScopeId ?? ""}
      data-pathname={leader.pathname}
      data-tab-leader={tabLeader ?? ""}
      data-canvas-leader={canvasLeader ?? ""}
    />
  );
}

function renderProbe(initialRoute: string): AppRouter {
  const router = createAppRouter(normalizeProbeRoute(initialRoute), null);
  renderProbeWithRouter(router);
  return router;
}

function renderProbeWithRouter(router: KeybindingRouterSource): void {
  renderProbeWithExtra(router, null);
}

function renderProbeWithExtra(
  router: KeybindingRouterSource,
  extra: ReactNode | null,
): void {
  render(
    <KeybindingProvider router={router}>
      <LeaderProbe />
      {extra}
    </KeybindingProvider>,
  );
}

function buildMutableRouterSource(
  initialPathname: string,
): MutableRouterSource {
  // A real (unbranded) memory history so the source satisfies the widened
  // `KeybindingRouterSource.history: RouterHistory`. Carrying no controller
  // brand keeps in-app history nav inert here, which these leader-hint tests
  // do not exercise.
  const history = createMemoryHistory({
    initialEntries: [normalizeProbeRoute(initialPathname)],
  });
  const navigate: KeybindingRouterSource["navigate"] = () => Promise.resolve();
  return {
    router: {
      get state() {
        return { location: { pathname: history.location.pathname } };
      },
      history,
      navigate,
    },
    setPathname: (next) => {
      history.push(next);
    },
  };
}

function normalizeProbeRoute(initialRoute: string): string {
  if (initialRoute !== "/epics/e1") return initialRoute;
  const existing = useEpicCanvasStore
    .getState()
    .openTabOrder.map((tabId) => useEpicCanvasStore.getState().tabsById[tabId])
    .find((tab) => tab?.epicId === "e1");
  const tabId = existing?.tabId ?? seedEpicTabs().firstTabId;
  return `/epics/e1/${tabId}`;
}

function probe(): HTMLElement {
  return screen.getByTestId("leader-probe");
}

function expectModHintVisible(visible: boolean): void {
  expect(probe().getAttribute("data-mod-held")).toBe(String(visible));
  expect(probe().getAttribute("data-canvas-leader")).toBe(visible ? "mod" : "");
}

function expectAltHintVisible(visible: boolean): void {
  expect(probe().getAttribute("data-alt-held")).toBe(String(visible));
}

function expectTaskTabHintsVisible(visible: boolean): void {
  expect(probe().getAttribute("data-mod-held")).toBe(String(visible));
  expect(probe().getAttribute("data-alt-held")).toBe(String(visible));
  expect(probe().getAttribute("data-mod-owner")).toBe(
    visible ? "canvas-tabs" : "",
  );
  expect(probe().getAttribute("data-alt-owner")).toBe(
    visible ? "header-tabs" : "",
  );
  expect(probe().getAttribute("data-canvas-leader")).toBe(visible ? "mod" : "");
  expect(probe().getAttribute("data-tab-leader")).toBe(visible ? "alt" : "");
}

function testProfile(profileId: string, label: string): ProviderProfile {
  return {
    profileId,
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

const NOOP_PROFILE_CHANGE = (): void => undefined;

function PickerReasoningScopeProbe(props: {
  readonly reasoningActionable: boolean;
}) {
  const reasoning: ReasoningFooterConfig = {
    value: "low",
    options: [{ id: "low", label: "Low", description: null }],
    disabled: false,
    onChange: () => undefined,
  };
  usePickerLeaderScope({
    open: true,
    railEntries: [],
    onEntryChange: () => undefined,
    reasoning,
    reasoningActionable: props.reasoningActionable,
    activeProviderId: "codex",
    activeProviderProfiles: [],
    onProfileChange: NOOP_PROFILE_CHANGE,
  });
  return null;
}

// Registers the model-picker leader scope AND renders the real badge consumers
// (`usePickerProviderLeaderForIndex` / `usePickerReasoningLeaderForIndex` /
// `usePickerProfileLeaderForIndex`) so a test can assert exactly which surface
// lights up, not just the raw leader state.
function PickerBadgeProbe(props: {
  readonly reasoningActionable: boolean;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly onProfileChange: (
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
}) {
  const reasoning: ReasoningFooterConfig = {
    value: "low",
    options: [{ id: "low", label: "Low", description: null }],
    disabled: false,
    onChange: () => undefined,
  };
  usePickerLeaderScope({
    open: true,
    railEntries: [],
    onEntryChange: () => undefined,
    reasoning,
    reasoningActionable: props.reasoningActionable,
    activeProviderId: "codex",
    activeProviderProfiles: props.profiles,
    onProfileChange: props.onProfileChange,
  });
  const providerLeader = usePickerProviderLeaderForIndex(0);
  const reasoningLeader = usePickerReasoningLeaderForIndex(0);
  const profileLeader = usePickerProfileLeaderForIndex(0);
  return (
    <div
      data-testid="picker-badge-probe"
      data-provider-leader={providerLeader ?? ""}
      data-reasoning-leader={reasoningLeader ?? ""}
      data-profile-leader={profileLeader ?? ""}
    />
  );
}

function pickerProbe(): HTMLElement {
  return screen.getByTestId("picker-badge-probe");
}

function dispatchKeyboard(
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

function keyDown(init: KeyboardEventInit): KeyboardEvent {
  return dispatchKeyboard("keydown", init);
}

function keyUp(init: KeyboardEventInit): KeyboardEvent {
  return dispatchKeyboard("keyup", init);
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

function seedEpicTabCount(count: number): ReadonlyArray<string> {
  resetStores();
  const tabIds = Array.from({ length: count }, (_, index) =>
    useEpicCanvasStore
      .getState()
      .openEpicTab(`e${index + 1}`, `Epic ${index + 1}`),
  );
  useEpicCanvasStore.getState().setActiveTab(tabIds[0]);
  useTabsStore.setState((state) => ({
    ...state,
    stripOrder: useEpicCanvasStore
      .getState()
      .openTabOrder.map((id) => ({ kind: "epic", id })),
  }));
  return tabIds;
}

function seedEpicTabs(): SeededTabs {
  const tabIds = seedEpicTabCount(3);
  return {
    firstTabId: tabIds[0],
    secondTabId: tabIds[1],
    thirdTabId: tabIds[2],
  };
}

describe("<KeybindingProvider /> visual leader hints", () => {
  beforeEach(() => {
    platformMock.mac = false;
    vi.useFakeTimers();
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits for the hold delay before publishing primary leader hints", () => {
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });

    expectModHintVisible(false);
    advance(LEADER_HINT_DELAY_MS - 1);
    expectModHintVisible(false);
    advance(1);
    expectModHintVisible(true);
  });

  it("does not treat bare macOS Control as the primary leader", () => {
    platformMock.mac = true;
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "ControlLeft", key: "Control", ctrlKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(false);

    act(() => {
      keyUp({ code: "ControlLeft", key: "Control" });
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(true);
  });

  it("does not reserve macOS Control chords as plain key bindings", () => {
    platformMock.mac = true;
    useKeybindingStore.setState({
      bindings: { ...getDefaultBindings(), "app.palette.open": "k" },
    });
    renderProbe("/epics/e1");

    const event = keyDown({ code: "KeyK", key: "k", ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it("still reserves macOS Control-specific provider chords", () => {
    platformMock.mac = true;
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    renderProbe("/epics/e1");

    const event = keyDown({
      code: "KeyM",
      key: "m",
      ctrlKey: true,
      altKey: true,
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it("dispatches repeat-sensitive toggles once per physical press", () => {
    renderProbe("/epics/e1");
    const calls: Array<string> = [];
    const unregister = registerDynamicActionHandler(
      "app.terminal.maximize",
      () => calls.push("maximize"),
    );

    const first = keyDown({
      code: "KeyJ",
      key: "j",
      metaKey: true,
      altKey: true,
    });
    const repeated = keyDown({
      code: "KeyJ",
      key: "j",
      metaKey: true,
      altKey: true,
      repeat: true,
    });
    unregister();

    // One dispatch per physical press: the OS repeat is swallowed, but the
    // chord stays reserved so the browser default can't run on it either.
    expect(calls).toHaveLength(1);
    expect(first.defaultPrevented).toBe(true);
    expect(repeated.defaultPrevented).toBe(true);
  });

  it("shows both task-tab leader bindings when either leader is held", () => {
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectTaskTabHintsVisible(true);

    act(() => {
      keyUp({ code: "MetaLeft", key: "Meta" });
    });
    expectTaskTabHintsVisible(false);

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectTaskTabHintsVisible(true);
  });

  it("does not reveal hints when the leader is released before the delay", () => {
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS - 1);
    act(() => {
      keyUp({ code: "MetaLeft", key: "Meta" });
    });
    advance(1);

    expectModHintVisible(false);
  });

  it("suppresses hints after a normal shortcut until the leader is released", () => {
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
      keyDown({ code: "KeyK", key: "k", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(false);

    act(() => {
      keyUp({ code: "KeyK", key: "k", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(false);

    act(() => {
      keyUp({ code: "MetaLeft", key: "Meta" });
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(true);
  });

  it("suppresses hints after mixed modifiers until all leaders are released", () => {
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
      keyDown({
        code: "AltLeft",
        key: "Alt",
        metaKey: true,
        altKey: true,
      });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(false);

    act(() => {
      keyUp({ code: "AltLeft", key: "Alt", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(false);

    act(() => {
      keyUp({ code: "MetaLeft", key: "Meta" });
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(true);
  });

  it("dispatches header digit navigation instantly without revealing pending hints", () => {
    const tabs = seedEpicTabs();
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
      keyDown({ code: "Digit2", key: "2", altKey: true });
    });

    expect(useEpicCanvasStore.getState().activeTabId).toBe(tabs.secondTabId);
    expectAltHintVisible(false);
    advance(LEADER_HINT_DELAY_MS);
    expectAltHintVisible(false);
  });

  it("dispatches multi-digit header tab navigation while the leader is held", () => {
    const tabIds = seedEpicTabCount(12);
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
      keyDown({ code: "Digit1", key: "1", altKey: true });
      keyDown({ code: "Digit2", key: "2", altKey: true });
    });

    expect(useEpicCanvasStore.getState().activeTabId).toBe(tabIds[11]);
    expectAltHintVisible(false);
  });

  it("commits ambiguous single-digit header tab navigation when the leader is released", () => {
    const tabIds = seedEpicTabCount(12);
    useEpicCanvasStore.getState().setActiveTab(tabIds[2]);
    renderProbe("/epics/e3");

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
      keyDown({ code: "Digit1", key: "1", altKey: true });
    });

    expect(useEpicCanvasStore.getState().activeTabId).toBe(tabIds[2]);

    act(() => {
      keyUp({ code: "Digit1", key: "1", altKey: true });
      keyUp({ code: "AltLeft", key: "Alt" });
    });

    expect(useEpicCanvasStore.getState().activeTabId).toBe(tabIds[0]);
  });

  it("hides visible header hints after valid and out-of-range digit attempts", () => {
    const tabs = seedEpicTabs();
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectAltHintVisible(true);

    act(() => {
      keyDown({ code: "Digit2", key: "2", altKey: true });
    });
    expect(useEpicCanvasStore.getState().activeTabId).toBe(tabs.secondTabId);
    expectAltHintVisible(false);

    act(() => {
      keyUp({ code: "Digit2", key: "2", altKey: true });
      keyUp({ code: "AltLeft", key: "Alt" });
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectAltHintVisible(true);

    act(() => {
      keyDown({ code: "Digit8", key: "8", altKey: true });
    });
    expectAltHintVisible(false);
  });

  it("hides visible hints when a non-digit leader chord is pressed", () => {
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(true);

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyK",
      key: "k",
      metaKey: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expectModHintVisible(false);
  });

  it("clears pending timers and visible hints on window blur", () => {
    renderProbe("/epics/e1");

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
      window.dispatchEvent(new Event("blur"));
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(false);

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(true);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expectModHintVisible(false);
  });

  it("publishes sub-leader hints only on settings routes", () => {
    renderProbe("/settings/general");

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectAltHintVisible(true);
  });

  it("lights only the provider rail while ⌘ is held with the picker open", () => {
    const router = createAppRouter("/epics/e1", null);
    render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerBadgeProbe
          reasoningActionable
          profiles={[]}
          onProfileChange={NOOP_PROFILE_CHANGE}
        />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);

    // Rail (⌘) badges light up; reasoning (⌥) and profile (⌘⇧) badges stay
    // hidden even though the same picker scope owns all three dimensions.
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("mod");
    expect(pickerProbe().getAttribute("data-reasoning-leader")).toBe("");
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("");
    expect(probe().getAttribute("data-mod-owner")).toBe("model-picker");
    expect(probe().getAttribute("data-alt-held")).toBe("false");
    expect(probe().getAttribute("data-alt-owner")).toBe("");
  });

  it("lights only the reasoning footer while ⌥ is held with the picker open", () => {
    const router = createAppRouter("/epics/e1", null);
    render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerBadgeProbe
          reasoningActionable
          profiles={[]}
          onProfileChange={NOOP_PROFILE_CHANGE}
        />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);

    // Reasoning (⌥) badges light up; rail (⌘) and profile (⌘⇧) badges stay
    // hidden.
    expect(pickerProbe().getAttribute("data-reasoning-leader")).toBe("alt");
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("");
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("");
    expect(probe().getAttribute("data-alt-owner")).toBe("model-picker");
    expect(probe().getAttribute("data-mod-held")).toBe("false");
    expect(probe().getAttribute("data-mod-owner")).toBe("");
  });

  it("lights only the profile dropdown while ⌘⇧ is held with 2+ profiles", () => {
    const router = createAppRouter("/epics/e1", null);
    const onProfileChange = vi.fn();
    render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerBadgeProbe
          reasoningActionable
          profiles={[testProfile("a-uuid", "A"), testProfile("b-uuid", "B")]}
          onProfileChange={onProfileChange}
        />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      });
      keyDown({
        code: "ShiftLeft",
        key: "Shift",
        metaKey: true,
        shiftKey: true,
      });
    });
    advance(LEADER_HINT_DELAY_MS);

    // Profile (⌘⇧) badges light up; rail (⌘) and reasoning (⌥) badges stay
    // hidden even though the same picker scope owns all three dimensions -
    // this is the shifted hint pass `resolveLeaderOwner` used to skip
    // entirely.
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("modShift");
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("");
    expect(pickerProbe().getAttribute("data-reasoning-leader")).toBe("");

    act(() => {
      keyDown({
        code: "Digit2",
        key: "2",
        metaKey: true,
        shiftKey: true,
      });
    });

    expect(onProfileChange).toHaveBeenCalledWith("codex", "b-uuid");
  });

  it("shows no profile hint while ⌘⇧ is held under 2 profiles - progressive disclosure", () => {
    const router = createAppRouter("/epics/e1", null);
    render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerBadgeProbe
          reasoningActionable
          profiles={[testProfile("a-uuid", "A")]}
          onProfileChange={NOOP_PROFILE_CHANGE}
        />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      });
      keyDown({
        code: "ShiftLeft",
        key: "Shift",
        metaKey: true,
        shiftKey: true,
      });
    });
    advance(LEADER_HINT_DELAY_MS);

    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("");
  });

  it("transitions visible profile hints to rail hints when Shift is released while ⌘ stays held", () => {
    const router = createAppRouter("/epics/e1", null);
    render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerBadgeProbe
          reasoningActionable
          profiles={[testProfile("a-uuid", "A"), testProfile("b-uuid", "B")]}
          onProfileChange={NOOP_PROFILE_CHANGE}
        />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      });
      keyDown({
        code: "ShiftLeft",
        key: "Shift",
        metaKey: true,
        shiftKey: true,
      });
    });
    advance(LEADER_HINT_DELAY_MS);
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("modShift");

    // Shift released, Cmd stays down - the session was already VISIBLE, so
    // this swaps to the rail's hints instantly (no re-wait for the hold delay).
    act(() => {
      keyUp({ code: "ShiftLeft", key: "Shift", metaKey: true });
    });

    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("");
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("mod");
    expect(probe().getAttribute("data-mod-owner")).toBe("model-picker");
  });

  it("restarts the hold delay for a pending profile session when Shift is released before it reveals", () => {
    const router = createAppRouter("/epics/e1", null);
    render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerBadgeProbe
          reasoningActionable
          profiles={[testProfile("a-uuid", "A"), testProfile("b-uuid", "B")]}
          onProfileChange={NOOP_PROFILE_CHANGE}
        />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      });
      keyDown({
        code: "ShiftLeft",
        key: "Shift",
        metaKey: true,
        shiftKey: true,
      });
    });
    // Still pending - the 300ms delay hasn't elapsed, so nothing is visible yet.
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("");
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("");

    act(() => {
      keyUp({ code: "ShiftLeft", key: "Shift", metaKey: true });
    });
    // Transitioned to a NEW pending session for `mod` - still nothing visible
    // immediately, and the OLD modShift timer must not fire late.
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("");
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("");

    advance(LEADER_HINT_DELAY_MS);
    // The new `mod` pending session reveals - rail hints, never the stale
    // profile hints from the released combo.
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("mod");
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("");
  });

  it("transitions visible rail hints to profile hints instantly when Shift is added while ⌘ stays held", () => {
    const router = createAppRouter("/epics/e1", null);
    render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerBadgeProbe
          reasoningActionable
          profiles={[testProfile("a-uuid", "A"), testProfile("b-uuid", "B")]}
          onProfileChange={NOOP_PROFILE_CHANGE}
        />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("mod");

    // Shift added while Cmd stays down - the session was already VISIBLE, so
    // this swaps to the profile dropdown's hints instantly, with no additional
    // 300ms wait (the symmetric case of the release direction above).
    act(() => {
      keyDown({
        code: "ShiftLeft",
        key: "Shift",
        metaKey: true,
        shiftKey: true,
      });
    });

    expect(pickerProbe().getAttribute("data-provider-leader")).toBe("");
    expect(pickerProbe().getAttribute("data-profile-leader")).toBe("modShift");
  });

  it("falls back to header sub-leader hints when picker reasoning becomes inactive", () => {
    const router = createAppRouter("/epics/e1", null);
    const view = render(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerReasoningScopeProbe reasoningActionable />
      </KeybindingProvider>,
    );

    act(() => {
      keyDown({ code: "AltLeft", key: "Alt", altKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectAltHintVisible(true);
    expect(probe().getAttribute("data-alt-owner")).toBe("model-picker");

    view.rerender(
      <KeybindingProvider router={router}>
        <LeaderProbe />
        <PickerReasoningScopeProbe reasoningActionable={false} />
      </KeybindingProvider>,
    );

    expectAltHintVisible(true);
    expect(probe().getAttribute("data-alt-owner")).toBe("header-tabs");
  });

  it("hides visible canvas hints when route changes out of Epic scope", () => {
    const mutable = buildMutableRouterSource("/epics/e1");
    renderProbeWithRouter(mutable.router);

    act(() => {
      keyDown({ code: "MetaLeft", key: "Meta", metaKey: true });
    });
    advance(LEADER_HINT_DELAY_MS);
    expectModHintVisible(true);

    act(() => {
      mutable.setPathname("/settings/general");
    });

    expectModHintVisible(false);
    expect(probe().getAttribute("data-pathname")).toBe("/settings/general");
  });
});
