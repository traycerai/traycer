import { readFileSync } from "node:fs";
import path from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingTour } from "@/components/onboarding/tour/onboarding-tour";
import { resetTourDismissalForTests } from "@/components/onboarding/tour/use-onboarding-tour-controller";
import { resetModalPresenceForTests } from "@/components/ui/modal-presence";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  INITIAL_FLOW,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";
import { useLandingReceiptsStore } from "@/stores/onboarding/landing-receipts-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * The REAL react-joyride 3.2 rendering the tour in jsdom: the exported
 * component's props reach the library, the custom card is what presents
 * (with the accessibility it sets by hand), the primitive buttons drive the
 * flow store through the adapter, and the reduced-motion settings land on
 * the floater. Geometry and hit-testing are the spike's (headless Chrome)
 * and the Mac checklist's; jsdom has no layout.
 */

const reducedMotion = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => reducedMotion.value };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
}));

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: { getInstance: () => ({ track: () => undefined }) },
  };
});

const DRAFT_ID = "draft-real";

const INDEX_CSS = readFileSync(
  path.resolve(__dirname, "../../../../index.css"),
  "utf8",
);

/**
 * The `pointer-events: none` rule that lets clicks through the dim, as
 * authored in `index.css` (jsdom cannot hit-test; the rule and the DOM it
 * targets are pinned separately and joined by the selector).
 */
function overlayPathRule(): { selector: string; body: string } | null {
  for (const match of INDEX_CSS.matchAll(
    /([^{}]*react-joyride__spotlight path[^{}]*)\{([^}]*)\}/g,
  )) {
    const body = match[2];
    if (/pointer-events\s*:\s*none\s*!important/.test(body)) {
      return { selector: match[1].trim(), body };
    }
  }
  return null;
}

function mountAnchor(): HTMLElement {
  const surface = document.createElement("div");
  surface.setAttribute("data-surface-ref", `draft:${DRAFT_ID}`);
  surface.setAttribute("data-visible", "true");
  const root = document.createElement("div");
  root.setAttribute("data-testid", "landing-draft-surface");
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  for (const [tour, label] of [
    ["landing-folder-add", "Add folder"],
    ["landing-terminal-switch", "Switch to Terminal"],
  ] as const) {
    const anchor = document.createElement("button");
    anchor.setAttribute("data-tour", tour);
    anchor.textContent = label;
    anchor.getBoundingClientRect = () => new DOMRect(20, 20, 120, 32);
    root.append(anchor);
  }
  surface.append(root);
  document.body.append(surface);
  return surface;
}

function flow() {
  return useOnboardingFlowStore.getState();
}

let surface: HTMLElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  reducedMotion.value = false;
  resetTourDismissalForTests();
  resetModalPresenceForTests();
  useOnboardingFlowStore.setState({ ...INITIAL_FLOW });
  useLandingReceiptsStore.getState().reset();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  if (typeof Element.prototype.checkVisibility !== "function") {
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value: () => true,
    });
  }
  useLandingDraftStore.getState().createDraftWithId(DRAFT_ID, null);
  const ref = { kind: "draft" as const, id: DRAFT_ID };
  useTabsStore.setState({
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    stripOrder: [ref],
  });
  surface = mountAnchor();
});

afterEach(() => {
  cleanup();
  surface?.remove();
  surface = null;
  document.getElementById("react-joyride-portal")?.remove();
});

async function startAndPresent(): Promise<HTMLElement> {
  render(<OnboardingTour />);
  act(() => {
    flow().finishModal("no-sessions");
    flow().setContext({ draftId: DRAFT_ID });
  });
  return screen.findByTestId("onboarding-tour-card");
}

