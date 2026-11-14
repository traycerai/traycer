import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvOverrideEditor } from "../env-override-editor";

const NO_ROW_NOTES: ReadonlyMap<string, string> = new Map();
const NOT_CLAIMED: ReadonlyMap<string, string> = new Map();

type EnvCommit = (
  oldKey: string,
  newKey: string,
  value: string | null,
) => void | Promise<void>;
type EnvDelete = (key: string) => void | Promise<void>;

afterEach(() => {
  cleanup();
});

interface EditorInput {
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  readonly credentialRefusal: string | null;
  readonly onCommit: EnvCommit;
  readonly onDelete: EnvDelete;
  readonly applyingHostsCount?: number | null;
}

function editorElement(input: EditorInput) {
  return (
    <EnvOverrideEditor
      overrides={input.overrides}
      disabled={false}
      rowNotes={NO_ROW_NOTES}
      claimedBy={NOT_CLAIMED}
      staleRefusal={null}
      namePlaceholder="OPENAI_API_KEY"
      emptyLabel="No environment variables."
      onCommit={input.onCommit}
      onDelete={input.onDelete}
      applyingHostsCount={input.applyingHostsCount}
    />
  );
}

function renderEditor(input: EditorInput) {
  return render(editorElement(input));
}

describe("EnvOverrideEditor", () => {
  it("stages a new environment variable until the apply button is pressed, then keeps it as a disabled pending draft until the overrides list it", async () => {
    let finishRead: () => void = () => {
      throw new Error("read has not started");
    };
    const completedWrite = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const onCommit = vi.fn<EnvCommit>(() => completedWrite);
    const onDelete = vi.fn<EnvDelete>();
    const input: EditorInput = {
      overrides: [],
      credentialRefusal: null,
      onCommit,
      onDelete,
    };

    const view = renderEditor(input);

    expect(screen.queryByLabelText("New variable name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));

    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "OPENAI_API_KEY" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "token" },
    });

    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    expect(onCommit).toHaveBeenCalledWith("", "OPENAI_API_KEY", "token");
    // The write was sent but no override lists it yet: the draft stays as
    // typed, disabled, with nothing offered to send it again.
    const name = screen.getByLabelText("New variable name");
    const value = screen.getByLabelText("New variable value");
    expect(name).toHaveProperty("value", "OPENAI_API_KEY");
    expect(name).toHaveProperty("disabled", true);
    expect(value).toHaveProperty("value", "token");
    expect(value).toHaveProperty("disabled", true);
    expect(onCommit).toHaveBeenCalledTimes(1);

    // The caller completes after the authoritative read: the draft closes
    // and the credential-shaped name is a masked saved row.
    await act(async () => {
      view.rerender(
        editorElement({
          ...input,
          overrides: [{ key: "OPENAI_API_KEY", value: "token" }],
        }),
      );
      finishRead();
      await completedWrite;
    });
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(screen.getByTestId("env-masked-row").textContent).toContain(
      "OPENAI_API_KEY",
    );
    expect(screen.queryByDisplayValue("token")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove OPENAI_API_KEY" }),
    ).toBeTruthy();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("reads a pending SET save as <key> · Applying on <n> hosts…", async () => {
    let finishRead: () => void = () => {
      throw new Error("read has not started");
    };
    const completedWrite = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const onCommit = vi.fn<EnvCommit>(() => completedWrite);
    const onDelete = vi.fn<EnvDelete>();
    const input: EditorInput = {
      overrides: [],
      credentialRefusal: null,
      onCommit,
      onDelete,
      applyingHostsCount: 3,
    };

    const view = renderEditor(input);
    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "ANTHROPIC_BASE_URL" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "https://example.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    expect(screen.getByRole("status").textContent).toBe(
      "ANTHROPIC_BASE_URL · Applying on 3 hosts…",
    );

    await act(async () => {
      view.rerender(
        editorElement({
          ...input,
          overrides: [
            { key: "ANTHROPIC_BASE_URL", value: "https://example.invalid" },
          ],
        }),
      );
      finishRead();
      await completedWrite;
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reads a single applying host without the plural", () => {
    const onCommit = vi.fn<EnvCommit>(() => new Promise<void>(() => {}));
    renderEditor({
      overrides: [],
      credentialRefusal: null,
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
      applyingHostsCount: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "ANTHROPIC_BASE_URL" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    expect(screen.getByRole("status").textContent).toBe(
      "ANTHROPIC_BASE_URL · Applying on 1 host…",
    );
  });

  it("control: with no host count, a pending SET save keeps the plain Adding text", () => {
    const onCommit = vi.fn<EnvCommit>(() => new Promise<void>(() => {}));
    renderEditor({
      overrides: [],
      credentialRefusal: null,
      onCommit,
      onDelete: vi.fn<EnvDelete>(),
      applyingHostsCount: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "ANTHROPIC_BASE_URL" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    expect(screen.getByRole("status").textContent).toBe(
      "ANTHROPIC_BASE_URL · Adding",
    );
  });

  it("discards a staged environment variable without applying it", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [],
      credentialRefusal: null,
      onCommit,
      onDelete,
    });

    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "ANTHROPIC_API_KEY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard variable" }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New variable name")).toBeNull();
  });

  it("keeps existing rows removable with the bin icon", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [{ key: "OPENAI_API_KEY", value: "token" }],
      credentialRefusal: null,
      onCommit,
      onDelete,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove OPENAI_API_KEY" }),
    );

    expect(onDelete).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it("flags edge whitespace in a value rather than silently trimming it", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [{ key: "KIMI_CODE_HOME", value: " /workspace/kimi " }],
      credentialRefusal: null,
      onCommit,
      onDelete,
    });

    // Rendering alone must not rewrite the value. The spawned CLI receives it
    // byte for byte and the providers disagree about what a padded value MEANS
    // - most treat it as a relative path, a few strip it and call it unset - so
    // the editor states the consequence and leaves the choice with the user.
    expect(
      screen.queryByText(/Leading or trailing spaces are part of this value/),
    ).not.toBeNull();
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Trim spaces" }));

    expect(onCommit).toHaveBeenCalledWith(
      "KIMI_CODE_HOME",
      "KIMI_CODE_HOME",
      "/workspace/kimi",
    );
  });

  it("says nothing about a value with no edge whitespace", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [{ key: "KIMI_CODE_HOME", value: "/workspace/kimi" }],
      credentialRefusal: null,
      onCommit,
      onDelete,
    });

    // Interior spaces are ordinary in a path and are NOT what diverges - only
    // the edges are, so a notice here would be noise on a correct value.
    expect(screen.queryByRole("button", { name: "Trim spaces" })).toBeNull();
  });

  it("flags edge whitespace on the staged add row without committing it", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [],
      credentialRefusal: null,
      onCommit,
      onDelete,
    });

    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "COPILOT_HOME" },
    });
    const valueField = screen.getByLabelText("New variable value");
    fireEvent.change(valueField, { target: { value: "  /workspace/copilot" } });

    fireEvent.click(screen.getByRole("button", { name: "Trim spaces" }));

    // Staged, not written: the add row commits on Apply alone, so trimming here
    // must edit the draft and nothing else.
    expect(onCommit).not.toHaveBeenCalled();
    expect((valueField as HTMLInputElement).value).toBe("/workspace/copilot");

    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    expect(onCommit).toHaveBeenCalledWith(
      "",
      "COPILOT_HOME",
      "/workspace/copilot",
    );
  });

  describe("on a host that takes no credentials", () => {
    const REFUSAL = "Sandboxes don't take sign-ins";
    const REFUSED_LINE = `${REFUSAL}: remove the sign-in from this URL.`;
    const SIGN_IN_URL = "https://ghp_x@github.com/o/r";

    function addRow(
      refusal: string | null,
      onCommit: EnvCommit,
      value: string,
    ): void {
      renderEditor({
        overrides: [],
        credentialRefusal: refusal,
        onCommit,
        onDelete: vi.fn<EnvDelete>(),
      });
      fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
      fireEvent.change(screen.getByLabelText("New variable name"), {
        target: { value: "REPO_URL" },
      });
      fireEvent.change(screen.getByLabelText("New variable value"), {
        target: { value },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
    }

    it("refuses a staged value that is a URL with a sign-in: no commit, the line shown, the value kept", () => {
      const onCommit = vi.fn<EnvCommit>();

      addRow(REFUSAL, onCommit, SIGN_IN_URL);

      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.getByText(REFUSED_LINE)).toBeDefined();
      const valueField = screen.getByLabelText("New variable value");
      expect((valueField as HTMLInputElement).value).toBe(SIGN_IN_URL);
    });

    it("applies a staged value that is a plain URL or text", () => {
      for (const value of ["https://github.com/o/r", "production"]) {
        const onCommit = vi.fn<EnvCommit>();
        addRow(REFUSAL, onCommit, value);
        expect(onCommit).toHaveBeenCalledWith("", "REPO_URL", value);
        cleanup();
      }
    });

    it("applies a staged sign-in URL when the host takes credentials (null refusal)", () => {
      const onCommit = vi.fn<EnvCommit>();

      addRow(null, onCommit, SIGN_IN_URL);

      expect(onCommit).toHaveBeenCalledWith("", "REPO_URL", SIGN_IN_URL);
      expect(screen.queryByText(REFUSED_LINE)).toBeNull();
    });

    function renderRow(onCommit: EnvCommit) {
      return render(
        <EnvOverrideEditor
          overrides={[{ key: "REPO_URL", value: "https://github.com/o/r" }]}
          disabled={false}
          rowNotes={NO_ROW_NOTES}
          claimedBy={NOT_CLAIMED}
          staleRefusal={null}
          namePlaceholder="NODE_ENV"
          emptyLabel="No environment variables."
          onCommit={onCommit}
          onDelete={vi.fn<EnvDelete>()}
        />,
      );
    }

    it("refuses a row edited into a sign-in URL on blur, shows the line and keeps the value", () => {
      const onCommit = vi.fn<EnvCommit>();
      renderRow(onCommit);

      const field = screen.getByLabelText("Value for REPO_URL");
      fireEvent.change(field, { target: { value: SIGN_IN_URL } });
      fireEvent.blur(field);

      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.getByText(REFUSED_LINE)).toBeDefined();
      expect((field as HTMLInputElement).value).toBe(SIGN_IN_URL);
    });

    it("commits a row edited into a plain value on blur", () => {
      const onCommit = vi.fn<EnvCommit>();
      renderRow(onCommit);

      const field = screen.getByLabelText("Value for REPO_URL");
      fireEvent.change(field, { target: { value: "https://github.com/o/s" } });
      fireEvent.blur(field);

      expect(onCommit).toHaveBeenCalledWith(
        "REPO_URL",
        "REPO_URL",
        "https://github.com/o/s",
      );
    });

    it("commits a row edited into a sign-in URL on blur when the host takes credentials", () => {
      const onCommit = vi.fn<EnvCommit>();
      renderRow(onCommit);

      const field = screen.getByLabelText("Value for REPO_URL");
      fireEvent.change(field, { target: { value: SIGN_IN_URL } });
      fireEvent.blur(field);

      expect(onCommit).toHaveBeenCalledWith(
        "REPO_URL",
        "REPO_URL",
        SIGN_IN_URL,
      );
    });

    it("does not commit a sign-in URL when the row unmounts with it still in the field", () => {
      const onCommit = vi.fn<EnvCommit>();
      const view = renderRow(onCommit);

      fireEvent.change(screen.getByLabelText("Value for REPO_URL"), {
        target: { value: SIGN_IN_URL },
      });
      view.unmount();

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("commits a plain edit when the row unmounts, and a sign-in URL when the host takes credentials", () => {
      const refused = vi.fn<EnvCommit>();
      const plain = renderRow(refused);
      fireEvent.change(screen.getByLabelText("Value for REPO_URL"), {
        target: { value: "https://github.com/o/s" },
      });
      plain.unmount();
      expect(refused).toHaveBeenCalledWith(
        "REPO_URL",
        "REPO_URL",
        "https://github.com/o/s",
      );

      const allowed = vi.fn<EnvCommit>();
      const personal = renderRow(allowed);
      fireEvent.change(screen.getByLabelText("Value for REPO_URL"), {
        target: { value: SIGN_IN_URL },
      });
      personal.unmount();
      expect(allowed).toHaveBeenCalledWith("REPO_URL", "REPO_URL", SIGN_IN_URL);
    });
  });
});

