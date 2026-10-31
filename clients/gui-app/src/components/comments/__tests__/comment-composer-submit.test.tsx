import { createRef, type Ref } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { createAppQueryClient } from "@/lib/query-client";
import {
  CommentComposer,
  type CommentComposerHandle,
} from "@/components/comments/comment-composer";
import {
  composerEditorAt,
  createDeferred,
  settle,
  typeIntoEditor,
} from "./comment-submit-test-support";

/**
 * A comment is written once per press of Submit. The composer cannot rely on
 * `isPending` alone to guarantee that: the prop only changes on the render
 * AFTER the first call, so a second click or Ctrl+Enter in the same turn still
 * sees an idle composer. These tests drive the real Tiptap editor and the real
 * button, and hold the submission open with a promise the test settles.
 */

type SubmitHandler = (content: JsonContent) => Promise<void>;

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = createAppQueryClient();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

interface RenderComposerArgs {
  readonly onSubmit: SubmitHandler;
  readonly isPending: boolean;
  readonly initialContent: JsonContent | null;
  readonly handleRef: Ref<CommentComposerHandle> | undefined;
}

function composerElement(args: RenderComposerArgs) {
  return (
    <QueryClientProvider client={queryClient}>
      <CommentComposer
        leadingActions={null}
        epicId="epic-1"
        hostClient={null}
        initialContent={args.initialContent}
        placeholder="Write a comment"
        focusOnMount={false}
        submitLabel="Comment"
        isPending={args.isPending}
        onSubmit={args.onSubmit}
        onCancel={null}
        leadingActions={null}
        className={undefined}
        ref={args.handleRef}
      />
    </QueryClientProvider>
  );
}

async function renderComposer(args: RenderComposerArgs) {
  const view = render(composerElement(args));
  await screen.findByRole("button", { name: /^Comment/ });
  return {
    rerenderPending(isPending: boolean) {
      view.rerender(composerElement({ ...args, isPending }));
    },
  };
}

function submitButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Comment/ });
}

function pressCtrlEnter(): void {
  fireEvent.keyDown(composerEditorAt(0).view.dom, {
    key: "Enter",
    ctrlKey: true,
  });
}

function submittedText(
  onSubmit: Mock<SubmitHandler>,
  callIndex: number,
): string {
  return JSON.stringify(onSubmit.mock.calls[callIndex]?.[0]);
}

describe("<CommentComposer /> single-flight submit", () => {
  it("invokes onSubmit once for repeated clicks and Ctrl+Enter while the promise is pending", async () => {
    const pending = createDeferred<void>();
    const onSubmit = vi.fn<SubmitHandler>(() => pending.promise);
    await renderComposer({
      onSubmit,
      isPending: false,
      initialContent: null,
      handleRef: undefined,
    });
    typeIntoEditor(composerEditorAt(0), "first comment");

    // One act block: React cannot re-render between these, so `isPending` is
    // still false for every gesture. Only a synchronous latch stops them.
    act(() => {
      fireEvent.click(submitButton());
      fireEvent.click(submitButton());
      pressCtrlEnter();
      pressCtrlEnter();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submittedText(onSubmit, 0)).toContain("first comment");

    // Still held open across later turns too, not only the first one.
    await settle();
    fireEvent.click(submitButton());
    pressCtrlEnter();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    pending.resolve();
    await settle();
  });

  it("keeps the typed text and unlocks for a retry when the submission rejects", async () => {
    const rejection = createDeferred<void>();
    const onSubmit = vi
      .fn<SubmitHandler>()
      .mockImplementationOnce(() => rejection.promise)
      .mockResolvedValue(undefined);
    await renderComposer({
      onSubmit,
      isPending: false,
      initialContent: null,
      handleRef: undefined,
    });
    const editor = composerEditorAt(0);
    typeIntoEditor(editor, "do not lose me");

    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Text typed while the save is in flight would be erased by its success.
    expect(editor.isEditable).toBe(false);
    expect(editor.view.dom.getAttribute("contenteditable")).toBe("false");

    rejection.reject(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "host said no",
        requestId: "test",
        method: "epic.createCommentThread",
        fatalDetails: null,
      }),
    );
    await waitFor(() => {
      expect(submitButton().hasAttribute("disabled")).toBe(false);
    });
    expect(editor.isEditable).toBe(true);
    expect(editor.view.dom.getAttribute("contenteditable")).toBe("true");
    expect(editor.getText()).toBe("do not lose me");

    fireEvent.click(submitButton());
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(submittedText(onSubmit, 1)).toContain("do not lose me");
  });
});

describe("<CommentComposer /> pending state", () => {
  it("disables the button and ignores Ctrl+Enter while isPending, and re-enables after", async () => {
    const onSubmit = vi.fn<SubmitHandler>(() => Promise.resolve());
    const view = await renderComposer({
      onSubmit,
      isPending: true,
      initialContent: null,
      handleRef: undefined,
    });
    typeIntoEditor(composerEditorAt(0), "queued behind a save");

    expect(submitButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(submitButton());
    pressCtrlEnter();
    expect(onSubmit).not.toHaveBeenCalled();

    view.rerenderPending(false);
    expect(submitButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("<CommentComposer /> reply flow", () => {
  it("accepts a second submission after a successful submit that reset the editor", async () => {
    const handleRef = createRef<CommentComposerHandle>();
    const onSubmit = vi.fn<SubmitHandler>(() => {
      // What the reply card does on success: empty the composer for the next
      // reply. The latch has to be released after this, not before.
      handleRef.current?.reset();
      return Promise.resolve();
    });
    await renderComposer({
      onSubmit,
      isPending: false,
      initialContent: null,
      handleRef,
    });
    const editor = composerEditorAt(0);

    typeIntoEditor(editor, "first reply");
    fireEvent.click(submitButton());
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(editor.isEmpty).toBe(true);
    expect(submitButton().hasAttribute("disabled")).toBe(true);

    typeIntoEditor(editor, "second reply");
    fireEvent.click(submitButton());
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(submittedText(onSubmit, 0)).toContain("first reply");
    expect(submittedText(onSubmit, 1)).toContain("second reply");
    expect(submittedText(onSubmit, 1)).not.toContain("first reply");
  });
});

describe("<CommentComposer /> edit composer", () => {
  it("submits the saved comment through its own onSubmit exactly once", async () => {
    const saved: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "saved text" }] },
      ],
    };
    const pending = createDeferred<void>();
    const onSubmit = vi.fn<SubmitHandler>(() => pending.promise);
    await renderComposer({
      onSubmit,
      isPending: false,
      initialContent: saved,
      handleRef: undefined,
    });

    // Opens non-empty, so Save is available before the user types anything.
    expect(submitButton().hasAttribute("disabled")).toBe(false);

    act(() => {
      fireEvent.click(submitButton());
      fireEvent.click(submitButton());
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submittedText(onSubmit, 0)).toContain("saved text");

    pending.resolve();
    await settle();
  });
});
