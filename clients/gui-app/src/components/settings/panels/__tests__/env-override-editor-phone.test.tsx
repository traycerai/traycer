import { type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EnvOverrideEditor,
  type EnvStaleRefusal,
} from "@/components/settings/panels/env-override-editor";
import { PhoneTheme } from "@/components/settings/__tests__/phone-theme";
import {
  installPhoneViewport,
  resizePhoneViewport,
  restorePhoneViewport,
} from "@/components/settings/__tests__/phone-viewport";

const NO_NOTES: ReadonlyMap<string, ReactNode> = new Map();
const SIGN_IN_URL = "https://ghp_x@github.com/o/r";
// Key-shaped for the credential rule (`sk-` and 20+ token characters), and
// plainly not an issued key.
const KEY_VALUE = `sk-${"a".repeat(24)}`;
const NAME_ERROR = "Name must match /^[A-Za-z_][A-Za-z0-9_]*$/.";

type EnvCommit = (
  oldKey: string,
  newKey: string,
  value: string | null,
) => void | Promise<void>;
type EnvDelete = (key: string) => void | Promise<void>;

interface EditorInput {
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  readonly onCommit: EnvCommit;
  readonly onDelete: EnvDelete;
  readonly applyingHostsCount: number | null;
  readonly staleRefusal: EnvStaleRefusal | null;
  readonly rowNotes: ReadonlyMap<string, ReactNode>;
  readonly renderDetails: ((key: string) => ReactNode) | undefined;
}

const NO_REFUSAL = {
  applyingHostsCount: null,
  staleRefusal: null,
  rowNotes: NO_NOTES,
  renderDetails: undefined,
} satisfies Pick<
  EditorInput,
  "applyingHostsCount" | "staleRefusal" | "rowNotes" | "renderDetails"
>;

beforeEach(() => {
  installPhoneViewport(639);
});

afterEach(() => {
  cleanup();
  restorePhoneViewport();
});

function editorElement(input: EditorInput): ReactNode {
  return (
    <PhoneTheme>
      <EnvOverrideEditor
        overrides={input.overrides}
        disabled={false}
        rowNotes={input.rowNotes}
        staleRefusal={input.staleRefusal}
        namePlaceholder="OPENAI_API_KEY"
        emptyLabel="No environment variables."
        applyingHostsCount={input.applyingHostsCount}
        onCommit={input.onCommit}
        onDelete={input.onDelete}
        renderDetails={input.renderDetails}
      />
    </PhoneTheme>
  );
}

function renderEditor(input: EditorInput) {
  return render(editorElement(input));
}

function previewButton(name: string, value: string): HTMLElement {
  // The open sheet hides the page behind it; the preview row is still there.
  return screen.getByRole("button", {
    hidden: true,
    name: (accessibleName) =>
      accessibleName.includes(name) && accessibleName.includes(value),
  });
}

async function openPreview(name: string, value: string): Promise<HTMLElement> {
  await userEvent.click(previewButton(name, value));
  return screen.findByRole("dialog");
}

function chooseOption(control: string, option: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name: control }), {
    key: "ArrowDown",
  });
  const item = screen.getByRole("option", { name: option });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

