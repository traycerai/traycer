import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, act, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorView } from "@uiw/react-codemirror";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MarkdownEditPreview,
  MarkdownPreview,
} from "@/components/markdown-edit-preview";

const TEST_ID = "markdown-edit-preview";

const PREVIEW_MARKDOWN = [
  "```ts",
  "const x = 1;",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  A --> B",
  "```",
].join("\n");

type ControlledHarnessProps = {
  readonly initialValue: string;
  readonly readOnly: boolean;
};

function ControlledMarkdownEditPreview(props: ControlledHarnessProps) {
  const [value, setValue] = useState(props.initialValue);
  return (
    <MarkdownEditPreview
      value={value}
      onChange={setValue}
      readOnly={props.readOnly}
      placeholder={undefined}
      ariaLabel="Markdown source"
      testId={TEST_ID}
      showPreview
    />
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

function requireContent(element: HTMLElement): HTMLElement {
  const content = element.querySelector(".cm-content");
  if (!(content instanceof HTMLElement)) {
    throw new Error("Expected CodeMirror content to render");
  }
  return content;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
}

describe("MarkdownEditPreview", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    cleanup();
  });

  it("preserves the draft when switching between edit and preview", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <ControlledMarkdownEditPreview
          initialValue="initial draft"
          readOnly={false}
        />
      </StrictMode>,
    );

    const editor = screen.getByTestId(TEST_ID);
    const textbox = screen.getByRole("textbox", { name: "Markdown source" });
    expect(readMarkdown(editor)).toBe("initial draft");

    replaceMarkdown(editor, "edited draft");
    expect(readMarkdown(editor)).toBe("edited draft");

    await user.click(screen.getByRole("tab", { name: "Preview" }));
    expect(
      screen.getByRole("textbox", { name: "Markdown source", hidden: true }),
    ).toBe(textbox);
    expect(screen.getByTestId(`${TEST_ID}-preview`).textContent).toContain(
      "edited draft",
    );

    await user.click(screen.getByRole("tab", { name: "Edit" }));
    expect(readMarkdown(screen.getByTestId(TEST_ID))).toBe("edited draft");
  });

  it("renders a fenced code block and mermaid wrapper in preview", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <QueryClientProvider client={makeQueryClient()}>
          <MarkdownEditPreview
            value={PREVIEW_MARKDOWN}
            onChange={() => undefined}
            readOnly={false}
            placeholder={undefined}
            ariaLabel="Markdown source"
            testId={TEST_ID}
            showPreview
          />
        </QueryClientProvider>
      </StrictMode>,
    );

    await user.click(screen.getByRole("tab", { name: "Preview" }));

    const preview = screen.getByTestId(`${TEST_ID}-preview`);
    const fence = preview.querySelector("[data-quote-code-block]");
    if (!(fence instanceof HTMLElement)) {
      throw new Error("Expected a fenced code block in preview");
    }
    expect(fence.getAttribute("data-language")).toBe("ts");
    expect(fence.textContent).toContain("const x = 1;");
    const hasPlainFence =
      preview.querySelector("pre") !== null &&
      preview.querySelector("code") !== null;
    const hasHighlightedFence =
      preview.querySelector(".traycer-md-shiki") !== null;
    expect(hasPlainFence || hasHighlightedFence).toBe(true);
    expect(preview.querySelector(".tc-node-mermaid")).not.toBeNull();
  });

  it("locks editing when readOnly is true", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <StrictMode>
        <MarkdownEditPreview
          value="locked draft"
          onChange={onChange}
          readOnly
          placeholder={undefined}
          ariaLabel="Markdown source"
          testId={TEST_ID}
          showPreview
        />
      </StrictMode>,
    );

    const editor = screen.getByTestId(TEST_ID);
    const content = requireContent(editor);
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(content.getAttribute("aria-readonly")).toBe("true");
    expect(readMarkdown(editor)).toBe("locked draft");

    await user.click(content);
    await user.keyboard("should not appear");
    expect(onChange).not.toHaveBeenCalled();
    expect(readMarkdown(editor)).toBe("locked draft");
  });

  it("renders preview only when using MarkdownPreview", () => {
    render(
      <StrictMode>
        <MarkdownPreview value="# Hello from preview" />
      </StrictMode>,
    );

    expect(screen.getByText("Hello from preview")).toBeDefined();
    expect(screen.queryByRole("tab", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Editor view" })).toBeNull();
    expect(EditorView.findFromDOM(document.body)).toBeNull();
  });

  it("applies the CodeMirror theme class when the document theme changes", async () => {
    render(
      <StrictMode>
        <MarkdownEditPreview
          value="theme probe"
          onChange={() => undefined}
          readOnly={false}
          placeholder={undefined}
          ariaLabel="Markdown source"
          testId={TEST_ID}
          showPreview
        />
      </StrictMode>,
    );

    expect(
      screen.getByTestId(TEST_ID).classList.contains("cm-theme-light"),
    ).toBe(true);
    expect(
      screen.getByTestId(TEST_ID).classList.contains("cm-theme-dark"),
    ).toBe(false);

    document.documentElement.classList.add("dark");
    await waitFor(() => {
      expect(
        screen.getByTestId(TEST_ID).classList.contains("cm-theme-dark"),
      ).toBe(true);
    });

    document.documentElement.classList.remove("dark");
    await waitFor(() => {
      expect(
        screen.getByTestId(TEST_ID).classList.contains("cm-theme-light"),
      ).toBe(true);
    });
  });
});
