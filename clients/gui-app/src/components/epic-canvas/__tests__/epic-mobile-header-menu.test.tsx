import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EpicMobileHeaderMenu,
  MobileEpicHeaderActionsBinder,
} from "@/components/epic-canvas/mobile/epic-mobile-header-menu";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";

interface RenameVariables {
  readonly epicDelta: {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  };
}

let role: "owner" | "viewer" = "owner";
let mobileValue = true;
const openSpy = vi.fn();
const setComposerModeSpy = vi.fn();
const mutateSpy =
  vi.fn<(vars: RenameVariables, options: { onSuccess: () => void }) => void>();

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => mobileValue,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicPermissionRole: () => role,
  useRegisteredEpicTitle: () => "My Epic",
}));
vi.mock("@/stores/epics/new-conversation-modal-open-store", () => ({
  useNewConversationModalOpenStore: { getState: () => ({ open: openSpy }) },
}));
vi.mock("@/stores/epics/new-conversation-modal-store", () => ({
  useNewConversationModalStore: {
    getState: () => ({ setComposerMode: setComposerModeSpy }),
  },
}));
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({ mutate: mutateSpy, isPending: false }),
}));

function renderMenu() {
  return render(<EpicMobileHeaderMenu epicId="epic-1" tabId="tab-1" />);
}

function openMenu() {
  fireEvent.pointerDown(screen.getByTestId("mobile-epic-actions-trigger"));
}

describe("<EpicMobileHeaderMenu />", () => {
  beforeEach(() => {
    role = "owner";
    openSpy.mockClear();
    setComposerModeSpy.mockClear();
    mutateSpy.mockClear();
  });
  afterEach(cleanup);

  it("shows exactly New chat, New terminal, and Rename for an editor", () => {
    renderMenu();
    openMenu();
    expect(screen.getByRole("menuitem", { name: "New chat" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "New terminal" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("renders no trigger at all for a viewer (no editable actions)", () => {
    role = "viewer";
    renderMenu();
    // A viewer can neither create nor rename, so the whole ⋮ is hidden - no
    // dead-end New chat, no empty menu.
    expect(screen.queryByTestId("mobile-epic-actions-trigger")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("New chat opens the shared New Conversation modal request for this epic", () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New chat" }));
    expect(setComposerModeSpy).toHaveBeenCalledWith("epic-1", "chat");
    expect(openSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        tabId: "tab-1",
        parentId: null,
      }),
    );
  });

  it("Rename opens a dialog and submits the new title via the rename mutation", () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("mobile-epic-rename-input");
    fireEvent.change(input, { target: { value: "Renamed epic" } });
    fireEvent.click(screen.getByTestId("mobile-epic-rename-save"));
    expect(mutateSpy).toHaveBeenCalledTimes(1);
    const variables = mutateSpy.mock.calls[0][0];
    expect(variables.epicDelta.id).toBe("epic-1");
    expect(variables.epicDelta.title).toBe("Renamed epic");
  });
});

describe("<MobileEpicHeaderActionsBinder />", () => {
  afterEach(() => {
    cleanup();
    mobileValue = true;
    useMobileHeaderStore.getState().setRightActions(null);
  });

  it("fills the header slot on mobile and clears it on unmount", () => {
    mobileValue = true;
    const { unmount } = render(
      <MobileEpicHeaderActionsBinder epicId="epic-1" tabId="tab-1" />,
    );
    expect(useMobileHeaderStore.getState().rightActions).not.toBeNull();
    unmount();
    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });

  it("does not fill the slot on desktop", () => {
    mobileValue = false;
    render(<MobileEpicHeaderActionsBinder epicId="epic-1" tabId="tab-1" />);
    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
  });
});
