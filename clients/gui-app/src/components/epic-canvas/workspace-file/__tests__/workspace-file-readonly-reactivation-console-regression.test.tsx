import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  useDiffClickToEdit,
  type DiffEditActivationResult,
} from "@/components/diff/use-diff-click-to-edit";
import { WorkspaceFileRenderer } from "@/components/epic-canvas/workspace-file/workspace-file-renderer";

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark" }),
}));

/**
 * Real, unmocked `@pierre/diffs@1.3.1` regression for RESUME12, exercised
 * through the actual `WorkspaceFileRenderer` rendering pipeline (library-level
 * proof in `workspace-readonly-cachekey-console-regression.test.ts`).
 *
 * A purely read-only tile - `editing` never true - whose `content` prop
 * changes because a reactivation refetch resolved (`workspace-file-tile.tsx`'s
 * inactive->active `query.refetch()`), not because anything was typed. Before
 * the RESUME12 fix, `WorkspaceFileRenderer` kept a stable `file.cacheKey`
 * whenever `editing` was false just as much as when it was true (the RESUME9
 * fix only bumped the generation on an `editing` transition), so this content
 * change hit the same stale line-cache defect RESUME9 fixed for the editing
 * case. The fix omits `cacheKey` entirely while `editing` is false.
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

const SURFACE_ID = "readonly-reactivation-regression-surface";

function ReadOnlyFileHarness(props: { readonly content: string }): ReactNode {
  const editAdapter = useDiffClickToEdit({
    surfaceId: SURFACE_ID,
    enabled: false,
    active: false,
    onActivate: (): Promise<DiffEditActivationResult> =>
      Promise.resolve({ kind: "rejected" }),
    onActivationError: () => undefined,
    onChange: () => undefined,
    onBlur: () => undefined,
    onSaveShortcut: () => undefined,
  });

  return (
    <WorkspaceFileRenderer
      content={props.content}
      fileName="src/index.ts"
      language="typescript"
      editing={false}
      editAdapter={editAdapter}
      wordWrap={false}
      revealLine={null}
      revealNonce={null}
      findTarget={null}
      onRevealConsumed={() => undefined}
      fileIdentity={null}
    />
  );
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("read-only workspace file: reactivation refetch changes content while editing stays false (RESUME12 regression)", () => {
  it("a content shrink across a reactivation refetch (never editing) causes no console error and no throw", async () => {
    const consoleErrors: unknown[][] = [];
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });

    try {
      const FIVE_LINES = "line one\nline two\nline three\nline four\nline five";
      const rendered = render(<ReadOnlyFileHarness content={FIVE_LINES} />);
      await settle(50);

      // The reactivation refetch resolves with far fewer lines - matches an
      // external truncation, or simply a shorter file than this tab last saw
      // before going inactive. `editing` is never touched by this rerender.
      rendered.rerender(<ReadOnlyFileHarness content="line one" />);
      await settle(100);

      expect(
        rendered.container.querySelector("[data-diffs-host]"),
      ).toBeTruthy();
    } finally {
      consoleErrorSpy.mockRestore();
      cleanup();
    }

    expect(consoleErrors).toEqual([]);
  });

  it("a content grow across a reactivation refetch (never editing) causes no console error and no throw", async () => {
    const consoleErrors: unknown[][] = [];
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });

    try {
      const rendered = render(<ReadOnlyFileHarness content="line one" />);
      await settle(50);

      rendered.rerender(
        <ReadOnlyFileHarness content={"a\nb\nc\nd\ne\nf\ng"} />,
      );
      await settle(100);

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
