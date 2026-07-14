import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
};

const guideMocks = vi.hoisted(() => ({
  queryData: {
    content: "claude guide",
    generatedDefaultContent: "claude guide",
  },
  setGlobalMutateAsync: vi.fn(),
  resetGlobalMutateAsync: vi.fn(),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "local",
}));

vi.mock("@/hooks/agent/use-agent-selection-guide-global-query", () => ({
  useAgentSelectionGuideGlobalQuery: () => ({
    data: guideMocks.queryData,
    isError: false,
  }),
}));

vi.mock("@/hooks/agent/use-agent-selection-guide-set-global-mutation", () => ({
  useAgentSelectionGuideSetGlobalMutation: () => ({
    mutateAsync: guideMocks.setGlobalMutateAsync,
  }),
}));

vi.mock(
  "@/hooks/agent/use-agent-selection-guide-reset-global-mutation",
  () => ({
    useAgentSelectionGuideResetGlobalMutation: () => ({
      mutateAsync: guideMocks.resetGlobalMutateAsync,
    }),
  }),
);

import { AgentSelectionGuideSection } from "@/components/settings/panels/agent-selection-guide-section";
import { AgentsSettingsPanel } from "@/components/settings/panels/agents-settings-panel";

function renderPanel() {
  return render(
    <StrictMode>
      <AgentSelectionGuideSection />
    </StrictMode>,
  );
}

function strictPanel() {
  return (
    <StrictMode>
      <AgentSelectionGuideSection />
    </StrictMode>
  );
}

describe("AgentSelectionGuideSection", () => {
  beforeEach(() => {
    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "claude guide",
    };
    guideMocks.setGlobalMutateAsync.mockReset();
    guideMocks.setGlobalMutateAsync.mockResolvedValue({
      content: "claude guide",
      generatedDefaultContent: "claude guide",
    });
    guideMocks.resetGlobalMutateAsync.mockReset();
    guideMocks.resetGlobalMutateAsync.mockResolvedValue({
      content: "codex guide",
      generatedDefaultContent: "codex guide",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("updates generated defaults without clobbering the active editor draft", async () => {
    const { rerender } = renderPanel();
    const editor = screen.getByTestId<HTMLTextAreaElement>(
      "agents-selection-guide-input",
    );
    const revert = screen.getByTestId<HTMLButtonElement>(
      "agents-selection-guide-revert",
    );

    expect(editor.value).toBe("claude guide");
    expect(revert.disabled).toBe(true);

    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "codex guide",
    };
    rerender(strictPanel());

    await waitFor(() => {
      expect(editor.value).toBe("claude guide");
      expect(revert.disabled).toBe(false);
    });
    expect(guideMocks.setGlobalMutateAsync).not.toHaveBeenCalled();
    expect(guideMocks.resetGlobalMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the opening height stable and allows vertical resizing", () => {
    renderPanel();
    const editor = screen.getByTestId<HTMLTextAreaElement>(
      "agents-selection-guide-input",
    );

    expect(editor.className).toContain("field-sizing-fixed");
    expect(editor.className).not.toContain("field-sizing-content");
    expect(editor.className).toContain("h-[min(32vh,16rem)]");
    expect(editor.className).toContain("resize-y");
    expect(editor.className).not.toContain("max-h-[min(32vh,16rem)]");
  });

  it("caps resizing at the settings viewport without shrinking below the opening height", () => {
    let scrollBottom = 800;
    const bodyBottom = 500;
    const openingHeight = 256;
    let resizeCallback: ResizeObserverCallback | null = null;
    const resizeObserver: ResizeObserver = {
      observe(): void {},
      unobserve(): void {},
      disconnect(): void {},
    };

    class BoundaryResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    vi.stubGlobal("ResizeObserver", BoundaryResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "settings-scroll-viewport") {
          return new DOMRect(0, 0, 100, scrollBottom);
        }
        if (this.hasAttribute("data-settings-panel-body")) {
          return new DOMRect(0, 0, 100, bodyBottom);
        }
        if (this instanceof HTMLTextAreaElement) {
          return new DOMRect(0, 0, 100, openingHeight);
        }
        return new DOMRect();
      },
    );

    render(
      <StrictMode>
        <div
          data-testid="settings-scroll-viewport"
          style={{ overflowY: "auto" }}
        >
          <AgentsSettingsPanel />
        </div>
      </StrictMode>,
    );

    const editor = screen.getByTestId<HTMLTextAreaElement>(
      "agents-selection-guide-input",
    );
    const panelShell = editor.closest("[data-settings-panel-shell]");
    if (!(panelShell instanceof HTMLElement)) {
      throw new Error("Expected the editor to render inside a settings shell");
    }
    panelShell.style.paddingBottom = "40px";

    const emitResize = (): void => {
      if (resizeCallback === null) {
        throw new Error("Expected the resize observer to be active");
      }
      resizeCallback([], resizeObserver);
    };

    act(emitResize);
    expect(editor.style.maxHeight).toBe("516px");

    scrollBottom = 300;
    act(emitResize);
    expect(editor.style.maxHeight).toBe("256px");
  });

  it("reverts through the host reset API instead of sending generated content back", async () => {
    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "codex guide",
    };
    renderPanel();

    fireEvent.click(screen.getByTestId("agents-selection-guide-revert"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLTextAreaElement>("agents-selection-guide-input")
          .value,
      ).toBe("codex guide");
    });
    expect(guideMocks.resetGlobalMutateAsync).toHaveBeenCalledWith({});
    expect(guideMocks.setGlobalMutateAsync).not.toHaveBeenCalled();
  });

  it("serializes saves so a later edit waits for an earlier write to settle", async () => {
    const first = createDeferred<{
      readonly content: string;
      readonly generatedDefaultContent: string;
    }>();
    const second = createDeferred<{
      readonly content: string;
      readonly generatedDefaultContent: string;
    }>();
    guideMocks.setGlobalMutateAsync
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderPanel();
    const editor = screen.getByTestId<HTMLTextAreaElement>(
      "agents-selection-guide-input",
    );

    fireEvent.change(editor, { target: { value: "first edit" } });
    fireEvent.blur(editor);

    expect(guideMocks.setGlobalMutateAsync).toHaveBeenCalledTimes(1);
    expect(guideMocks.setGlobalMutateAsync).toHaveBeenLastCalledWith({
      content: "first edit",
    });

    fireEvent.change(editor, { target: { value: "second edit" } });
    fireEvent.blur(editor);

    expect(guideMocks.setGlobalMutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({
        content: "first edit",
        generatedDefaultContent: "claude guide",
      });
      await first.promise;
    });

    await waitFor(() => {
      expect(guideMocks.setGlobalMutateAsync).toHaveBeenCalledTimes(2);
    });
    expect(guideMocks.setGlobalMutateAsync).toHaveBeenLastCalledWith({
      content: "second edit",
    });

    await act(async () => {
      second.resolve({
        content: "second edit",
        generatedDefaultContent: "claude guide",
      });
      await second.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeTruthy();
    });
  });
});

function createDeferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => {};
  let rejectValue: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}
