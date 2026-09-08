import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScriptsReviewDialog } from "@/components/workspaces/scripts-review-dialog";

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
