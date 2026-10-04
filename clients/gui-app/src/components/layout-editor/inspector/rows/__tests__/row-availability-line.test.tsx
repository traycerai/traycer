import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LayoutFormHostContext,
  type LayoutFormHost,
} from "@/components/layout-editor/inspector/layout-form-host";
import { RowAvailabilityLine } from "@/components/layout-editor/inspector/rows/row-availability-line";
import {
  disabledBy,
  liveWithNote,
  type RowJump,
} from "@/components/layout-editor/regions/row-availability";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

const navigation = vi.hoisted(() => ({
  navigateToSettingsSection: vi.fn(),
  navigateToLayoutRegion: vi.fn(),
  navigateToLayoutRegionRow: vi.fn(),
}));
vi.mock("@/lib/settings-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-navigation")>()),
  navigateToSettingsSection: navigation.navigateToSettingsSection,
  navigateToLayoutRegion: navigation.navigateToLayoutRegion,
  navigateToLayoutRegionRow: navigation.navigateToLayoutRegionRow,
}));

/**
 * The one shell a row's availability is drawn with: the reason in the
 * description slot, and the controller's link where it is out of sight. A
 * link to ANOTHER settings page would end the editor session the user is
 * editing in, so it is a page-host affordance; a link to a layout row works
 * in both hosts, each landing on the row its own way.
 */

const SETTINGS_JUMP: RowJump = {
  kind: "settings",
  section: "general",
  anchor: "general-voice-input",
  label: "Open General settings",
};
const REGION_JUMP: RowJump = {
  kind: "layout-region",
  regionId: "contextUsage",
  row: null,
  label: "Go to Context usage",
};
const ROW_JUMP: RowJump = {
  kind: "layout-region",
  regionId: "usageLimits",
  row: "codex",
  label: "Go to Codex",
};

function renderLine(host: LayoutFormHost, jump: RowJump | null): void {
  render(
    <LayoutFormHostContext value={host}>
      <RowAvailabilityLine
        id="reason"
        availability={disabledBy("Turn this on first.", jump)}
        layoutClassName={null}
      />
    </LayoutFormHostContext>,
  );
}

beforeEach(() => {
  navigation.navigateToSettingsSection.mockReset();
  navigation.navigateToLayoutRegion.mockReset();
  navigation.navigateToLayoutRegionRow.mockReset();
  useLayoutEditorStore.getState().endSession();
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("a disabled row's reason", () => {
  it("is the text alone when it names no controller out of sight", () => {
    renderLine("page", null);

    expect(screen.getByText("Turn this on first.").id).toBe("reason");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws a live row's note the same way, with no link", () => {
    render(
      <RowAvailabilityLine
        id="note"
        availability={liveWithNote("Applies on wider windows.")}
        layoutClassName={null}
      />,
    );

    expect(
      screen
        .getByText("Applies on wider windows.")
        .getAttribute("data-row-availability"),
    ).toBe("live");
  });
});

describe("a link to another settings page", () => {
  it("is a link on the Settings page host, and arms the row's reveal before navigating", () => {
    renderLine("page", SETTINGS_JUMP);

    fireEvent.click(
      screen.getByRole("button", { name: "Open General settings" }),
    );

    expect(
      navigation.navigateToSettingsSection,
    ).toHaveBeenCalledExactlyOnceWith("general");
    expect(useSettingsSearchStore.getState().pendingReveal).toEqual(
      expect.objectContaining({ anchor: "general-voice-input" }),
    );
  });

  it("is not drawn in the editor host, which it would end the session to follow", () => {
    renderLine("inspector", SETTINGS_JUMP);

    expect(screen.getByText("Turn this on first.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("a link to a row in the layout form", () => {
  it("lands on the row from the Settings page host the way a search result does", () => {
    renderLine("page", REGION_JUMP);

    fireEvent.click(
      screen.getByRole("button", { name: "Go to Context usage" }),
    );

    expect(navigation.navigateToLayoutRegion).toHaveBeenCalledExactlyOnceWith(
      "contextUsage",
    );
  });

  it("lands on a list row inside the region when that row is the controller, from the Settings page host", () => {
    renderLine("page", ROW_JUMP);

    fireEvent.click(screen.getByRole("button", { name: "Go to Codex" }));

    expect(
      navigation.navigateToLayoutRegionRow,
    ).toHaveBeenCalledExactlyOnceWith("usageLimits", "codex");
    expect(navigation.navigateToLayoutRegion).not.toHaveBeenCalled();
  });

  it("opens the row's area in the editor host, with the row selected, without leaving it", () => {
    renderLine("inspector", REGION_JUMP);

    fireEvent.click(
      screen.getByRole("button", { name: "Go to Context usage" }),
    );

    expect(navigation.navigateToLayoutRegion).not.toHaveBeenCalled();
    expect(useLayoutEditorStore.getState().area).toBe("chat");
    expect(useLayoutEditorStore.getState().selected).toBe("contextUsage");
  });
});
