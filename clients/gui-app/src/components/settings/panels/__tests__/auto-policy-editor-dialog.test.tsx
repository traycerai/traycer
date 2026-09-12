import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("is false when the loaded stamp is null", () => {
    expect(autoPolicyChangedSinceLoad(null, "2026-09-10T00:00:00.000Z")).toBe(
      false,
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
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("auto-policy-stale-warning")).toBeTruthy();
  });

  it("hides the stale warning when either timestamp is null", () => {
    render(
      <AutoPolicyEditorDialog
        initialBody="short"
        loadedUpdatedAt={null}
        currentUpdatedAt="2026-09-10T00:05:00.000Z"
        readState="fresh"
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("auto-policy-stale-warning")).toBeNull();
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
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId("auto-policy-unreadable-warning")).toBeTruthy();
  });
});

describe("<AutoPolicyEditorDialog /> readable read states", () => {
  it.each(["fresh", "stale"] as const)(
    "hides the unreadable-policy banner and lets Save enable normally for readState=%s",
    (readState) => {
      render(
        <AutoPolicyEditorDialog
          initialBody="short"
          loadedUpdatedAt={null}
          currentUpdatedAt={null}
          readState={readState}
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
    },
  );
});
