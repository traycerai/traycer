import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import {
  useSettingsAnchorArea,
  useSettingsAreaStartsAtTop,
} from "@/components/settings/settings-master-detail-area";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

afterEach(() => {
  cleanup();
  useSettingsSearchStore.setState({
    query: "",
    pendingReveal: null,
    handoffPending: false,
  });
});

function areaForAnchor(anchor: string): "themes" | "interface" | null {
  if (anchor === "appearance-zoom") return "interface";
  if (anchor === "appearance-theme-mode") return "themes";
  return null;
}

function ScrollHarness(props: { readonly area: string }): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useSettingsAreaStartsAtTop(rootRef, props.area);
  return (
    <div ref={rootRef}>
      <div role="tabpanel" hidden={props.area !== "themes"} aria-label="Themes">
        <div data-settings-area-body="" data-testid="themes-body">
          themes
        </div>
      </div>
      <div
        role="tabpanel"
        hidden={props.area !== "interface"}
        aria-label="Interface"
      >
        <div data-settings-area-body="" data-testid="interface-body">
          interface
        </div>
      </div>
    </div>
  );
}

describe("useSettingsAnchorArea", () => {
  it("calls setArea only for its own section and a resolvable anchor", () => {
    const setArea = vi.fn<(area: "themes" | "interface") => void>();
    renderHook(() =>
      useSettingsAnchorArea("appearance", areaForAnchor, setArea),
    );

    expect(setArea).not.toHaveBeenCalled();

    act(() => {
      useSettingsSearchStore
        .getState()
        .requestReveal("layout", "appearance-zoom");
    });
    expect(setArea).not.toHaveBeenCalled();

    act(() => {
      useSettingsSearchStore.getState().requestReveal("appearance", null);
    });
    expect(setArea).not.toHaveBeenCalled();

    act(() => {
      useSettingsSearchStore
        .getState()
        .requestReveal("appearance", "not-this-page");
    });
    expect(setArea).not.toHaveBeenCalled();

    act(() => {
      useSettingsSearchStore
        .getState()
        .requestReveal("appearance", "appearance-zoom");
    });
    expect(setArea).toHaveBeenCalledTimes(1);
    expect(setArea).toHaveBeenCalledWith("interface");
  });
});

describe("useSettingsAreaStartsAtTop", () => {
  it("resets scrollTop of the visible panel's [data-settings-area-body] when the area changes", () => {
    const view = render(<ScrollHarness area="themes" />);
    const themesBody = screen.getByTestId("themes-body");
    const interfaceBody = screen.getByTestId("interface-body");
    themesBody.scrollTop = 40;
    interfaceBody.scrollTop = 80;

    view.rerender(<ScrollHarness area="interface" />);

    expect(interfaceBody.scrollTop).toBe(0);
    expect(themesBody.scrollTop).toBe(40);
  });
});
