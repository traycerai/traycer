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
import { TooltipProvider } from "@/components/ui/tooltip";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
};

const guideMocks = vi.hoisted(() => ({
  queryData: {
    content: "claude guide",
    generatedDefaultContent: "claude guide",
    providersSettled: true,
    recognizedDefaultContents: ["claude guide"],
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

function renderPanel() {
  return render(strictPanel());
}

function strictPanel() {
  return (
    <StrictMode>
      <TooltipProvider>
        <AgentSelectionGuideSection />
      </TooltipProvider>
    </StrictMode>
  );
}

describe("AgentSelectionGuideSection", () => {
  beforeEach(() => {
    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "claude guide",
      providersSettled: true,
      recognizedDefaultContents: ["claude guide"],
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
  });

  it("updates generated defaults without clobbering the active editor draft", async () => {
    const { rerender } = renderPanel();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Global agent selection instructions",
    });
    const revert = screen.getByRole<HTMLButtonElement>("button", {
      name: "Restore",
    });

    expect(editor.value).toBe("claude guide");
    expect(revert.disabled).toBe(true);

    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "codex guide",
      providersSettled: true,
      recognizedDefaultContents: ["codex guide", "claude guide"],
    };
    rerender(strictPanel());

    await waitFor(() => {
      expect(editor.value).toBe("claude guide");
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Update" })
          .disabled,
      ).toBe(false);
    });
    expect(guideMocks.setGlobalMutateAsync).not.toHaveBeenCalled();
    expect(guideMocks.resetGlobalMutateAsync).not.toHaveBeenCalled();
  });

  it("reverts through the host reset API instead of sending generated content back", async () => {
    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "codex guide",
      providersSettled: true,
      recognizedDefaultContents: ["codex guide", "claude guide"],
    };
    renderPanel();

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Update" })
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Global agent selection instructions",
        }).value,
      ).toBe("codex guide");
    });
    expect(guideMocks.resetGlobalMutateAsync).toHaveBeenCalledWith({});
    expect(guideMocks.setGlobalMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the editor mounted but gates revert while providers settle", () => {
    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "codex guide",
      providersSettled: false,
      recognizedDefaultContents: ["codex guide", "claude guide"],
    };
    renderPanel();

    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Global agent selection instructions",
    });
    const revert = screen.getByRole<HTMLButtonElement>("button", {
      name: "Checking",
    });
    expect(editor.value).toBe("claude guide");
    expect(revert.disabled).toBe(true);
    expect(screen.getByText("Checking providers")).toBeTruthy();
  });

  it("shows restore after a manual custom edit", () => {
    renderPanel();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Global agent selection instructions",
    });

    fireEvent.change(editor, { target: { value: "custom guide" } });

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Restore" })
        .disabled,
    ).toBe(false);
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
