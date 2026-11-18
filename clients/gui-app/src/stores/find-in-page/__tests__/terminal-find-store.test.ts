import { afterEach, describe, expect, it, vi } from "vitest";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import {
  registerActiveTerminalFindController,
  type TerminalFindController,
  useTerminalFindStore,
} from "@/stores/find-in-page/terminal-find-store";

function createController(id: string): TerminalFindController {
  return {
    id,
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clear: vi.fn(),
  };
}

describe("terminal find store", () => {
  afterEach(() => {
    useTerminalFindStore.setState({ activeController: null });
    useFindInPageStore.setState({
      isOpen: false,
      query: "",
      matches: null,
      matchCase: false,
      advanceForwardNonce: 0,
      advanceBackwardNonce: 0,
      focusRequestNonce: 0,
    });
  });

  it("does not unregister a newer controller that reuses the same id", () => {
    const firstController = createController("terminal:test");
    const secondController = createController("terminal:test");
    const unregisterFirst =
      registerActiveTerminalFindController(firstController);
    const unregisterSecond =
      registerActiveTerminalFindController(secondController);
    useFindInPageStore.getState().setMatches({ current: 1, total: 2 });

    unregisterFirst();

    expect(useTerminalFindStore.getState().activeController).toBe(
      secondController,
    );
    expect(firstController.clear).not.toHaveBeenCalled();
    expect(secondController.clear).not.toHaveBeenCalled();
    expect(useFindInPageStore.getState().matches).toEqual({
      current: 1,
      total: 2,
    });

    unregisterSecond();

    expect(useTerminalFindStore.getState().activeController).toBeNull();
    expect(secondController.clear).toHaveBeenCalledTimes(1);
    expect(useFindInPageStore.getState().matches).toBeNull();
  });
});
