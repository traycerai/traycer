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
  useSettingsGuideArea,
} from "@/components/settings/settings-master-detail-area";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

function resetOnboarding(): void {
  useOnboardingStore.setState({
    setupProgress: { agents: -1, appearance: -1, cookies: -1 },
    activeSetup: null,
  });
}

afterEach(() => {
  cleanup();
  resetOnboarding();
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

function areaForId(id: string): "themes" | "startPage" | null {
  if (id === "themes") return "themes";
  if (id === "startPage") return "startPage";
  return null;
}

function GuideHarness(props: {
  readonly setArea: (area: "themes" | "startPage") => void;
  readonly themeModeInsideArea: boolean;
  readonly themeAreaId: string;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useSettingsGuideArea("appearance", rootRef, areaForId, props.setArea);
  const themeMode = (
    <div data-settings-anchor="appearance-theme-mode">
      <div role="group">theme mode</div>
    </div>
  );
  return (
    <div ref={rootRef}>
      {props.themeModeInsideArea ? (
        <div data-settings-area={props.themeAreaId}>{themeMode}</div>
      ) : (
        themeMode
      )}
      <div data-settings-area="startPage">
        <div data-settings-anchor="appearance-wallpaper">
          <button type="button">wallpaper</button>
        </div>
      </div>
    </div>
  );
}

describe("useSettingsGuideArea", () => {
  it("calls setArea with the area of the panel holding the step's target", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    useOnboardingStore.getState().startSetup("appearance");
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea
        themeAreaId="themes"
      />,
    );

    expect(setArea).toHaveBeenCalledTimes(1);
    expect(setArea).toHaveBeenCalledWith("themes");

    act(() => {
      useOnboardingStore.getState().advanceSetup();
    });
    expect(setArea).toHaveBeenCalledTimes(2);
    expect(setArea).toHaveBeenLastCalledWith("startPage");
  });

  it("does nothing when no guide is active", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea
        themeAreaId="themes"
      />,
    );

    expect(setArea).not.toHaveBeenCalled();
  });

  it("does nothing when the step is for another section", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    useOnboardingStore.getState().startSetup("agents");
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea
        themeAreaId="themes"
      />,
    );

    expect(setArea).not.toHaveBeenCalled();
  });

  it("does nothing when the target is not inside a [data-settings-area]", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    useOnboardingStore.getState().startSetup("appearance");
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea={false}
        themeAreaId="themes"
      />,
    );

    expect(setArea).not.toHaveBeenCalled();
  });

  it("does nothing when areaForId answers null", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    useOnboardingStore.getState().startSetup("appearance");
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea
        themeAreaId="unknown"
      />,
    );

    expect(setArea).not.toHaveBeenCalled();
  });

  it("does not call setArea when a same-section reveal with an anchor is armed", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    useOnboardingStore.getState().startSetup("appearance");
    useSettingsSearchStore
      .getState()
      .requestReveal("appearance", "appearance-start-page");
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea
        themeAreaId="themes"
      />,
    );

    expect(setArea).not.toHaveBeenCalled();
  });

  it("still calls setArea when the armed reveal is a page result", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    useOnboardingStore.getState().startSetup("appearance");
    useSettingsSearchStore.getState().requestReveal("appearance", null);
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea
        themeAreaId="themes"
      />,
    );

    expect(setArea).toHaveBeenCalledTimes(1);
    expect(setArea).toHaveBeenCalledWith("themes");
  });

  it("still calls setArea when the armed reveal is for another section", () => {
    const setArea = vi.fn<(area: "themes" | "startPage") => void>();
    useOnboardingStore.getState().startSetup("appearance");
    useSettingsSearchStore
      .getState()
      .requestReveal("layout", "appearance-start-page");
    render(
      <GuideHarness
        setArea={setArea}
        themeModeInsideArea
        themeAreaId="themes"
      />,
    );

    expect(setArea).toHaveBeenCalledTimes(1);
    expect(setArea).toHaveBeenCalledWith("themes");
  });
});
