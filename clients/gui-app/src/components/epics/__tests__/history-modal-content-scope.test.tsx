import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { HistoryScope } from "@/lib/history-scope";

vi.mock("@/components/epics/epics-list-panel", () => ({
  EpicsListPanel: (props: {
    readonly scope: HistoryScope;
    readonly onScopeChange: (scope: HistoryScope) => void;
  }) => (
    <div data-testid="history-list-probe" data-scope={props.scope}>
      <button type="button" onClick={() => props.onScopeChange("messages")}>
        pick messages
      </button>
      <button type="button" onClick={() => props.onScopeChange("tasks")}>
        pick tasks
      </button>
    </div>
  ),
}));
vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => false,
}));

import { HistoryModalContent } from "@/components/epics/history-modal-content";
import {
  consumeHistoryScopeForPromotion,
  prepareHistoryScopeForPromotion,
  registerHistoryModalScope,
} from "@/lib/history-scope-handoff";
function capturedScope(): HistoryScope {
  prepareHistoryScopeForPromotion();
  return consumeHistoryScopeForPromotion();
}

describe("<HistoryModalContent /> scope registration", () => {
  afterEach(() => {
    cleanup();
    capturedScope();
  });

  it("publishes the dialog's popover surface, not the frame's background, for sticky headers", () => {
    render(<HistoryModalContent onSelectEpic={() => undefined} />);
    const wrapper = screen.getByTestId("history-list-probe").parentElement;
    if (wrapper === null) throw new Error("no modal content wrapper");

    expect(wrapper.className).toContain("[--history-surface:var(--popover)]");
    expect(wrapper.className).not.toContain("var(--background)");
  });

  it("opens on all even when a previous modal left a non-default scope registered", () => {
    // A stale registration from an earlier session (a modal that never
    // unmounted cleanly) must not survive a fresh mount.
    registerHistoryModalScope("messages");
    render(<HistoryModalContent onSelectEpic={() => undefined} />);
    expect(capturedScope()).toBe("all");
  });

  it("registers all while mounted, so promotion from an untouched modal adds no param", () => {
    render(<HistoryModalContent onSelectEpic={() => undefined} />);
    expect(capturedScope()).toBe("all");
  });

  it("resets the registration on unmount", () => {
    const view = render(<HistoryModalContent onSelectEpic={() => undefined} />);
    view.unmount();
    expect(capturedScope()).toBe("all");
  });

  it("a remount after close starts from all again", () => {
    const first = render(
      <HistoryModalContent onSelectEpic={() => undefined} />,
    );
    first.unmount();
    render(<HistoryModalContent onSelectEpic={() => undefined} />);
    expect(capturedScope()).toBe("all");
  });

  it("hands the panel the scope it owns and follows the panel's requests", () => {
    render(<HistoryModalContent onSelectEpic={() => undefined} />);
    const probe = screen.getByTestId("history-list-probe");
    expect(probe.dataset.scope).toBe("all");

    fireEvent.click(screen.getByRole("button", { name: "pick messages" }));

    expect(screen.getByTestId("history-list-probe").dataset.scope).toBe(
      "messages",
    );
  });

  it("promoting while on Messages hands the tab the Messages scope", () => {
    render(<HistoryModalContent onSelectEpic={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "pick messages" }));

    expect(capturedScope()).toBe("messages");
  });

  it("promoting after switching to Tasks hands over Tasks", () => {
    render(<HistoryModalContent onSelectEpic={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "pick messages" }));
    fireEvent.click(screen.getByRole("button", { name: "pick tasks" }));
    expect(capturedScope()).toBe("tasks");
  });

  it("drops the registration when the modal unmounts on Messages", () => {
    const view = render(<HistoryModalContent onSelectEpic={() => undefined} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "pick messages" }));
    });
    view.unmount();

    expect(capturedScope()).toBe("all");
  });
});
