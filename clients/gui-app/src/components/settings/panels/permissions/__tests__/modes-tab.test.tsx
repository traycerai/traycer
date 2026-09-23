import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModesTab } from "@/components/settings/panels/permissions/modes-tab";
import { useSettingsStore } from "@/stores/settings/settings-store";

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModesTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ defaultPermission: "full_access" });
});

afterEach(cleanup);

describe("ModesTab", () => {
  it("renders the default-mode row and writes 'auto' when Auto is chosen", () => {
    renderTab();

    // Radix opens the dropdown on pointerdown, not click.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Full access" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    // Matched on the option's own description: the label "Auto" is a substring
    // of the sibling "Auto-accept edits", and each radio item's accessible name
    // concatenates label and description. Spelled out, not imported: this is
    // the sentence a user reads before turning the mode on.
    fireEvent.click(
      screen.getByRole("menuitemradio", {
        name: /A judge approves routine commands and asks you about risky ones\./,
      }),
    );

    expect(useSettingsStore.getState().defaultPermission).toBe("auto");
  });

  // A Settings surface must not open Settings: the row's picker passes
  // `onOpenPermissionSettings={null}`, so it renders no trailing item.
  it("renders no trailing 'Permission settings…' item on the default-mode row", () => {
    renderTab();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Full access" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    expect(
      screen.queryByRole("menuitem", { name: "Permission settings…" }),
    ).toBeNull();
  });

  it("labels the row as applying to all machines", () => {
    renderTab();

    expect(screen.getByText("All machines")).not.toBeNull();
    expect(screen.getByText(/New conversations start in/)).not.toBeNull();
  });

  it("says the machine picker above changes nothing on this tab", () => {
    renderTab();

    expect(
      screen.getByText(
        "The machine picker above doesn't change anything on this tab.",
      ),
    ).not.toBeNull();
  });

  it("renders one card per mode, each listing what it runs without asking", () => {
    renderTab();

    const expected = {
      supervised: ["Reads and searches"],
      auto_accept_edits: ["Reads and searches", "File edits in the workspace"],
      auto: ["Reads, searches, edits", "Commands the judge approves"],
      full_access: ["Everything, unreviewed"],
    };
    for (const [id, items] of Object.entries(expected)) {
      const card = screen.getByTestId(`permission-mode-card-${id}`);
      const list = within(card).getByRole("list", {
        name: /runs without asking/,
      });
      for (const item of items) {
        expect(within(list).getByText(item, { exact: false })).not.toBeNull();
      }
    }
    expect(screen.getAllByTestId(/^permission-mode-card-/)).toHaveLength(4);
  });
});
