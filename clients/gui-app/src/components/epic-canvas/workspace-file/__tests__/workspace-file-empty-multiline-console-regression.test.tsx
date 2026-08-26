import "../../../../../__tests__/test-browser-apis";
import { useCallback, useState, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { getRegisteredDiffEditor } from "@/components/diff/diff-click-to-edit";
import {
  useDiffClickToEdit,
  type DiffEditActivationRequest,
  type DiffEditActivationResult,
} from "@/components/diff/use-diff-click-to-edit";
import { WorkspaceFileRenderer } from "@/components/epic-canvas/workspace-file/workspace-file-renderer";
import { EMPTY_ORIGIN_AFFORDANCE_TEST_ID } from "@/components/diff/empty-origin-edit-affordance";

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark" }),
}));

/**
 * Real, unmocked `@pierre/diffs@1.3.1` regression for RESUME9, exercised
 * through the actual `WorkspaceFileRenderer` rendering pipeline (not the
 * library directly - see `workspace-empty-file-cachekey-console-regression.test.ts`
 * for the library-level proof of the underlying defect).
 *
 * Activates an empty file, types a second line, then blurs (discarding the
 * unsaved draft back to empty, and detaching the editor - matching a
 * pointer-activation sub-test's cleanup before a keyboard-activation
 * sub-test reuses the same file identity/tile). Before the fix,
 * `WorkspaceFileRenderer` re-derived `<File file={...}>` from the live
 * `content` prop on every render while keeping a `file.cacheKey` stable for
 * the whole file's lifetime - exactly the pattern that trips the library's
 * stale line-count cache once the editor is no longer attached to correct
 * the incoming snapshot. The fix bumps a generation counter into
 * `cacheKey` on every `editing` transition instead: `Editor`'s
 * `persistState` still needs a cacheKey stable for the whole of one
 * attached session, but the key now differs the moment that session ends,
 * so a post-session render can never hit the stale cache.
 */
const originalGetContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
let originalPostMessage: typeof window.postMessage;
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    }),
  });
  originalPostMessage = window.postMessage.bind(window);
  const realPostMessage = originalPostMessage;
  window.postMessage = ((message: unknown) =>
    realPostMessage(message, "*")) as typeof window.postMessage;
});

afterAll(() => {
  if (originalGetContextDescriptor !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContextDescriptor,
    );
  }
  window.postMessage = originalPostMessage;
});

const SURFACE_ID = "empty-multiline-regression-surface";

function EmptyFileEditHarness(): ReactNode {
  const [draftContent, setDraftContent] = useState("");
  const [editing, setEditing] = useState(false);
  const onActivate = useCallback(
    async (
      request: DiffEditActivationRequest,
    ): Promise<DiffEditActivationResult> => {
      await request.editorReady;
      setEditing(true);
      return { kind: "activated" };
    },
    [],
  );
  const editAdapter = useDiffClickToEdit({
    surfaceId: SURFACE_ID,
    enabled: true,
    active: editing,
    onActivate,
    onActivationError: () => undefined,
    onChange: setDraftContent,
    // Discards the unsaved draft on blur, back to the disk baseline (empty)
    // - matching a certification harness resetting a pointer-activation
    // sub-test's typed content before a keyboard-activation sub-test reuses
    // the SAME kept-alive tile/file identity.
    onBlur: () => {
      setEditing(false);
      setDraftContent("");
    },
    onSaveShortcut: () => undefined,
  });

  return (
    <div>
      {/* Exercised directly instead of a real DOM blur event: jsdom does not
          reliably move focus into a shadow-DOM contentEditable region, so a
          real `.blur()` call on the editor never dispatches the underlying
          `blur` event here. Calling the adapter's own exposed `onBlur`
          drives the exact same production code path
          (`use-diff-click-to-edit.ts`'s `editorOptions.onBlur`) without
          depending on jsdom's focus simulation. */}
      <button
        type="button"
        onClick={() => {
          editAdapter.editorOptions.onBlur?.();
        }}
      >
        Blur
      </button>
      <WorkspaceFileRenderer
        content={draftContent}
        fileName="empty.txt"
        language="text"
        editing={editing}
        editAdapter={editAdapter}
        wordWrap={false}
        revealLine={null}
        revealNonce={null}
        findTarget={null}
        onRevealConsumed={() => undefined}
        fileIdentity={null}
      />
    </div>
  );
}

