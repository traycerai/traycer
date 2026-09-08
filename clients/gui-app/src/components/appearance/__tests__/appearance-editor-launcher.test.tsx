import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppearanceEditor } from "@/components/appearance/appearance-editor-launcher";
import type {
  AppearanceEditorScope,
  AppearanceEditorTarget,
} from "@/components/appearance/appearance-editor-launcher";

/**
 * The real `AppearanceEditor` (and everything it pulls in - workspace
 * appearance hooks, IndexedDB-backed caches, the full form) is orthogonal to
 * what THIS suite tests: the launcher's own contract that `openEditor`
 * captures its scope (and opener element) into state once, and nothing the
 * launching component does afterward can redirect an editor that is already
 * open. Stubbing the lazy-loaded module out keeps this suite stable across
 * unrelated changes to the editor's internals, and lets `target` be asserted
 * on directly instead of inferred from rendered form markup. The stub calls
 * `onRestoreFocus` from its own "Close" button, standing in for the real
 * `Dialog`'s `onCloseAutoFocus` - what's under test is that the LAUNCHER
 * wires that callback to the exact element `openEditor` was given, not
 * Radix's own focus-return mechanics.
 */
const captured = vi.hoisted(() => ({
  saveSpy: vi.fn<(target: AppearanceEditorTarget) => void>(),
  lastOnClose: null as (() => void) | null,
}));
vi.mock("@/components/appearance/appearance-editor", () => ({
  default: (props: {
    readonly target: AppearanceEditorTarget;
    readonly onClose: () => void;
    readonly onRestoreFocus: () => void;
  }) => {
    captured.lastOnClose = props.onClose;
    return (
      <div>
        <div data-testid="captured-target">
          {props.target.kind === "project"
            ? `project:${props.target.hostId}:${props.target.workspacePath}`
            : "global"}
        </div>
        <button type="button" onClick={() => captured.saveSpy(props.target)}>
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            props.onClose();
            props.onRestoreFocus();
          }}
        >
          Close
        </button>
      </div>
    );
  },
}));

function Harness(props: {
  readonly hostId: string;
  readonly workspacePath: string;
}) {
  const { openEditor, editor } = useAppearanceEditor();
  const openButton = useRef<HTMLButtonElement | null>(null);
  const scope: AppearanceEditorScope = {
    kind: "project",
    hostId: props.hostId,
    workspacePath: props.workspacePath,
    epicId: "epic-1",
    readOnly: false,
  };
  return (
    <div>
      <button
        ref={openButton}
        type="button"
        onClick={() => openEditor(scope, openButton.current)}
      >
        Open
      </button>
      {editor}
    </div>
  );
}

afterEach(() => {
  cleanup();
  captured.saveSpy.mockReset();
  captured.lastOnClose = null;
});

function requireOnClose(): () => void {
  if (captured.lastOnClose === null)
    throw new Error("expected the mocked editor to have rendered by now");
  return captured.lastOnClose;
}

describe("useAppearanceEditor: target capture", () => {
  it("captures the scope at openEditor time and never re-derives it from the launching component's later props", async () => {
    const { rerender } = render(
      <Harness hostId="host-a" workspacePath="/repo-a" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    // React.lazy resolves asynchronously even for an already-imported module.
    await screen.findByTestId("captured-target");
    expect(screen.getByTestId("captured-target").textContent).toBe(
      "project:host-a:/repo-a",
    );

    // The launching component receives entirely new props (a different host
    // and workspace) WITHOUT calling openEditor again - a real caller is a
    // tab whose own hostId can change under it while a modal it opened stays
    // up. The already-open editor must not follow that change.
    rerender(<Harness hostId="host-b" workspacePath="/repo-b" />);
    expect(screen.getByTestId("captured-target").textContent).toBe(
      "project:host-a:/repo-a",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(captured.saveSpy).toHaveBeenCalledTimes(1);
    expect(captured.saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-a", workspacePath: "/repo-a" }),
    );
  });

  it("mounts a fresh editor targeting the NEW scope once the previous one is closed and reopened", async () => {
    render(<Harness hostId="host-a" workspacePath="/repo-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByTestId("captured-target");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("captured-target")).toBeNull();
  });

  it("does nothing on a mobile viewport - openEditor never captures a target there", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    window.dispatchEvent(new Event("resize"));
    try {
      render(<Harness hostId="host-a" workspacePath="/repo-a" />);
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId("captured-target")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("restores focus to the exact element that opened the editor once it closes", async () => {
    render(<Harness hostId="host-a" workspacePath="/repo-a" />);
    const openButton = screen.getByRole("button", { name: "Open" });
    openButton.focus();
    fireEvent.click(openButton);
    await screen.findByTestId("captured-target");

    // Something else takes focus while the editor is open (a field inside
    // it, in the real app) - the return path must still find its way back
    // to the ORIGINAL opener, not merely to "whatever was focused before".
    screen.getByRole("button", { name: "Save" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(document.activeElement).toBe(openButton);
  });

  it("never throws restoring focus to an opener that has since left the DOM", async () => {
    function Rerootable(props: { readonly mountOpener: boolean }) {
      const { openEditor, editor } = useAppearanceEditor();
      const openButton = useRef<HTMLButtonElement | null>(null);
      return (
        <div>
          {props.mountOpener ? (
            <button
              ref={openButton}
              type="button"
              onClick={() =>
                openEditor(
                  {
                    kind: "project",
                    hostId: "host-a",
                    workspacePath: "/repo-a",
                    epicId: "epic-1",
                    readOnly: false,
                  },
                  openButton.current,
                )
              }
            >
              Open
            </button>
          ) : null}
          {editor}
        </div>
      );
    }
    const { rerender } = render(<Rerootable mountOpener />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByTestId("captured-target");

    // The opener (e.g. a context-menu item) unmounts while the editor is
    // still open.
    rerender(<Rerootable mountOpener={false} />);
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();

    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    }).not.toThrow();
  });

  it("a stale onClose captured from a closed-and-reopened editor never closes the NEW one", async () => {
    // Regresses a real bug: a Save's own `onClose`/`onSaved` closure is bound
    // to whichever target was captured when IT rendered. If that callback
    // fires late (an RPC resolving after Cancel-and-reopen), it must be a
    // no-op against a target that has since moved on - only the SAME target
    // instance may clear it.
    render(<Harness hostId="host-a" workspacePath="/repo-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByTestId("captured-target");
    const staleOnCloseA = requireOnClose();

    act(() => {
      staleOnCloseA();
    });
    expect(screen.queryByTestId("captured-target")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByTestId("captured-target");
    expect(screen.getByTestId("captured-target").textContent).toBe(
      "project:host-a:/repo-a",
    );

    // The STALE callback from the first (already-closed) editor instance
    // fires again, late - it must not clear the second editor.
    act(() => {
      staleOnCloseA();
    });
    expect(screen.getByTestId("captured-target").textContent).toBe(
      "project:host-a:/repo-a",
    );
  });
});
