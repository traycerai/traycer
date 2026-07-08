import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  createDraftAndReplaceRoute: vi.fn(),
}));

vi.mock("@/lib/draft-entry-route", () => ({
  createDraftAndReplaceRoute: mocks.createDraftAndReplaceRoute,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

import { DraftNewRoute } from "@/routes/draft-new-route-components";

function renderGated(hasHydrated: boolean) {
  return render(
    <WindowsBridgeContext.Provider value={{ bridge: null, hasHydrated }}>
      <DraftNewRoute />
    </WindowsBridgeContext.Provider>,
  );
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.createDraftAndReplaceRoute.mockReset();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
});

afterEach(() => {
  cleanup();
});

describe("DraftNewRoute hydration gate", () => {
  it("does not mint a draft or navigate until the windows bridge has hydrated", () => {
    renderGated(false);

    expect(mocks.createDraftAndReplaceRoute).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("mints a draft once hydrated when no tabs were restored", async () => {
    renderGated(true);

    await waitFor(() => {
      expect(mocks.createDraftAndReplaceRoute).toHaveBeenCalledTimes(1);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("routes back to the restored workspace instead of minting when hydration reveals a restored tab", async () => {
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

    renderGated(true);

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
    });
    expect(mocks.createDraftAndReplaceRoute).not.toHaveBeenCalled();
  });

  it("defers the decision through a pending→hydrated transition (no draft while pending)", async () => {
    const view = renderGated(false);
    expect(mocks.createDraftAndReplaceRoute).not.toHaveBeenCalled();

    view.rerender(
      <WindowsBridgeContext.Provider
        value={{ bridge: null, hasHydrated: true }}
      >
        <DraftNewRoute />
      </WindowsBridgeContext.Provider>,
    );

    await waitFor(() => {
      expect(mocks.createDraftAndReplaceRoute).toHaveBeenCalledTimes(1);
    });
  });
});
