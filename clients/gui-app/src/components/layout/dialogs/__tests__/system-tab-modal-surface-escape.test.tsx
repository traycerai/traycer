import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog as DialogPrimitive } from "radix-ui";
import { SystemTabModalSurface } from "@/components/layout/dialogs/system-tab-modal-host";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

// The Escape decision runs entirely in the frame, the overlay registry and the
// search store — neither body plays a part in it, since Radix listens for
// Escape on the document, ahead of anything inside the dialog. So the bodies
// are probes: standing up the real rail and General panel, or History's list,
// would put a host runtime and a router in a test about one key.
vi.mock("@/components/settings/settings-modal-content", () => ({
  SettingsModalContent: () => <div data-testid="settings-body-probe" />,
}));
vi.mock("@/components/epics/history-modal-content", () => ({
  HistoryModalContent: () => <div data-testid="history-body-probe" />,
}));

/** The modal as the host renders it: open until `onOpenChange(false)`. */
function OpenModal(props: {
  readonly kind: "settings" | "history";
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      {open ? (
        <SystemTabModalSurface
          active={{ kind: props.kind, section: null }}
          onClose={() => setOpen(false)}
          onPromote={() => undefined}
        />
      ) : null}
    </DialogPrimitive.Root>
  );
}

/** Radix attaches its document Escape listener a tick after mount. */
async function waitForDismissableLayerListener(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function pressEscapeOnDocument(): void {
  fireEvent.keyDown(document.body, { key: "Escape" });
}

afterEach(() => {
  cleanup();
  useSettingsSearchStore.setState({ query: "" });
});

describe("<SystemTabModalSurface /> Escape", () => {
  it("clears a running settings search first, and closes only on the next Escape", async () => {
    useSettingsSearchStore.setState({ query: "theme" });
    render(<OpenModal kind="settings" />);
    await waitForDismissableLayerListener();

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(useSettingsSearchStore.getState().query).toBe("");

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes Settings on the first Escape when no search is running", async () => {
    render(<OpenModal kind="settings" />);
    await waitForDismissableLayerListener();

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves History's Escape alone even with a settings query lying around", async () => {
    useSettingsSearchStore.setState({ query: "theme" });
    render(<OpenModal kind="history" />);
    await waitForDismissableLayerListener();

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSettingsSearchStore.getState().query).toBe("theme");
  });
});
