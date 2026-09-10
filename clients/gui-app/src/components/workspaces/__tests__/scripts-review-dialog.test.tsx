import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WorktreeEntryScripts } from "@traycer/protocol/host/worktree-schemas";
import { ScriptsReviewDialog } from "@/components/workspaces/scripts-review-dialog";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const seed = {
  setup: { default: "echo setup", macos: null, linux: null, windows: null },
  teardown: {
    default: "echo teardown",
    macos: null,
    linux: null,
    windows: null,
  },
};

function renderDialog(overrides: {
  readonly onSave:
    | ((scripts: WorktreeEntryScripts) => Promise<unknown>)
    | undefined;
}) {
  return render(
    <ScriptsReviewDialog
      testId="worktree-script-review-dialog"
      title="Repository settings"
      description="Edit repository settings."
      path={{ label: "Worktree path", value: "/tmp/wt" }}
      scriptSeed={seed}
      seedPending={false}
      errorNote={null}
      scriptsNote={null}
      repositoryDefaultsSlot={null}
      inUseNote={null}
      saveLabel="Save"
      onSave={overrides.onSave ?? (() => Promise.resolve())}
      onEscapeKeyDown={() => {}}
      onOpenChange={() => {}}
    />,
  );
}

describe("<ScriptsReviewDialog />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the review shell with Save disabled", () => {
    render(
      <ScriptsReviewDialog
        testId="worktree-script-review-dialog"
        title="Manage setup and teardown scripts"
        description="Edit the setup and teardown scripts for main."
        path={{ label: "Worktree path", value: "/tmp/wt" }}
        scriptSeed={null}
        seedPending={false}
        errorNote={null}
        scriptsNote={null}
        repositoryDefaultsSlot={null}
        inUseNote={null}
        saveLabel="Save"
        onSave={() => Promise.resolve()}
        onEscapeKeyDown={() => {}}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Manage setup and teardown scripts")).toBeTruthy();
    // Nothing has changed yet.
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("<ScriptsReviewDialog /> save gates", () => {
  afterEach(() => {
    cleanup();
  });

  it("disables the complete editor until a rejected write settles", async () => {
    const scriptsWrite = deferred<unknown>();
    renderDialog({
      onSave: () => scriptsWrite.promise,
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Setup script (Default)" }),
      { target: { value: "echo changed" } },
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);

    expect(save.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("textbox", { name: "Setup script (Default)" })
        .matches(":disabled"),
    ).toBe(true);

    await act(async () => {
      scriptsWrite.reject(new Error("scripts failed"));
      await Promise.resolve();
    });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("textbox", { name: "Setup script (Default)" })
        .matches(":disabled"),
    ).toBe(true);

    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  });
});
