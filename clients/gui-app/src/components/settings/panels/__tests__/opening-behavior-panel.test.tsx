import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OpeningBehaviorPanel } from "@/components/settings/panels/opening-behavior-panel";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Settings > Opening behavior. Every row here is one enum select over one
 * settings-store field, so what is worth pinning is the wiring: the control
 * writes the value the store reads back, and the per-kind / per-category rows
 * exist only while their default asks for them.
 */

afterEach(() => {
  cleanup();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

/** Radix's select: open with the keyboard, then commit the named option. */
function choose(control: string, option: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name: control }), {
    key: "ArrowDown",
  });
  const item = screen.getByRole("option", { name: option });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

describe("<OpeningBehaviorPanel /> links", () => {
  it("writes the link default", () => {
    render(<OpeningBehaviorPanel />);

    choose("Open links", "In default browser");

    expect(useSettingsStore.getState().linkOpen.default).toBe("external");
  });

  it("hides the per-kind rows until the default asks for them", () => {
    render(<OpeningBehaviorPanel />);

    expect(
      screen.queryByRole("combobox", { name: "Markdown links" }),
    ).toBeNull();

    choose("Open links", "Per kind");

    expect(
      screen.getByRole("combobox", { name: "Markdown links" }),
    ).not.toBeNull();
  });

  it("writes each of the four kinds independently", () => {
    useSettingsStore.setState({
      linkOpen: {
        default: "per-kind",
        markdown: "in-app",
        terminal: "in-app",
        github: "in-app",
        image: "in-app",
      },
    });
    render(<OpeningBehaviorPanel />);

    choose("Markdown links", "In default browser");
    choose("Terminal links", "In default browser");
    choose("GitHub links", "In default browser");
    choose("Image links", "In default browser");

    expect(useSettingsStore.getState().linkOpen).toEqual({
      default: "per-kind",
      markdown: "external",
      terminal: "external",
      github: "external",
      image: "external",
    });
  });
});

describe("<OpeningBehaviorPanel /> tile placement", () => {
  it("writes the placement default and drops the per-category rows with it", () => {
    render(<OpeningBehaviorPanel />);

    choose("Place new tiles", "In a split");

    expect(useSettingsStore.getState().tilePlacement.default).toBe("split");
    expect(
      screen.queryByRole("combobox", { name: "Content tiles" }),
    ).toBeNull();
  });

  it("writes the content and conversation categories", () => {
    render(<OpeningBehaviorPanel />);

    choose("Content tiles", "In a split");
    choose("Conversation tiles", "In a split");

    const placement = useSettingsStore.getState().tilePlacement;
    expect(placement.content).toBe("split");
    expect(placement.conversation).toBe("split");
  });

  it("floats the browser category picture-in-picture", () => {
    render(<OpeningBehaviorPanel />);

    choose("Browser tiles", "Picture in picture");

    expect(useSettingsStore.getState().tilePlacement.browser).toBe("pip");
  });

  it("offers picture in picture nowhere else - the others have no PiP host", () => {
    render(<OpeningBehaviorPanel />);

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Content tiles" }), {
      key: "ArrowDown",
    });

    expect(
      screen.queryByRole("option", { name: "Picture in picture" }),
    ).toBeNull();
  });
});

describe("<OpeningBehaviorPanel /> agent-opened tabs", () => {
  it("writes the surfacing mode", () => {
    render(<OpeningBehaviorPanel />);

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("off");

    choose("Agent-opened tabs", "Surface on canvas");

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("surface");
  });
});
