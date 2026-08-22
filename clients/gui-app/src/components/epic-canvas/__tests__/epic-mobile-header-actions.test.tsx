import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EpicMobileSwitcherTrigger,
  MobileEpicHeaderActionsBinder,
  MobileEpicHeaderTitle,
} from "@/components/epic-canvas/mobile/epic-mobile-header-actions";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";

interface RenameVariables {
  readonly epicDelta: {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  };
}

const holder = vi.hoisted(() => ({
  role: "owner",
  mobile: true,
}));
const mutateSpy = vi.hoisted(() => vi.fn<(vars: RenameVariables) => void>());

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => holder.mobile,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicPermissionRole: () => holder.role,
}));
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({ mutate: mutateSpy, isPending: false }),
}));

function openEdit(testId: string): HTMLElement {
  fireEvent.click(screen.getByTestId(testId));
  return screen.getByTestId(`${testId}-input`);
}

describe("<EpicMobileSwitcherTrigger />", () => {
  beforeEach(() => {
    useMobileSwitcherStore.setState({ openTabId: null });
  });
  afterEach(cleanup);

  it("opens the switcher store for its own tabId when tapped", () => {
    render(<EpicMobileSwitcherTrigger tabId="tab-1" />);
    const trigger = screen.getByTestId("mobile-epic-switcher-trigger");
    expect(trigger.getAttribute("aria-label")).toBe("Switch tab");
    fireEvent.click(trigger);
    expect(useMobileSwitcherStore.getState().openTabId).toBe("tab-1");
  });

  it("renders for a viewer role too - switching tabs is not permission-gated", () => {
    holder.role = "viewer";
    render(<EpicMobileSwitcherTrigger tabId="tab-1" />);
    expect(screen.getByTestId("mobile-epic-switcher-trigger")).toBeTruthy();
    holder.role = "owner";
  });
});

describe("<MobileEpicHeaderTitle />", () => {
  beforeEach(() => {
    holder.role = "owner";
    mutateSpy.mockClear();
  });
  afterEach(cleanup);

  it("renders the epic title as an editable control for an editor", () => {
    render(<MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />);
    const title = screen.getByTestId("mobile-epic-header-title");
    expect(title.tagName).toBe("BUTTON");
    expect(title.textContent).toBe("My Epic");
  });

  it("commits a new title via the epic title mutation", () => {
    render(<MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />);
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.blur(input);
    expect(mutateSpy).toHaveBeenCalledTimes(1);
    const variables = mutateSpy.mock.calls[0][0];
    expect(variables.epicDelta.id).toBe("epic-1");
    expect(variables.epicDelta.title).toBe("Renamed epic");
  });

  it("Escape cancels the edit without committing", () => {
    render(<MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />);
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-epic-header-title").textContent).toBe(
      "My Epic",
    );
  });

  it("an empty commit keeps the previous title and does not mutate", () => {
    render(<MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />);
    const input = openEdit("mobile-epic-header-title");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-epic-header-title").textContent).toBe(
      "My Epic",
    );
  });

  it("renders plain text for a viewer (no editable control)", () => {
    holder.role = "viewer";
    render(<MobileEpicHeaderTitle epicId="epic-1" title="My Epic" />);
    const title = screen.getByTestId("mobile-epic-header-title");
    expect(title.tagName).toBe("SPAN");
    expect(screen.queryByTestId("mobile-epic-header-title-input")).toBeNull();
  });
});

describe("<MobileEpicHeaderActionsBinder />", () => {
  afterEach(() => {
    cleanup();
    holder.mobile = true;
    useMobileHeaderStore.getState().setRightActions(null);
  });

  it("fills the header slot on mobile and clears it on unmount", () => {
    holder.mobile = true;
    const { unmount } = render(<MobileEpicHeaderActionsBinder tabId="tab-1" />);
    expect(useMobileHeaderStore.getState().rightActions).not.toBeNull();
    unmount();
    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });

  it("does not fill the slot on desktop", () => {
    holder.mobile = false;
    render(<MobileEpicHeaderActionsBinder tabId="tab-1" />);
    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });
});
