import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoPolicyEditorDialog } from "@/components/settings/panels/auto-policy-editor-dialog";
import {
  AUTO_POLICY_MAX_BYTES,
  AUTO_POLICY_TEMPLATE,
  autoPolicyByteLength,
  autoPolicyChangedSinceLoad,
} from "@/components/settings/panels/auto-policy-document";

afterEach(() => {
  cleanup();
});

describe("autoPolicyChangedSinceLoad", () => {
  it("is TRUE when the loaded stamp is null and the current one is real - a policy was created after this window loaded none", () => {
    expect(autoPolicyChangedSinceLoad(null, "2026-09-10T00:00:00.000Z")).toBe(
      true,
    );
  });

  it("is false when the current stamp is null", () => {
    expect(autoPolicyChangedSinceLoad("2026-09-10T00:00:00.000Z", null)).toBe(
      false,
    );
  });

  it("is false when both stamps are null", () => {
    expect(autoPolicyChangedSinceLoad(null, null)).toBe(false);
  });

  it("is false when the stamps are identical", () => {
    const stamp = "2026-09-10T00:00:00.000Z";
    expect(autoPolicyChangedSinceLoad(stamp, stamp)).toBe(false);
  });

  it("is true only when both stamps are non-null and different", () => {
    expect(
      autoPolicyChangedSinceLoad(
        "2026-09-10T00:00:00.000Z",
        "2026-09-10T00:05:00.000Z",
      ),
    ).toBe(true);
  });
});

describe("autoPolicyByteLength", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const emoji = "🚀";
    expect(emoji.length).toBe(2); // surrogate pair
    expect(autoPolicyByteLength(emoji)).toBeGreaterThan(emoji.length);
  });

  it("counts ASCII text as one byte per character", () => {
    expect(autoPolicyByteLength("abc")).toBe(3);
  });
});

describe("<AutoPolicyEditorDialog />", () => {
  it("prefills the template with all four headings when there is no saved policy", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody={null}
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId(
      "auto-policy-input",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe(AUTO_POLICY_TEMPLATE);
    expect(textarea.value).toMatch(/## Environment/);
    expect(textarea.value).toMatch(/## Allow/);
    expect(textarea.value).toMatch(/## Soft deny/);
    expect(textarea.value).toMatch(/## Hard deny/);
  });

  it("disables Save until the text changes from the initial body", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="## Environment\n"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const textarea = screen.getByTestId("auto-policy-input");
    fireEvent.change(textarea, { target: { value: "## Environment\nfoo" } });

    expect(saveButton.disabled).toBe(false);
  });

  it("disables Save while the body is over the byte cap even if it changed", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId("auto-policy-input");
    const oversized = "a".repeat(AUTO_POLICY_MAX_BYTES + 1);
    fireEvent.change(textarea, { target: { value: oversized } });

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("calls onSave with the edited text verbatim", () => {
    const onSave = vi.fn();
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    const textarea = screen.getByTestId("auto-policy-input");
    fireEvent.change(textarea, { target: { value: "short and edited" } });
    fireEvent.click(screen.getByTestId("auto-policy-save"));

    expect(onSave).toHaveBeenCalledWith("short and edited");
  });

  it("shows the stale warning only when both timestamps are non-null and different", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt="2026-09-10T00:00:00.000Z"
        currentUpdatedAt="2026-09-10T00:05:00.000Z"
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("auto-policy-stale-warning")).toBeTruthy();
  });

  it("hides the stale warning when the current timestamp is unknown", () => {
    // A null CURRENT value is "cannot tell" - the refetch has not answered -
    // and a warning on it would fire on every open for a round trip.
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt="2026-09-10T00:00:00.000Z"
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("auto-policy-stale-warning")).toBeNull();
  });

  it("shows the stale warning when the editor opened on no policy and another device has since created one", () => {
    // A null LOADED value against a real current one is not "cannot tell":
    // it is proof of a creation this window never saw, and a save would
    // replace it.
    render(
      <AutoPolicyEditorDialog
        initialBody=""
        loadedUpdatedAt={null}
        currentUpdatedAt="2026-09-10T00:05:00.000Z"
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("auto-policy-stale-warning")).toBeTruthy();
  });

  // The class IS the behaviour under test here: it is the only thing tying
  // this control to Appearance ▸ Code font size, and the regression this
  // pins was invisible to every other kind of assertion. `size="xs"` here
  // was wrong twice over - it pinned 12px at every width AND stopped
  // tracking the preference, while the class actually in effect BEFORE was
  // `md:text-ui-sm` (a caller's unmodified `text-code-sm` never displaced a
  // `md:`-modified class).
  it("keeps the policy textarea on the code font scale, not a ui text size", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId("auto-policy-input");
    expect(textarea.className.split(/\s+/)).toContain("text-code-sm");
    expect(textarea.className).not.toMatch(/\btext-ui-\w+\b/);
  });
});

