import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  useDiffClickToEdit,
  type DiffEditActivationResult,
} from "@/components/diff/use-diff-click-to-edit";
import type { FileContents } from "@pierre/diffs/react";

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark" }),
}));

interface CapturedFileState {
  readonly capture: Mock<(cacheKey: string | undefined) => void>;
}

const state = vi.hoisted((): CapturedFileState => ({ capture: vi.fn() }));

vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...actual,
    File: (props: { readonly file: FileContents }): ReactNode => {
      state.capture(props.file.cacheKey);
      return <div data-testid="mock-diffs-file" />;
    },
  };
});

import { WorkspaceFileRenderer } from "@/components/epic-canvas/workspace-file/workspace-file-renderer";

const SURFACE_ID = "cachekey-lifecycle-surface";

function CacheKeyLifecycleHarness(): ReactNode {
  const [content, setContent] = useState("line one");
  const [editing, setEditing] = useState(false);
  const editAdapter = useDiffClickToEdit({
    surfaceId: SURFACE_ID,
    enabled: true,
    active: editing,
    onActivate: async (request): Promise<DiffEditActivationResult> => {
      await request.editorReady;
      setEditing(true);
      return { kind: "activated" };
    },
    onActivationError: () => undefined,
    onChange: setContent,
    onBlur: () => {
      setEditing(false);
    },
    onSaveShortcut: () => undefined,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          editAdapter.fileOptions.onLineClick?.({
            type: "line",
            lineNumber: 1,
            lineElement: document.createElement("div"),
            numberElement: document.createElement("div"),
            numberColumn: false,
            event: new PointerEvent("click", { button: 0 }),
          });
        }}
      >
        Click source
      </button>
      <button
        type="button"
        onClick={() => {
          const file = { name: "src/index.ts", contents: `${content}!` };
          editAdapter.editorOptions.onChange?.(file, undefined, {
            changes: [],
            file,
          });
        }}
      >
        Type
      </button>
      <button
        type="button"
        onClick={() => {
          editAdapter.editorOptions.onBlur?.();
        }}
      >
        Blur
      </button>
      <WorkspaceFileRenderer
        content={content}
        fileName="src/index.ts"
        language="typescript"
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

describe("<WorkspaceFileRenderer /> cacheKey lifecycle", () => {
  afterEach(() => {
    cleanup();
    state.capture.mockReset();
  });

  it("is unkeyed while read-only, keys and holds one generation across keystrokes for the session, unkeys on blur, and issues a fresh generation on re-entry", async () => {
    render(<CacheKeyLifecycleHarness />);

    // Mounted read-only: no key at all.
    expect(state.capture).toHaveBeenLastCalledWith(undefined);
    state.capture.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    // Wait for the re-render this click causes, not for a button that is
    // already on screen: activation is async (`onActivate` awaits
    // `editorReady` before `setEditing`), and the "Type" button is rendered
    // unconditionally, so `findByRole` on it resolves without that chain
    // having settled. The assertion below then reads an untouched mock and
    // fails on a FAST machine - the slower the host, the more likely the
    // stray microtasks let it through.
    await waitFor(() => {
      expect(state.capture).toHaveBeenCalled();
    });
    const firstSessionKeys = state.capture.mock.calls.map((call) => call[0]);
    expect(firstSessionKeys.length).toBeGreaterThan(0);
    // Every call for this activation carries the SAME key (generation 1) -
    // `persistState` requires this to stay stable for the whole session.
    expect(new Set(firstSessionKeys).size).toBe(1);
    const firstKey = firstSessionKeys[0];
    expect(firstKey).not.toBeUndefined();
    state.capture.mockClear();

    // Keystrokes: content changes, key must not.
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(state.capture).toHaveBeenLastCalledWith(firstKey);
    state.capture.mockClear();

    // Leaving edit: unkeyed again.
    fireEvent.click(screen.getByRole("button", { name: "Blur" }));
    expect(state.capture).toHaveBeenLastCalledWith(undefined);
    state.capture.mockClear();

    // Re-entering: a fresh generation, never the prior session's key.
    fireEvent.click(screen.getByRole("button", { name: "Click source" }));
    await screen.findByRole("button", { name: "Type" });
    expect(state.capture).toHaveBeenCalled();
    const secondKey = state.capture.mock.calls.at(-1)?.[0];
    expect(secondKey).not.toBeUndefined();
    expect(secondKey).not.toBe(firstKey);
  });
});
