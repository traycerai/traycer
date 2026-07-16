import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, act } from "react";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@uiw/react-codemirror";
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

function getCodeMirrorView(element: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(element);
  if (view === null) throw new Error("Expected a CodeMirror editor element");
  return view;
}

function readMarkdown(element: HTMLElement): string {
  return getCodeMirrorView(element).state.doc.toString();
}

function replaceMarkdown(element: HTMLElement, markdown: string): void {
  act(() => {
    const view = getCodeMirrorView(element);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: markdown },
    });
  });
}

function blurCodeMirror(element: HTMLElement): void {
  const content = element.querySelector(".cm-content");
  if (!(content instanceof HTMLElement)) {
    throw new Error("Expected CodeMirror content to render");
  }
  fireEvent.blur(content);
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
    const editor = screen.getByTestId("agents-selection-guide-input");
    const revert = screen.getByTestId<HTMLButtonElement>(
      "agents-selection-guide-revert",
    );

    expect(readMarkdown(editor)).toBe("claude guide");
    expect(revert.disabled).toBe(true);

    guideMocks.queryData = {
      content: "claude guide",
      generatedDefaultContent: "codex guide",
    };
    rerender(strictPanel());

    await waitFor(() => {
      expect(readMarkdown(editor)).toBe("claude guide");
      expect(revert.disabled).toBe(false);
    });
    expect(guideMocks.setGlobalMutateAsync).not.toHaveBeenCalled();
    expect(guideMocks.resetGlobalMutateAsync).not.toHaveBeenCalled();
  });

  it("renders Markdown source with line numbers at full height", () => {
    guideMocks.queryData = {
      content: "# Choose an agent\n\n- Match the task",
      generatedDefaultContent: "# Choose an agent\n\n- Match the task",
    };
    render(
      <StrictMode>
        <AgentsSettingsPanel />
      </StrictMode>,
    );
    const editor = screen.getByTestId("agents-selection-guide-input");
    const editorShell = editor.closest(
      "[data-agent-selection-guide-editor-shell]",
    );
    if (!(editorShell instanceof HTMLElement)) {
      throw new Error("Expected the editor shell to render");
    }
    const panelShell = editor.closest("[data-settings-panel-shell]");
    const panelBody = editor.closest("[data-settings-panel-body]");
    if (!(panelShell instanceof HTMLElement)) {
      throw new Error("Expected the settings panel shell to render");
    }
    if (!(panelBody instanceof HTMLElement)) {
      throw new Error("Expected the settings panel body to render");
    }

    const editorView = getCodeMirrorView(editor);
    expect(editorView.state.doc.toString()).toBe(
      "# Choose an agent\n\n- Match the task",
    );
    expect(
      syntaxTree(editorView.state).topNode.getChild("ATXHeading1"),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", {
        name: "Global agent selection instructions",
      }),
    ).toBeTruthy();
    expect(editor.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(editor.className).toContain("h-full");
    expect(editorShell.className).toContain("flex-1");
    expect(panelShell.className).toContain("h-full");
    expect(panelBody.className).toContain("flex-1");
    expect(
      screen.queryByRole("heading", { name: "Choose an agent" }),
    ).toBeNull();
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
        readMarkdown(screen.getByTestId("agents-selection-guide-input")),
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
    const editor = screen.getByTestId("agents-selection-guide-input");

    replaceMarkdown(editor, "first edit");
    blurCodeMirror(editor);

    expect(guideMocks.setGlobalMutateAsync).toHaveBeenCalledTimes(1);
    expect(guideMocks.setGlobalMutateAsync).toHaveBeenLastCalledWith({
      content: "first edit",
    });

    replaceMarkdown(editor, "second edit");
    blurCodeMirror(editor);

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