describe('<AutoPolicyEditorDialog /> readState="unreadable"', () => {
  it("disables Save even when the text is dirty and under the byte cap", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="unreadable"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId("auto-policy-input");
    fireEvent.change(textarea, { target: { value: "short and edited" } });

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("renders the unreadable-policy warning banner", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="unreadable"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("auto-policy-unreadable-warning")).toBeTruthy();
  });
});

describe("<AutoPolicyEditorDialog /> saving", () => {
  // Save captures `body` at click time and the parent closes this dialog on
  // success; an editable textarea in that window silently discards whatever
  // was typed after the click while the host stores the earlier text. This
  // pins the draft locked, not just the Save button.
  it("disables the textarea and refuses further edits while saving", async () => {
    const user = userEvent.setup();
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId(
      "auto-policy-input",
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);

    // `userEvent`, unlike `fireEvent`, honors the `disabled` attribute the
    // way a real browser does - `fireEvent.change` would still write through
    // and pass falsely even against a dead textarea.
    await user.type(textarea, "more text");
    expect(textarea.value).toBe("short");
  });

  // Cancel/Esc mid-write hides an in-flight save behind a closed dialog: the
  // write still lands, and the user has no reason to believe it did.
  it("disables Cancel and does not call onCancel while saving", () => {
    const onCancel = vi.fn();
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    );

    const cancelButton = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(true);

    fireEvent.click(cancelButton);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not call onCancel on Escape while saving", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  // Control for the three cases above: without it, every assertion there
  // would pass against a dialog that is simply permanently dead.
  it("keeps the textarea and Cancel live when not saving", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId(
      "auto-policy-input",
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "short and edited" } });
    expect(textarea.value).toBe("short and edited");

    const cancelButton = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(false);
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledTimes(1);

    onCancel.mockClear();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("<AutoPolicyEditorDialog /> readable read states", () => {
  it("hides the unreadable-policy banner and lets Save enable normally for readState=fresh", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("auto-policy-unreadable-warning")).toBeNull();

    const saveButtonBeforeEdit = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButtonBeforeEdit.disabled).toBe(true);

    const textarea = screen.getByTestId("auto-policy-input");
    fireEvent.change(textarea, { target: { value: "short and edited" } });

    expect(saveButtonBeforeEdit.disabled).toBe(false);
  });

  // `stale` USED to share the case above, which pinned the defect: a stale read
  // withholds `updatedAt`, so the "saved somewhere else" warning cannot fire,
  // and an enabled Save from there is a last-write-wins overwrite of a policy
  // this window cannot see. The row refuses to OPEN on a stale read; this is
  // the already-open transition, where the open-time refetch comes back stale
  // behind an editor that opened on a fresh one.
  it("refuses to enable Save for readState=stale, and says why", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="stale"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    // Not the unreadable banner - a different cause wants a different sentence.
    expect(screen.queryByTestId("auto-policy-unreadable-warning")).toBeNull();
    expect(
      screen.getByTestId("auto-policy-stale-read-warning").textContent,
    ).toContain("couldn't refresh");

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    // Still disabled AFTER a real edit - `!dirty` is not what is holding it.
    fireEvent.change(screen.getByTestId("auto-policy-input"), {
      target: { value: "short and edited" },
    });
    expect(saveButton.disabled).toBe(true);
  });

  // JOB 1 (Codex ivFem, P1): the TRANSITION the split case above does not
  // cover. That case only ever renders `readState="stale"` from the start;
  // this one opens fresh, lets Save enable through a real edit, and THEN
  // turns stale underneath the still-open dialog - the open-time refetch
  // landing behind an editor that opened on a fresh read. Save must go back
  // to disabled and the notice must appear, without losing the draft: the
  // dialog holds the same `body` state across the re-render, it does not
  // remount.
  //
  // FALSIFICATION: drop `readIsStale` from the Save `disabled` expression in
  // `auto-policy-editor-dialog.tsx` (i.e. `disabled={props.saving || overCap
  // || !dirty || unreadable}`). Driven by hand - both this test AND the
  // already-split `readState="stale"` case above go red:
  //   ✗ shows the stale-read notice and disables Save once an open editor's
  //     read goes stale after an edit, while preserving the draft
  //     AssertionError: expected false to be true // Object.is equality
  //   ✗ refuses to enable Save for readState=stale, and says why
  //     AssertionError: expected false to be true // Object.is equality
  // (`saveButton.disabled` read `false` in both - `dirty` alone was still
  // enabling it.) Restored by retyping the dropped `|| readIsStale` back into
  // the `disabled` expression; the suite is green again.
  it("shows the stale-read notice and disables Save once an open editor's read goes stale after an edit, while preserving the draft", () => {
    const { rerender } = render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("auto-policy-input"), {
      target: { value: "short and edited" },
    });
    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    expect(screen.queryByTestId("auto-policy-stale-read-warning")).toBeNull();

    rerender(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="stale"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(saveButton.disabled).toBe(true);
    expect(screen.getByTestId("auto-policy-stale-read-warning")).toBeTruthy();
    // The draft survives the transition - going stale must not discard what
    // was typed while the read was still fresh.
    const textarea = screen.getByTestId(
      "auto-policy-input",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("short and edited");
  });
});

