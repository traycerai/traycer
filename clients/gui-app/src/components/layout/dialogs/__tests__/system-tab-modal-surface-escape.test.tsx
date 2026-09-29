import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemTabModalSurface } from "@/components/layout/dialogs/system-tab-modal-host";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

// The Escape decision runs entirely in the frame, the overlay registry and the
// search store — neither body plays a part in it, since Base listens for
// Escape on the document, ahead of anything inside the dialog. So the bodies
// are probes: standing up the real rail and General panel, or History's list,
// would put a host runtime and a router in a test about one key.
vi.mock("@/components/settings/settings-modal-content", () => ({
  SettingsModalContent: () => <div data-testid="settings-body-probe" />,
}));
vi.mock("@/components/epics/history-modal-content", () => ({
  HistoryModalContent: () => <div data-testid="history-body-probe" />,
}));

/**
 * The modal as the host renders it: open until `onClose` fires. No outer
 * Root wrapper - `SystemTabModalSurface` owns its own Base `<Dialog>` root
 * now (its `open` is hardcoded `true`; unmounting the surface is what
 * actually removes it from the DOM).
 */
function OpenModal(props: {
  readonly kind: "settings" | "history";
  readonly editingTheme: boolean;
}): ReactNode {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <SystemTabModalSurface
      active={{ kind: props.kind, section: null }}
      editingTheme={props.editingTheme}
      onClose={() => setOpen(false)}
      onPromote={() => undefined}
    />
  );
}

function pressEscapeOnDocument(): void {
  fireEvent.keyDown(document.body, { key: "Escape" });
}

afterEach(() => {
  cleanup();
  useSettingsSearchStore.setState({ query: "", handoffPending: false });
});

describe("<SystemTabModalSurface /> Escape", () => {
  it("clears a running settings search first, and closes only on the next Escape", () => {
    useSettingsSearchStore.setState({ query: "theme" });
    render(<OpenModal kind="settings" editingTheme={false} />);

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(useSettingsSearchStore.getState().query).toBe("");

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes Settings on the first Escape when no search is running", () => {
    render(<OpenModal kind="settings" editingTheme={false} />);

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves History's Escape alone even with a settings query lying around", () => {
    useSettingsSearchStore.setState({ query: "theme" });
    render(<OpenModal kind="history" editingTheme={false} />);

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSettingsSearchStore.getState().query).toBe("theme");
  });
});

describe("<SystemTabModalSurface /> while a theme draft is open", () => {
  // Radix ignored every close while a draft was open; only the explicit close
  // button could dismiss Settings. Base's Escape listener is document-level, so
  // the reason has to be cancelled, not just outside presses.
  it("keeps Settings open on Escape, and closes only from the close button", () => {
    render(<OpenModal kind="settings" editingTheme />);

    pressEscapeOnDocument();

    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.click(screen.getByTestId("system-tab-modal-close-settings"));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("<SystemTabModalSurface /> promotion", () => {
  // Promotion unmounts the settings body before the tab's body mounts; the
  // surface marks the reveal handoff while the body is still there.
  it("marks a reveal handoff before promoting Settings", () => {
    const onPromote = vi.fn(() => {
      expect(useSettingsSearchStore.getState().handoffPending).toBe(true);
    });
    render(
      <SystemTabModalSurface
        active={{ kind: "settings", section: null }}
        editingTheme={false}
        onClose={() => undefined}
        onPromote={onPromote}
      />,
    );

    fireEvent.click(screen.getByTestId("system-tab-modal-promote-settings"));

    expect(onPromote).toHaveBeenCalledTimes(1);
  });

  it("marks no handoff when promoting History", () => {
    render(
      <SystemTabModalSurface
        active={{ kind: "history", section: null }}
        editingTheme={false}
        onClose={() => undefined}
        onPromote={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId("system-tab-modal-promote-history"));

    expect(useSettingsSearchStore.getState().handoffPending).toBe(false);
  });
});