describe("empty workspace file: real activation, multi-line insert, then blur back to empty (RESUME9 regression)", () => {
  it("preserves the native Diffs undo and redo timeline across controlled rerenders", async () => {
    const rendered = render(<EmptyFileEditHarness />);

    fireEvent.click(rendered.getByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID));
    await waitFor(() => {
      expect(getRegisteredDiffEditor(SURFACE_ID)).not.toBeUndefined();
    });
    const editor = getRegisteredDiffEditor(SURFACE_ID);
    if (editor === undefined) throw new Error("editor never attached");

    await act(async () => {
      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "undoable draft",
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(editor.canUndo).toBe(true);
    expect(editor.getFile()?.contents).toBe("undoable draft");
    const fileHost = rendered.container.querySelector("diffs-container");
    const contentElement =
      fileHost?.shadowRoot?.querySelector<HTMLElement>("[data-content]");
    if (contentElement === null || contentElement === undefined) {
      throw new Error("editor content element never rendered");
    }
    const detectedPlatform =
      navigator.platform.length > 0
        ? navigator.platform
        : (navigator.userAgentData?.platform ?? "unknown");
    const macLike = /macOS|MacIntel|iPhone|iPad|iPod/i.test(detectedPlatform);
    const primaryModifier = macLike ? { metaKey: true } : { ctrlKey: true };
    act(() => {
      contentElement.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "KeyZ",
          ...primaryModifier,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    });
    expect(editor.getFile()?.contents).toBe("");
    expect(editor.canRedo).toBe(true);

    act(() => {
      contentElement.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "KeyZ",
          ...primaryModifier,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    });
    expect(editor.getFile()?.contents).toBe("undoable draft");
    cleanup();
  });

  it("typing a second line then blurring back to empty under the same file identity causes no console error and no throw", async () => {
    const consoleErrors: unknown[][] = [];
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });

    try {
      const rendered = render(<EmptyFileEditHarness />);

      const affordance = rendered.getByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID);
      fireEvent.click(affordance);

      await waitFor(() => {
        expect(getRegisteredDiffEditor(SURFACE_ID)).not.toBeUndefined();
      });
      const editor = getRegisteredDiffEditor(SURFACE_ID);
      if (editor === undefined) throw new Error("editor never attached");

      // The first content this previously-empty file ever receives spans TWO
      // lines - the exact "0 lines -> multiple lines" jump the E2E session
      // hit - driven through the real Editor API (not a raw keyboard-event
      // simulation, since jsdom's contentEditable typing isn't reliable) so
      // `onChange` fires and the harness's real React state (and therefore
      // the real `<File file={...}>` prop) updates exactly the way
      // `workspace-file-tile.tsx`'s `renderedContent` does in production.
      await act(async () => {
        editor.applyEdits([
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "line one\nline two",
          },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Blur discards the unsaved draft back to empty and detaches the
      // editor - the reverted-to-empty render that follows is the one that
      // happens WITHOUT an attached editor's own reconciliation protecting
      // it.
      fireEvent.click(rendered.getByRole("button", { name: "Blur" }));
      await act(async () => {
        // Give any of the library's own scheduled/deferred render or
        // background-tokenize passes a chance to actually run and throw -
        // the real regression fires from one of those, not synchronously
        // from the blur callback itself.
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(
        rendered.container.querySelector("[data-diffs-host]"),
      ).toBeTruthy();
    } finally {
      consoleErrorSpy.mockRestore();
      cleanup();
    }

    expect(consoleErrors).toEqual([]);
  });
});
