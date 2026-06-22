import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { Route as IndexRoute } from "@/routes/index";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useTabsStore } from "@/stores/tabs/store";

const draftRouteMocks = vi.hoisted(() => ({
  openNewEpicDraft: vi.fn(() => "draft-created"),
  navigateToTabIntent: vi.fn(),
}));

vi.mock("@/lib/commands/actions/new-epic", () => ({
  openNewEpicDraft: draftRouteMocks.openNewEpicDraft,
}));

vi.mock("@/lib/tab-navigation", () => ({
  draftTabIntent: (draftId: string) => ({ kind: "draft", draftId }),
  navigateToTabIntent: draftRouteMocks.navigateToTabIntent,
}));

function invokeIndexBeforeLoad(status: string): unknown {
  const beforeLoad = IndexRoute.options.beforeLoad;
  expect(beforeLoad).toBeTypeOf("function");
  const invoke = beforeLoad as (args: {
    context: { getAuthSnapshot: () => { status: string } };
  }) => void;
  try {
    invoke({ context: { getAuthSnapshot: () => ({ status }) } });
    return null;
  } catch (err) {
    return err;
  }
}

describe("draft entry routes", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabsStore.setState({
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
    // Default to "tour completed" so signed-in cases exercise the app path;
    // the first-launch case overrides this explicitly.
    useOnboardingStore.setState({ completedAt: 1 });
  });

  it("/ redirects signed-in users (tour done, no restored tabs) to the committed draft creation route", () => {
    const thrown = invokeIndexBeforeLoad("signed-in");
    expect(thrown).not.toBeNull();
    expect(isRedirect(thrown)).toBe(true);
    const response = thrown as Response & {
      options: { to: string; replace: boolean };
    };
    expect(response.options.to).toBe("/draft/new");
    expect(response.options.replace).toBe(true);
  });

  it("/ keeps signed-in users on root when tabs have already been restored", () => {
    useTabsStore.setState({
      stripOrder: [{ kind: "history", id: "history" }],
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: null,
        },
        settings: null,
      },
    });
    expect(invokeIndexBeforeLoad("signed-in")).toBeNull();
  });

  it("/ sends a signed-in user with no restored tabs to /draft/new (onboarding is gated in RootComponent)", () => {
    useOnboardingStore.setState({ completedAt: null });

    const thrown = invokeIndexBeforeLoad("signed-in");
    expect(thrown).not.toBeNull();
    expect(isRedirect(thrown)).toBe(true);
    const response = thrown as Response & {
      options: { to: string; replace: boolean };
    };
    expect(response.options.to).toBe("/draft/new");
    expect(response.options.replace).toBe(true);
  });

  it("/ keeps signed-out users on the auth landing surface", () => {
    useOnboardingStore.setState({ completedAt: null });
    expect(invokeIndexBeforeLoad("signed-out")).toBeNull();
  });

  it("/draft/new creates a draft and replaces itself with the real draft route", async () => {
    const { createDraftAndReplaceRoute } =
      await import("@/lib/draft-entry-route");
    const navigate = vi.fn();

    createDraftAndReplaceRoute(navigate);

    expect(draftRouteMocks.openNewEpicDraft).toHaveBeenCalledTimes(1);
    expect(draftRouteMocks.navigateToTabIntent).toHaveBeenCalledWith(
      navigate,
      { kind: "draft", draftId: "draft-created" },
      { replace: true },
    );
  });
});
