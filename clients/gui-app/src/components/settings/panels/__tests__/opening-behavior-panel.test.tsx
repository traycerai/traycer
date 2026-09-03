import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OpeningBehaviorPanel } from "@/components/settings/panels/opening-behavior-panel";
import { altLabel, modLabel, shiftLabel } from "@/lib/keybindings/platform";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Settings > Opening behavior. Every row here is one enum select over one
 * settings-store field, so what is worth pinning is the wiring: the control
 * writes the value the store reads back, the per-type rows exist only while
 * their default asks for them, and each select's spoken name is its visible
 * label verbatim - the option copy names a DESTINATION ("In a new split"),
 * which only reads correctly under a control the user can find by that name.
 */

const DEFAULT_INNER_WIDTH = window.innerWidth;

afterEach(() => {
  cleanup();
  window.innerWidth = DEFAULT_INNER_WIDTH;
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

  it("hides the per-type rows until the default asks for them", () => {
    render(<OpeningBehaviorPanel />);

    expect(screen.queryByRole("combobox", { name: "Markdown" })).toBeNull();

    choose("Open links", "Per link type");

    expect(screen.getByRole("combobox", { name: "Markdown" })).not.toBeNull();
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

    choose("Markdown", "In default browser");
    choose("Terminal", "In default browser");
    choose("GitHub", "In default browser");
    choose("Images", "In default browser");

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
  it("writes the placement default and drops the per-type rows with it", () => {
    render(<OpeningBehaviorPanel />);

    choose("Open new tiles", "In a new split");

    expect(useSettingsStore.getState().tilePlacement.default).toBe("split");
    expect(
      screen.queryByRole("combobox", { name: "Files, diffs & artifacts" }),
    ).toBeNull();
  });

  it("writes the content and conversation types", () => {
    render(<OpeningBehaviorPanel />);

    choose("Files, diffs & artifacts", "In a new split");
    choose("Agents & terminals", "In a new split");

    const placement = useSettingsStore.getState().tilePlacement;
    expect(placement.content).toBe("split");
    expect(placement.conversation).toBe("split");
  });

  it("floats the browser type picture-in-picture", () => {
    render(<OpeningBehaviorPanel />);

    choose("Browsers", "Picture in picture");

    expect(useSettingsStore.getState().tilePlacement.browser).toBe("pip");
  });

  it("offers picture in picture nowhere else - the others have no PiP host", () => {
    render(<OpeningBehaviorPanel />);

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Files, diffs & artifacts" }),
      { key: "ArrowDown" },
    );

    expect(
      screen.queryByRole("option", { name: "Picture in picture" }),
    ).toBeNull();
  });

  it("says why the choice is moot on a single-tile viewport", () => {
    window.innerWidth = 480;
    render(<OpeningBehaviorPanel />);

    // The note is the ROW's description (so it also names the control through
    // aria-describedby), not the amber hint reserved for something being wrong.
    const trigger = screen.getByRole("combobox", { name: "Open new tiles" });
    const describedBy = trigger.getAttribute("aria-describedby");
    if (describedBy === null) throw new Error("expected aria-describedby");
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "Narrow windows show one tile at a time, so everything opens in this pane.",
    );
  });

  it("leaves the placement row undescribed on a normal viewport", () => {
    render(<OpeningBehaviorPanel />);

    expect(
      screen
        .getByRole("combobox", { name: "Open new tiles" })
        .getAttribute("aria-describedby"),
    ).toBeNull();
  });
});

describe("<OpeningBehaviorPanel /> agent-opened tabs", () => {
  it("writes the surfacing mode", () => {
    render(<OpeningBehaviorPanel />);

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("off");

    choose("Agent-opened tabs", "Like any browser tile");

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("surface");
  });

  it("lives in Tile placement rather than a group of its own", () => {
    render(<OpeningBehaviorPanel />);

    const tiles = screen.getByTestId("settings-opening-tiles");
    expect(
      tiles.contains(
        screen.getByRole("combobox", { name: "Agent-opened tabs" }),
      ),
    ).toBe(true);
    expect(screen.queryByTestId("settings-opening-agent-tabs")).toBeNull();
  });

  it("stays put when the placement default hides the per-type rows", () => {
    useSettingsStore.setState({
      tilePlacement: {
        default: "tab",
        content: "tab",
        conversation: "tab",
        browser: "split",
      },
    });
    render(<OpeningBehaviorPanel />);

    expect(
      screen.getByRole("combobox", { name: "Agent-opened tabs" }),
    ).not.toBeNull();
  });
});

describe("<OpeningBehaviorPanel /> modifier legend", () => {
  it("states the four unconfigurable modifiers once, platform-aware", () => {
    render(<OpeningBehaviorPanel />);

    expect(
      screen.getByText(
        `${modLabel()}-click opens a link in your default browser · ${altLabel()}-click flips the choice · ${shiftLabel()}-click opens a tile in a split · middle-click opens it in the background`,
      ),
    ).not.toBeNull();
  });
});