describe("EnvOverrideEditor credential-shaped names", () => {
  const REFUSAL = "Sandboxes don't take sign-ins";
  const NAME_LINE = `${REFUSAL}: a variable whose name looks like a credential is not stored here.`;

  function renderWith(input: {
    readonly refusal: string | null;
    readonly overrides: readonly {
      readonly key: string;
      readonly value: string | null;
    }[];
    readonly onCommit: EnvCommit;
  }) {
    return render(
      <EnvOverrideEditor
        overrides={input.overrides}
        disabled={false}
        rowNotes={NO_ROW_NOTES}
        claimedBy={NOT_CLAIMED}
        staleRefusal={null}
        namePlaceholder="NODE_ENV"
        emptyLabel="No environment variables."
        onCommit={input.onCommit}
        onDelete={vi.fn<EnvDelete>()}
      />,
    );
  }

  function addRow(name: string, value: string): void {
    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: name },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
  }

  it("refuses an added variable whose name looks like a credential: no commit, the line shown, the typed name kept", () => {
    const onCommit = vi.fn<EnvCommit>();
    renderWith({ refusal: REFUSAL, overrides: [], onCommit });

    addRow("OPENAI_API_KEY", "sk-x");

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(NAME_LINE)).toBeDefined();
    const nameField = screen.getByLabelText("New variable name");
    expect((nameField as HTMLInputElement).value).toBe("OPENAI_API_KEY");
  });

  it("refuses a credential-shaped name whatever the value, an empty one included", () => {
    const onCommit = vi.fn<EnvCommit>();
    renderWith({ refusal: REFUSAL, overrides: [], onCommit });

    addRow("GITHUB_TOKEN", "");

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(NAME_LINE)).toBeDefined();
  });

  it("refuses renaming an existing row to a credential-shaped name on blur, with the same line", () => {
    const onCommit = vi.fn<EnvCommit>();
    renderWith({
      refusal: REFUSAL,
      overrides: [{ key: "EDITOR", value: "vim" }],
      onCommit,
    });

    const name = screen.getByLabelText("Name for EDITOR");
    fireEvent.change(name, { target: { value: "GITHUB_TOKEN" } });
    fireEvent.blur(name);

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(NAME_LINE)).toBeDefined();
  });

  it("sends nothing when a row unmounts with a credential-shaped name still in its field", () => {
    const onCommit = vi.fn<EnvCommit>();
    const view = renderWith({
      refusal: REFUSAL,
      overrides: [{ key: "EDITOR", value: "vim" }],
      onCommit,
    });

    fireEvent.change(screen.getByLabelText("Name for EDITOR"), {
      target: { value: "GITHUB_TOKEN" },
    });
    view.unmount();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still commits an ordinary name and value on a host that takes no credentials", () => {
    const onCommit = vi.fn<EnvCommit>();
    renderWith({ refusal: REFUSAL, overrides: [], onCommit });

    addRow("EDITOR", "vim");

    expect(onCommit).toHaveBeenCalledWith("", "EDITOR", "vim");
    expect(screen.queryByText(NAME_LINE)).toBeNull();
  });

  it("control: with no refusal the same credential-shaped names commit, added and renamed", () => {
    const added = vi.fn<EnvCommit>();
    const first = renderWith({ refusal: null, overrides: [], onCommit: added });
    addRow("OPENAI_API_KEY", "sk-x");
    expect(added).toHaveBeenCalledWith("", "OPENAI_API_KEY", "sk-x");
    first.unmount();

    const renamed = vi.fn<EnvCommit>();
    renderWith({
      refusal: null,
      overrides: [{ key: "EDITOR", value: "vim" }],
      onCommit: renamed,
    });
    const name = screen.getByLabelText("Name for EDITOR");
    fireEvent.change(name, { target: { value: "GITHUB_TOKEN" } });
    fireEvent.blur(name);
    expect(renamed).toHaveBeenCalledWith("EDITOR", "GITHUB_TOKEN", "vim");
  });
});