describe("EnvOverrideEditor on a phone", () => {
  it("rests as name and value previews, including Unset, with no fields", () => {
    renderEditor({
      ...NO_REFUSAL,
      overrides: [
        { key: "NODE_ENV", value: "development" },
        { key: "PATH", value: null },
      ],
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const setRow = previewButton("NODE_ENV", "development");
    expect(setRow.querySelector("svg")).not.toBeNull();
    expect(previewButton("PATH", "Unset")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a variable" })).toBeTruthy();
  });

  it("opens the bottom sheet on the saved name, value and Set", async () => {
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    const dialog = await openPreview("NODE_ENV", "development");

    expect(dialog.getAttribute("data-vaul-drawer-direction")).toBe("bottom");
    expect(
      within(dialog).getByRole("heading", { name: "NODE_ENV" }),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText("Name for NODE_ENV")).toHaveProperty(
      "value",
      "NODE_ENV",
    );
    const value = within(dialog).getByLabelText("Value for NODE_ENV");
    expect(value.tagName).toBe("TEXTAREA");
    expect(value).toHaveProperty("value", "development");
    expect(
      within(dialog).getByRole("combobox", {
        name: "Value for NODE_ENV action",
      }),
    ).toHaveProperty("textContent", "Set");
    expect(
      within(dialog).getByRole("button", { name: "Remove NODE_ENV" }),
    ).toHaveProperty("textContent", "Remove");
    expect(within(dialog).getByRole("button", { name: "Save" })).toHaveProperty(
      "textContent",
      "Save",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveProperty("textContent", "Cancel");
  });

  it("saves the edited value through the row's commit", async () => {
    const onCommit = vi.fn<EnvCommit>();
    const view = renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "production" },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("NODE_ENV", "NODE_ENV", "production");
    view.rerender(
      editorElement({
        ...NO_REFUSAL,
        overrides: [{ key: "NODE_ENV", value: "production" }],
        onCommit,
        onDelete: vi.fn<EnvDelete>(),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewButton("NODE_ENV", "production")).toBeTruthy();
  });

  it("saves Unset as an explicit null", async () => {
    const onCommit = vi.fn<EnvCommit>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    chooseOption("Value for NODE_ENV action", "Unset");
    expect(within(dialog).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "disabled",
      true,
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("NODE_ENV", "NODE_ENV", null);
  });

  it("follows a re-render while closed and skips an untouched save", async () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();
    const view = renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "a" }],
      onCommit,
      onDelete,
    });
    expect(previewButton("NODE_ENV", "a")).toBeTruthy();

    view.rerender(
      editorElement({
        ...NO_REFUSAL,
        overrides: [{ key: "NODE_ENV", value: "b" }],
        onCommit,
        onDelete,
      }),
    );

    expect(previewButton("NODE_ENV", "b")).toBeTruthy();
    const dialog = await openPreview("NODE_ENV", "b");
    expect(within(dialog).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "b",
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears a failed row save when opening another row", async () => {
    const onCommit = vi.fn<EnvCommit>(() =>
      Promise.reject(new Error("Row A could not be saved.")),
    );
    renderEditor({
      ...NO_REFUSAL,
      overrides: [
        { key: "ROW_A", value: "first" },
        { key: "ROW_B", value: "second" },
      ],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });

    const rowA = await openPreview("ROW_A", "first");
    fireEvent.change(within(rowA).getByLabelText("Value for ROW_A"), {
      target: { value: "updated" },
    });
    await userEvent.click(within(rowA).getByRole("button", { name: "Save" }));
    expect(await within(rowA).findByRole("alert")).toHaveProperty(
      "textContent",
      "Row A could not be saved.",
    );

    await userEvent.click(within(rowA).getByRole("button", { name: "Cancel" }));
    const rowB = await openPreview("ROW_B", "second");

    expect(within(rowB).queryByRole("alert")).toBeNull();
  });

  it("clears a failed row save when opening the Add sheet", async () => {
    const onCommit = vi.fn<EnvCommit>(() =>
      Promise.reject(new Error("Row A could not be saved.")),
    );
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "ROW_A", value: "first" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });

    const rowA = await openPreview("ROW_A", "first");
    fireEvent.change(within(rowA).getByLabelText("Value for ROW_A"), {
      target: { value: "updated" },
    });
    await userEvent.click(within(rowA).getByRole("button", { name: "Save" }));
    expect(await within(rowA).findByRole("alert")).toHaveProperty(
      "textContent",
      "Row A could not be saved.",
    );

    await userEvent.click(within(rowA).getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Add a variable" }),
    );
    const addSheet = await screen.findByRole("dialog");

    expect(within(addSheet).queryByRole("alert")).toBeNull();
  });

  it("shows row notes and details under the row and once in its sheet", async () => {
    const note = "Waiting for the host.";
    const detail = "Details for NODE_ENV";
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      rowNotes: new Map([["NODE_ENV", note]]),
      renderDetails: (key) => <span>{`Details for ${key}`}</span>,
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    const row = previewButton("NODE_ENV", "development").closest("li");
    if (row === null) throw new Error("The preview is outside its row.");
    expect(within(row).getByText(note)).toBeTruthy();
    expect(within(row).getByText(detail)).toBeTruthy();

    const dialog = await openPreview("NODE_ENV", "development");

    expect(within(dialog).getAllByText(note)).toHaveLength(1);
    expect(within(dialog).getAllByText(detail)).toHaveLength(1);
    expect(screen.getAllByText(note)).toHaveLength(1);
    expect(screen.getAllByText(detail)).toHaveLength(1);
  });

  it("shows a saved key as dots under the phone row, with no key line", () => {
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "ANTHROPIC_API_KEY", value: KEY_VALUE }],
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    const row = screen.getByTestId("env-masked-row");
    expect(within(row).getByTestId("env-masked-value")).toHaveProperty(
      "textContent",
      "••••••••",
    );
    expect(within(row).queryByTestId("env-key-refusal")).toBeNull();
    expect(document.body.textContent).not.toContain(KEY_VALUE);
  });

  it("does not write on blur or Cancel", async () => {
    const onCommit = vi.fn<EnvCommit>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    const value = within(dialog).getByLabelText("Value for NODE_ENV");
    fireEvent.change(value, { target: { value: "draft-value" } });
    fireEvent.blur(value);
    fireEvent.blur(within(dialog).getByLabelText("Name for NODE_ENV"));

    expect(onCommit).not.toHaveBeenCalled();
    expect(value).toHaveProperty("value", "draft-value");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewButton("NODE_ENV", "development")).toBeTruthy();
    expect(screen.queryByText("draft-value")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not write a phone draft when the row unmounts", async () => {
    const onCommit = vi.fn<EnvCommit>();
    const view = renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "draft-value" },
    });

    view.unmount();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("removes the row from the sheet", async () => {
    const onDelete = vi.fn<EnvDelete>();
    const onCommit = vi.fn<EnvCommit>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete,
    });
    const dialog = await openPreview("NODE_ENV", "development");

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove NODE_ENV" }),
    );

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("NODE_ENV");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("opens an empty add sheet and commits only from Save", async () => {
    const onCommit = vi.fn<EnvCommit>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    expect(screen.getByText("No environment variables.")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Add a variable" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Add a variable" }),
    ).toBeTruthy();
    const name = within(dialog).getByLabelText("New variable name");
    const value = within(dialog).getByLabelText("New variable value");
    expect(name).toHaveProperty("value", "");
    expect(value.tagName).toBe("TEXTAREA");
    expect(value).toHaveProperty("value", "");
    expect(
      within(dialog).queryByRole("button", { name: /^Remove/ }),
    ).toBeNull();
    const apply = within(dialog).getByRole("button", { name: "Save" });
    expect(apply).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(name).toHaveProperty("readOnly", false);
    await userEvent.type(name, "1BAD");
    expect(name).toHaveProperty("value", "1BAD");
    expect(apply).toHaveProperty("disabled", false);
    await userEvent.click(apply);
    expect(onCommit).not.toHaveBeenCalled();
    expect(within(dialog).getByText(NAME_ERROR)).toBeTruthy();
    expect(name).toHaveProperty("value", "1BAD");
    await userEvent.clear(name);
    await userEvent.type(name, "FOO");
    fireEvent.change(value, { target: { value: "one" } });
    fireEvent.blur(value);
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.click(apply);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("", "FOO", "one");
  });

  it.each([640, 767])(
    "keeps inline blur commit after widening to %ipx",
    (width) => {
      const onCommit = vi.fn<EnvCommit>();
      renderEditor({
        ...NO_REFUSAL,
        overrides: [{ key: "NODE_ENV", value: "development" }],
        onCommit,
        onDelete: vi.fn<EnvDelete>(),
      });

      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(previewButton("NODE_ENV", "development")).toBeTruthy();

      act(() => {
        resizePhoneViewport(width);
      });

      const field = screen.getByLabelText("Value for NODE_ENV");
      expect(field.tagName).toBe("INPUT");
      expect(screen.queryByRole("combobox")).not.toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.change(field, { target: { value: "production" } });
      fireEvent.blur(field);

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(
        "NODE_ENV",
        "NODE_ENV",
        "production",
      );
    },
  );

  it("saves a sign-in URL from the sheet", async () => {
    const onCommit = vi.fn<EnvCommit>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "REPO_URL", value: "https://github.com/o/r" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("REPO_URL", "https://github.com/o/r");
    fireEvent.change(within(dialog).getByLabelText("Value for REPO_URL"), {
      target: { value: SIGN_IN_URL },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onCommit).toHaveBeenCalledWith("REPO_URL", "REPO_URL", SIGN_IN_URL);
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("snaps an invalid name back and stores nothing", async () => {
    const onCommit = vi.fn<EnvCommit>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Name for NODE_ENV"), {
      target: { value: "1BAD" },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onCommit).not.toHaveBeenCalled();
    const refused = screen.getByRole("dialog");
    expect(within(refused).getByText(NAME_ERROR)).toBeTruthy();
    expect(within(refused).getByLabelText("Name for NODE_ENV")).toHaveProperty(
      "value",
      "NODE_ENV",
    );
  });

  it("saves a key-shaped draft from the sheet", async () => {
    const onCommit = vi.fn<EnvCommit>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: KEY_VALUE },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onCommit).toHaveBeenCalledWith("NODE_ENV", "NODE_ENV", KEY_VALUE);
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  it("keeps Saving, then a refusal, inside the sheet", async () => {
    const write = Promise.withResolvers<void>();
    const onCommit = vi.fn<EnvCommit>(() => write.promise);
    const view = renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "production" },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    const saving = screen.getByRole("dialog");
    expect(within(saving).getByRole("status")).toHaveProperty(
      "textContent",
      "NODE_ENV · Saving",
    );
    expect(within(saving).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(previewButton("NODE_ENV", "development")).toBeTruthy();
    expect(onCommit).toHaveBeenCalledWith("NODE_ENV", "NODE_ENV", "production");

    view.rerender(
      editorElement({
        ...NO_REFUSAL,
        overrides: [{ key: "NODE_ENV", value: "development" }],
        onCommit: () =>
          Promise.reject(new Error("The host refused this change.")),
        onDelete: vi.fn<EnvDelete>(),
      }),
    );
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    const again = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(again).getByLabelText("Value for NODE_ENV"), {
      target: { value: "production" },
    });
    await userEvent.click(within(again).getByRole("button", { name: "Save" }));

    const refused = screen.getByRole("dialog");
    expect(within(refused).getByRole("alert")).toHaveProperty(
      "textContent",
      "The host refused this change.",
    );
    expect(within(refused).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "value",
      "production",
    );
    expect(within(refused).getByLabelText("Value for NODE_ENV")).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("reads a provider save as Applying on n hosts inside the sheet", async () => {
    const write = Promise.withResolvers<void>();
    const onCommit = vi.fn<EnvCommit>(() => write.promise);
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      applyingHostsCount: 2,
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "production" },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      within(screen.getByRole("dialog")).getByRole("status"),
    ).toHaveProperty("textContent", "NODE_ENV · Applying on 2 hosts…");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(onCommit).toHaveBeenCalledWith("NODE_ENV", "NODE_ENV", "production");
    await act(async () => {
      write.resolve();
      await write.promise;
    });
  });

  it("keeps a saved key masked and remove-only", async () => {
    const onDelete = vi.fn<EnvDelete>();
    renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "ANTHROPIC_API_KEY", value: KEY_VALUE }],
      onCommit: vi.fn<EnvCommit>(),
      onDelete,
    });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove ANTHROPIC_API_KEY" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(document.body.textContent).not.toContain(KEY_VALUE);
    expect(screen.getByTestId("env-masked-value")).toHaveProperty(
      "textContent",
      "••••••••",
    );

    await userEvent.click(screen.getByTestId("env-masked-value"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByTestId("env-key-refusal")).toBeNull();
    expect(document.body.textContent).not.toContain(KEY_VALUE);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove ANTHROPIC_API_KEY" }),
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });

  it("drops a phone draft when the save is stale and writes nothing", async () => {
    const onCommit = vi.fn<EnvCommit>();
    const view = renderEditor({
      ...NO_REFUSAL,
      overrides: [{ key: "NODE_ENV", value: "development" }],
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
    });
    const dialog = await openPreview("NODE_ENV", "development");
    fireEvent.change(within(dialog).getByLabelText("Value for NODE_ENV"), {
      target: { value: "typed" },
    });

    view.rerender(
      editorElement({
        ...NO_REFUSAL,
        overrides: [{ key: "NODE_ENV", value: "server" }],
        staleRefusal: { key: "NODE_ENV", seq: 1 },
        onCommit,
        onDelete: vi.fn<EnvDelete>(),
      }),
    );

    expect(onCommit).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Value for NODE_ENV"),
    ).toHaveProperty("value", "server");
  });
});