// JOB 3 (Codex, P1): the row's open-time refetch lands BEHIND the dialog, and
// for that one round trip `currentUpdatedAt` still equals the cached
// `loadedUpdatedAt` the stale-edit warning was seeded from - so the warning
// cannot fire and Save would last-write-win over a newer policy from another
// device. `openingRead` names where that read has got to; Save must stay
// gated for the two states where this window cannot yet answer "has anyone
// else saved since?" (`pending`, `failed`), and the sibling `readState`
// gates it does not touch either half.
// C3: `canWrite={false}` must disable Save AND show the write-unsupported
// warning, even with a dirty edit present and every other health signal
// (readState, openingRead) fine - a host that cannot save must not be
// reachable through a Save button just because the record itself is healthy.
describe("<AutoPolicyEditorDialog /> canWrite=false", () => {
  it("disables Save and shows the write-unsupported warning with a dirty edit and an otherwise-healthy state", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite={false}
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("auto-policy-input"), {
      target: { value: "short and edited" },
    });

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    expect(
      screen.getByTestId("auto-policy-write-unsupported-warning"),
    ).toBeTruthy();
  });
});

describe("<AutoPolicyEditorDialog /> openingRead", () => {
  it("disables Save and shows the inline spinner while the opening read is pending, even with a dirty edit", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="pending"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("auto-policy-input"), {
      target: { value: "short and edited" },
    });

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    // The repo's pending affordance (disabled, label untouched, inline
    // spinner) applies to this wait exactly as it does to `saving` - the
    // dialog reuses the same test id because it is the same claim to the
    // user, "busy, not broken".
    expect(screen.getByTestId("auto-policy-saving-spinner")).toBeTruthy();
    expect(screen.getByText("Save policy")).toBeTruthy();
  });

  it("disables Save and shows the opening-read-failed warning when the opening read failed, even with a dirty edit", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="failed"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("auto-policy-input"), {
      target: { value: "short and edited" },
    });

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    expect(
      screen.getByTestId("auto-policy-opening-read-failed-warning"),
    ).toBeTruthy();
    // No spinner here. "We could not check" and "wait a moment" are
    // different instructions, and a spinner beside the failure would claim a
    // wait that is over - the two states gate Save identically and must not
    // look identical.
    expect(screen.queryByTestId("auto-policy-saving-spinner")).toBeNull();
  });

  // The control for the two cases above: `openingRead="settled"` is what
  // every other case in this file already renders, so this pins that a dirty
  // edit against a settled opening read enables Save normally - the gate
  // does not stick once the read has landed.
  it("enables Save once the opening read has settled, with a dirty edit", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt={null}
        readState="fresh"
        openingRead="settled"
        canWrite
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("auto-policy-input"), {
      target: { value: "short and edited" },
    });

    const saveButton = screen.getByTestId(
      "auto-policy-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    expect(
      screen.queryByTestId("auto-policy-opening-read-failed-warning"),
    ).toBeNull();
    expect(screen.queryByTestId("auto-policy-saving-spinner")).toBeNull();
  });
});