describe("EnvOverrideEditor saved values that look like a key", () => {
  const SAVED_VALUE = "sk-9fA3kLm2Qx7ZpR4tVb8NcW1yHd6Je5Gs";
  const NAME = "ANTHROPIC_API_KEY";

  function renderSaved(input: {
    readonly onCommit: EnvCommit;
    readonly onDelete: EnvDelete;
  }) {
    render(
      <EnvOverrideEditor
        overrides={[
          { key: NAME, value: SAVED_VALUE },
          { key: "NODE_ENV", value: "production" },
        ]}
        disabled={false}
        rowNotes={new Map([[NAME, "Only on this computer."]])}
        claimedBy={NOT_CLAIMED}
        staleRefusal={null}
        namePlaceholder="NODE_ENV"
        emptyLabel="No environment variables."
        renderDetails={(key) =>
          key === NAME ? <span data-testid="row-details">Details</span> : null
        }
        onCommit={input.onCommit}
        onDelete={input.onDelete}
      />,
    );
  }

  it("masks the row: name as text, dots, no input carrying the value, and the note and details kept", () => {
    renderSaved({
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    const row = screen.getByTestId("env-masked-row");
    expect(row.textContent).toContain(NAME);
    expect(within(row).getByTestId("env-masked-value").textContent).toBe(
      "••••••••",
    );
    expect(within(row).getByLabelText(`${NAME} is hidden`)).toBeTruthy();
    expect(within(row).queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByLabelText(`Value for ${NAME}`)).toBeNull();
    expect(screen.queryByLabelText(`Name for ${NAME}`)).toBeNull();
    expect(screen.queryByDisplayValue(SAVED_VALUE)).toBeNull();
    expect(document.body.textContent).not.toContain(SAVED_VALUE);
    expect(within(row).getByTestId("env-row-note").textContent).toBe(
      "Only on this computer.",
    );
    expect(within(row).getByTestId("row-details")).toBeTruthy();
  });

  it("masks it with no refusal line where nothing refuses a key", () => {
    renderSaved({
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    expect(screen.getByTestId("env-masked-row")).toBeTruthy();
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
    expect(screen.queryByDisplayValue(SAVED_VALUE)).toBeNull();
  });

  it("removes the masked row by its key", () => {
    const onDelete = vi.fn<EnvDelete>();
    renderSaved({
      onCommit: vi.fn<EnvCommit>(),
      onDelete,
    });

    fireEvent.click(screen.getByRole("button", { name: `Remove ${NAME}` }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(NAME);
  });

  it("keeps an ordinary saved value as an editable field beside it", () => {
    renderSaved({
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    const field = screen.getByLabelText<HTMLInputElement>("Value for NODE_ENV");
    expect(field.value).toBe("production");
    expect(screen.getAllByTestId("env-masked-row")).toHaveLength(1);
  });
});

describe("EnvOverrideEditor rows a secret sets", () => {
  it("shows the name as the secret's, with no value and nothing to edit", () => {
    render(
      <EnvOverrideEditor
        overrides={[{ key: "STRIPE_TOKEN", value: "sk_live_9f3a7c1d2e4b5a60" }]}
        disabled={false}
        rowNotes={NO_ROW_NOTES}
        claimedBy={new Map([["STRIPE_TOKEN", "STRIPE_KEY"]])}
        staleRefusal={null}
        namePlaceholder="OPENAI_API_KEY"
        emptyLabel="No environment variables."
        onCommit={vi.fn<EnvCommit>()}
        onDelete={vi.fn<EnvDelete>()}
      />,
    );

    expect(screen.getByTestId("env-claimed-row").textContent).toBe(
      "STRIPE_TOKEN · from the secret STRIPE_KEY · Secrets",
    );
    expect(screen.queryByLabelText("Value for STRIPE_TOKEN")).toBeNull();
    expect(screen.queryByTestId("env-masked-row")).toBeNull();
    expect(document.body.textContent).not.toContain("sk_live_9f3a7c1d2e4b5a60");
  });
});
