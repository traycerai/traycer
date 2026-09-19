import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/components/epics/epics-list-panel", () => ({
  EpicsListPanel: () => <div data-testid="history-list-probe" />,
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
import type { HistoryScope } from "@/lib/history-scope";

function capturedScope(): HistoryScope {
  prepareHistoryScopeForPromotion();
  return consumeHistoryScopeForPromotion();
}

describe("<HistoryModalContent /> scope registration", () => {
  afterEach(() => {
    cleanup();
    capturedScope();
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
});
