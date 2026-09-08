import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
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
  readonly identity:
    | {
        readonly changed: boolean;
        readonly canSave: boolean;
        readonly save: () => Promise<unknown>;
      }
    | null
    | undefined;
  readonly onSave:
    | ((scripts: WorktreeEntryScripts) => Promise<unknown>)
    | undefined;
}) {
  let identity: {
    readonly slot: ReactNode;
    readonly changed: boolean;
    readonly canSave: boolean;
    readonly save: () => Promise<unknown>;
  } | null;
  if (overrides.identity === undefined) {
    identity = {
      slot: <button type="button">Change color</button>,
      changed: true,
      canSave: true,
      save: () => Promise.resolve(),
    };
  } else if (overrides.identity === null) {
    identity = null;
  } else {
    identity = {
      ...overrides.identity,
      slot: <button type="button">Change color</button>,
    };
  }
  return render(
    <ScriptsReviewDialog
      testId="worktree-script-review-dialog"
      title="Repository settings"
      description="Edit repository settings."
      pathLabel="Worktree path"
      pathValue="/tmp/wt"
      scriptSeed={seed}
      seedPending={false}
      errorNote={null}
      scriptsNote={null}
      repositoryDefaultsSlot={null}
      identity={identity}
      inUseNote={null}
      saveLabel="Save"
      onSave={overrides.onSave ?? (() => Promise.resolve())}
      onEscapeKeyDown={() => {}}
      onOpenChange={() => {}}
    />,
  );
}

/**
 * The Settings ▸ Worktrees delete-review caller reuses this same shell with no
 * repository to identify. It must keep rendering exactly as before - a null
 * identity renders no block, and must not disturb the save gate.
 */
describe("<ScriptsReviewDialog /> without identity", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the review shell with no identity block and Save disabled", () => {
    render(
      <ScriptsReviewDialog
        testId="worktree-script-review-dialog"
        title="Manage setup and teardown scripts"
        description="Edit the setup and teardown scripts for main."
        pathLabel="Worktree path"
        pathValue="/tmp/wt"
        scriptSeed={null}
        seedPending={false}
        errorNote={null}
        scriptsNote={null}
        repositoryDefaultsSlot={null}
        identity={null}
        inUseNote={null}
        saveLabel="Save"
        onSave={() => Promise.resolve()}
        onEscapeKeyDown={() => {}}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Manage setup and teardown scripts")).toBeTruthy();
    expect(screen.queryByTestId("repo-identity-fields")).toBeNull();
    // Nothing has changed yet, and there is no identity to change either.
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("<ScriptsReviewDialog /> save gates", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps Save disabled while an identity logo is still being prepared", () => {
    renderDialog({
      identity: {
        changed: true,
        canSave: false,
        save: () => Promise.resolve(),
      },
      onSave: undefined,
    });

    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables the complete editor until both writes settle, including one rejection", async () => {
    const scriptsWrite = deferred<unknown>();
    const identityWrite = deferred<unknown>();
    renderDialog({
      onSave: () => scriptsWrite.promise,
      identity: {
        changed: true,
        canSave: true,
        save: () => identityWrite.promise,
      },
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

    await act(async () => {
      identityWrite.resolve(undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  });
});