describe("<OnboardingTour /> with the real react-joyride", () => {
  it("presents the custom card as a non-modal labelled dialog with Next / Skip / Pause tour, and takes no focus", async () => {
    const card = await startAndPresent();
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-modal")).toBe("false");
    expect(
      document.getElementById(card.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Add a workspace folder");
    expect(
      document.getElementById(card.getAttribute("aria-describedby") ?? ""),
    ).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Skip" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Pause tour" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByTestId("onboarding-tour-step-count").textContent).toBe(
      "1 of 4",
    );
    expect(document.getElementById("react-joyride-portal")).not.toBeNull();
    expect(document.querySelector('[data-testid="overlay"]')).not.toBeNull();
    // No focus trap and no autofocus: presenting leaves focus where it was.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(card.contains(document.activeElement)).toBe(false);
    expect(screen.getByTestId("onboarding-tour-live").textContent).toContain(
      "Step 1 of 4",
    );
  });

  it("Next advances the flow through the adapter (keyboard Next focuses the next card); Skip ends it; Esc pauses it", async () => {
    await startAndPresent();
    // `fireEvent.click` is a `detail: 0` activation, i.e. keyboard.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(flow().activeTourId).toBe("terminal-mode");
    });
    expect(flow().tours["add-folder"].status).toBe("done");
    const nextCard = await screen.findByTestId("onboarding-tour-card");
    await waitFor(() => {
      expect(nextCard.getAttribute("data-tour-step")).toBe("terminal-mode");
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(nextCard);
    });
    expect(screen.getByTestId("onboarding-tour-step-count").textContent).toBe(
      "2 of 4",
    );
    expect(flow().chain).toBe("active");

    act(() => {
      flow().replayTour("add-folder");
      flow().setContext({ draftId: DRAFT_ID });
    });
    const replayed = await screen.findByTestId("onboarding-tour-card");
    expect(replayed.getAttribute("data-tour-step")).toBe("add-folder");
    expect(screen.getByTestId("onboarding-tour-step-count").textContent).toBe(
      "1 of 1",
    );
    expect(screen.getByRole("button", { name: "Finish" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => {
      expect(flow().chain).toBe("skipped");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("onboarding-tour-card")).toBeNull();
    });

    act(() => {
      flow().replayTour("add-folder");
      flow().setContext({ draftId: DRAFT_ID });
    });
    await screen.findByTestId("onboarding-tour-card");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(flow().chain).toBe("paused");
    });
    expect(flow().activeTourId).toBe("add-folder");
  });

  it("the dim never swallows a click: the overlay path Joyride paints with inline pointer-events:auto is matched by the index.css rule that turns it off (B1)", async () => {
    await startAndPresent();
    const overlayPath = await waitFor(() => {
      const found = document.querySelector<SVGPathElement>(
        '[data-testid="spotlight"] path',
      );
      if (found === null) throw new Error("overlay path not painted yet");
      return found;
    });
    // Upstream's inline style - the reason a stylesheet rule with
    // `!important` is the only thing that can reach it.
    expect(overlayPath.style.pointerEvents).toBe("auto");
    const rule = overlayPathRule();
    expect(rule).not.toBeNull();
    expect(rule?.selector).toContain("#react-joyride-portal");
    expect(overlayPath.matches(rule?.selector ?? "")).toBe(true);
    // And the tour itself still treats an outside click as a no-op.
    expect(flow().activeTourId).toBe("add-folder");
  });

  it("an unbound panels lesson presents 'Open a task to continue.' with an Open latest task button that survives Joyride's step merge (B6)", async () => {
    const root = surface?.querySelector<HTMLElement>(
      '[data-testid="landing-draft-surface"]',
    );
    if (root === null || root === undefined) throw new Error("no root");
    const list = document.createElement("ul");
    list.setAttribute("data-tour", "landing-history");
    list.getBoundingClientRect = () => new DOMRect(0, 100, 600, 400);
    const row = document.createElement("li");
    row.setAttribute("data-epic-id", "epic-latest");
    row.getBoundingClientRect = () => new DOMRect(0, 100, 600, 40);
    list.append(row);
    root.append(list);
    render(<OnboardingTour />);
    act(() => {
      flow().finishModal("sessions");
      flow().setContext({ draftId: DRAFT_ID });
      flow().advance("history", "history", "next");
    });
    expect(flow().activeTourId).toBe("task-panels");
    const card = await screen.findByTestId("onboarding-tour-card");
    expect(card.getAttribute("data-tour-step")).toBe("task-panels");
    expect(
      document.getElementById(card.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Open a task to continue.");
    expect(
      screen.getByRole("button", { name: "Open latest task" }),
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="overlay"]')).toBeNull();
  });

  it("under reduced motion the floater and overlay carry no transition and scrolling is instant", async () => {
    reducedMotion.value = true;
    await startAndPresent();
    const floater = document.querySelector<HTMLElement>(
      ".react-joyride__floater",
    );
    const overlay = document.querySelector<HTMLElement>(
      ".react-joyride__overlay",
    );
    expect(floater?.style.transition).toBe("none");
    expect(overlay?.style.transition).toBe("none");
  });
});
