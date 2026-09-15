import type { EventData, Props as JoyrideProps } from "react-joyride";
import { act } from "@testing-library/react";
import type { TourAnchor } from "@/components/onboarding/tour/tour-targets";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * Shared harness for the tour suites: the fake Joyride's recorded props, an
 * `emit` that fires events the way react-joyride 3.2 does, and DOM fixtures
 * for the surfaces the resolvers scope to. The fake Joyride itself is
 * declared by each suite's `vi.mock` (hoisting) and writes into `joyride`.
 */
export const joyride: { props: JoyrideProps | null; mounts: number } = {
  props: null,
  mounts: 0,
};

export function props(): JoyrideProps {
  if (joyride.props === null) throw new Error("Joyride not rendered");
  return joyride.props;
}

export function currentProps(): JoyrideProps {
  return props();
}

/** Fires an event the way react-joyride 3.2 would for the current step. */
export function emit(
  overrides: Partial<EventData> & { readonly type: EventData["type"] },
  from: JoyrideProps,
): void {
  const stepIndex = from.stepIndex ?? 0;
  const step = from.steps.at(stepIndex);
  if (step === undefined) throw new Error("no step at index");
  const data: EventData = {
    type: overrides.type,
    action: overrides.action ?? "update",
    status: overrides.status ?? "running",
    lifecycle: overrides.lifecycle ?? "tooltip",
    index: overrides.index ?? stepIndex,
    size: from.steps.length,
    origin: overrides.origin ?? null,
    controlled: true,
    scrolling: false,
    waiting: false,
    error: null,
    scroll: null,
    step: overrides.step ?? {
      ...step,
      arrowBase: 32,
      arrowColor: "#fff",
      arrowSize: 16,
      arrowSpacing: 12,
      backgroundColor: "#fff",
      beaconSize: 36,
      beaconTrigger: "click",
      beforeTimeout: 5000,
      buttons: ["primary", "skip", "close"],
      closeButtonAction: "close",
      skipBeacon: true,
      dismissKeyAction: "close",
      disableFocusTrap: true,
      hideOverlay: false,
      skipScroll: false,
      blockTargetInteraction: false,
      isFixed: false,
      loaderDelay: 300,
      locale: {},
      offset: 10,
      overlayClickAction: false,
      overlayColor: "#000",
      placement: step.placement ?? "bottom",
      primaryColor: "#000",
      scrollDuration: 300,
      scrollOffset: 20,
      showProgress: false,
      spotlightRadius: 8,
      targetWaitTimeout: 1500,
      textColor: "#000",
      zIndex: 45,
      spotlightPadding: { top: 8, right: 8, bottom: 8, left: 8 },
      styles: {
        arrow: {},
        beacon: {},
        beaconInner: {},
        beaconOuter: {},
        beaconWrapper: {},
        buttonBack: {},
        buttonClose: {},
        buttonPrimary: {},
        buttonSkip: {},
        floater: {},
        loader: {},
        overlay: {},
        spotlight: {},
        tooltip: {},
        tooltipContainer: {},
        tooltipContent: {},
        tooltipFooter: {},
        tooltipFooterSpacer: {},
        tooltipTitle: {},
      },
    },
  };
  act(() => {
    from.onEvent?.(data, {
      close: () => undefined,
      go: () => undefined,
      info: () => {
        throw new Error("unused");
      },
      next: () => undefined,
      open: () => undefined,
      prev: () => undefined,
      replay: () => undefined,
      reset: () => undefined,
      skip: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    });
  });
}

/** A DOM change plus the microtask the MutationObserver delivers on. */
export async function mutate(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

export function next(): void {
  emit(
    { type: "step:after", action: "next", origin: "button_primary" },
    currentProps(),
  );
}

export function present(): void {
  emit({ type: "tooltip" }, currentProps());
}

// ── DOM fixtures ────────────────────────────────────────────────────────────

export function sized(element: HTMLElement): HTMLElement {
  element.getBoundingClientRect = () => new DOMRect(10, 10, 120, 32);
  return element;
}

export interface Surface {
  readonly root: HTMLElement;
  readonly anchors: Readonly<Partial<Record<string, HTMLElement>>>;
  readonly remove: () => void;
}

export function mountDraftSurface(
  draftId: string,
  anchors: ReadonlyArray<TourAnchor>,
  visible: boolean,
): Surface {
  const surface = document.createElement("div");
  surface.setAttribute("data-surface-ref", `draft:${draftId}`);
  surface.setAttribute("data-visible", visible ? "true" : "false");
  const root = sized(document.createElement("div"));
  root.setAttribute("data-testid", "landing-draft-surface");
  surface.append(root);
  const made: Partial<Record<string, HTMLElement>> = {};
  for (const anchor of anchors) {
    const node = sized(document.createElement("button"));
    node.setAttribute("data-tour", anchor);
    node.textContent = anchor;
    root.append(node);
    made[anchor] = node;
  }
  document.body.append(surface);
  return {
    root,
    anchors: made,
    remove: () => {
      surface.remove();
    },
  };
}

export function mountEpicSurface(tabId: string, collapsed: boolean): Surface {
  const surface = document.createElement("div");
  surface.setAttribute("data-surface-ref", `epic:${tabId}`);
  surface.setAttribute("data-visible", "true");
  const root = sized(document.createElement("div"));
  root.setAttribute("data-epic-surface", tabId);
  surface.append(root);
  const column = sized(document.createElement("div"));
  column.setAttribute("data-tour", "epic-sidebar-column");
  const rail = sized(document.createElement("div"));
  rail.setAttribute("data-tour", "epic-sidebar-rail");
  if (collapsed) column.hidden = true;
  root.append(column, rail);
  document.body.append(surface);
  return {
    root,
    anchors: { column, rail },
    remove: () => {
      surface.remove();
    },
  };
}

export function focusDraftTab(draftId: string): void {
  const ref = { kind: "draft" as const, id: draftId };
  useTabsStore.setState({
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    stripOrder: [ref],
  });
}

export function focusEpicTab(tabId: string, epicId: string): void {
  const ref = { kind: "epic" as const, id: tabId };
  useEpicCanvasStore.setState({
    tabsById: { [tabId]: { tabId, epicId, name: "Epic" } },
    openTabOrder: [tabId],
    activeTabId: tabId,
    mostRecentTabIdByEpicId: { [epicId]: tabId },
  });
  useTabsStore.setState({
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    stripOrder: [ref],
  });
}
