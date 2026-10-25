import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvOverrideEditor, type KeyRefusalFor } from "../env-override-editor";

const NO_ROW_NOTES: ReadonlyMap<string, string> = new Map();
const NOT_ON_HOLD: ReadonlyMap<string, ReactNode> = new Map();

type EnvCommit = (oldKey: string, newKey: string, value: string | null) => void;
type EnvDelete = (key: string) => void;

afterEach(() => {
  cleanup();
});

function renderEditor(input: {
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  readonly credentialRefusal: string | null;
  readonly onCommit: EnvCommit;
  readonly onDelete: EnvDelete;
}) {
  render(
    <EnvOverrideEditor
      overrides={input.overrides}
      disabled={false}
      credentialRefusal={input.credentialRefusal}
      rowNotes={NO_ROW_NOTES}
      onHold={NOT_ON_HOLD}
      keyRefusal={null}
      staleRefusal={null}
      namePlaceholder="OPENAI_API_KEY"
      emptyLabel="No environment variables."
      onCommit={input.onCommit}
      onDelete={input.onDelete}
    />,
  );
}

describe("EnvOverrideEditor", () => {
  it("stages a new environment variable until the apply button is pressed", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [],
      credentialRefusal: null,
      onCommit,
      onDelete,
    });

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
    expect(screen.queryByLabelText("New variable name")).toBeNull();
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

    function renderRow(refusal: string | null, onCommit: EnvCommit) {
      return render(
        <EnvOverrideEditor
          overrides={[{ key: "REPO_URL", value: "https://github.com/o/r" }]}
          disabled={false}
          credentialRefusal={refusal}
          rowNotes={NO_ROW_NOTES}
          onHold={NOT_ON_HOLD}
          keyRefusal={null}
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
      renderRow(REFUSAL, onCommit);

      const field = screen.getByLabelText("Value for REPO_URL");
      fireEvent.change(field, { target: { value: SIGN_IN_URL } });
      fireEvent.blur(field);

      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.getByText(REFUSED_LINE)).toBeDefined();
      expect((field as HTMLInputElement).value).toBe(SIGN_IN_URL);
    });

    it("commits a row edited into a plain value on blur", () => {
      const onCommit = vi.fn<EnvCommit>();
      renderRow(REFUSAL, onCommit);

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
      renderRow(null, onCommit);

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
      const view = renderRow(REFUSAL, onCommit);

      fireEvent.change(screen.getByLabelText("Value for REPO_URL"), {
        target: { value: SIGN_IN_URL },
      });
      view.unmount();

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("commits a plain edit when the row unmounts, and a sign-in URL when the host takes credentials", () => {
      const refused = vi.fn<EnvCommit>();
      const plain = renderRow(REFUSAL, refused);
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
      const personal = renderRow(null, allowed);
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
        credentialRefusal={input.refusal}
        rowNotes={NO_ROW_NOTES}
        onHold={NOT_ON_HOLD}
        keyRefusal={null}
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

describe("EnvOverrideEditor rows on hold", () => {
  const HELD_VALUE = "sk-9fA3kLm2Qx7ZpR4tVb8NcW1yHd6Je5Gs";

  it("shows a held row as its name, on hold and a Review control, never its value or an input", () => {
    const onReview = vi.fn();
    render(
      <EnvOverrideEditor
        overrides={[
          { key: "API_TOKEN", value: HELD_VALUE },
          { key: "LOG_LEVEL", value: "debug" },
        ]}
        disabled={false}
        credentialRefusal={null}
        rowNotes={NO_ROW_NOTES}
        onHold={
          new Map<string, ReactNode>([
            [
              "API_TOKEN",
              <button key="r" type="button" onClick={onReview}>
                Review
              </button>,
            ],
          ])
        }
        keyRefusal={null}
        staleRefusal={null}
        namePlaceholder="NODE_ENV"
        emptyLabel="No environment variables."
        onCommit={vi.fn<EnvCommit>()}
        onDelete={vi.fn<EnvDelete>()}
      />,
    );

    const held = screen.getByTestId("env-held-row");
    expect(held.textContent).toBe(
      "API_TOKEN · on hold until you choose · Review",
    );
    expect(document.body.textContent).not.toContain(HELD_VALUE);
    expect(screen.queryByLabelText("Value for API_TOKEN")).toBeNull();
    expect(screen.queryByLabelText("Name for API_TOKEN")).toBeNull();

    // Its neighbour is an ordinary editable row.
    expect(screen.getByLabelText("Value for LOG_LEVEL")).toBeTruthy();
    expect(screen.getAllByTestId("env-held-row")).toHaveLength(1);

    fireEvent.click(within(held).getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});

describe("EnvOverrideEditor refusing a value that looks like a key", () => {
  const API_KEY_VALUE = "sk-9fA3kLm2Qx7ZpR4tVb8NcW1yHd6Je5Gs";
  const REFUSAL = "This looks like a key. Add it as a secret.";

  function renderRefusing(input: {
    readonly overrides: readonly {
      readonly key: string;
      readonly value: string | null;
    }[];
    readonly onKeyShaped: ((name: string, value: string) => void) | null;
    readonly onCommit: EnvCommit;
  }) {
    const { onKeyShaped } = input;
    return renderWithRefusal({
      overrides: input.overrides,
      keyRefusal:
        onKeyShaped === null
          ? null
          : () => ({
              before: "This looks like a key. ",
              link: "Add it as a secret.",
              after: "",
              clearsValue: false,
              onLink: onKeyShaped,
            }),
      onCommit: input.onCommit,
    });
  }

  function renderWithRefusal(input: {
    readonly overrides: readonly {
      readonly key: string;
      readonly value: string | null;
    }[];
    readonly keyRefusal: KeyRefusalFor;
    readonly onCommit: EnvCommit;
  }) {
    return render(
      <EnvOverrideEditor
        overrides={input.overrides}
        disabled={false}
        credentialRefusal={null}
        rowNotes={NO_ROW_NOTES}
        onHold={NOT_ON_HOLD}
        keyRefusal={input.keyRefusal}
        staleRefusal={null}
        namePlaceholder="NODE_ENV"
        emptyLabel="No environment variables."
        onCommit={input.onCommit}
        onDelete={vi.fn<EnvDelete>()}
      />,
    );
  }

  function stageAdd(name: string, value: string): void {
    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: name },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
  }

  it("refuses a staged key-shaped value, stores nothing, and hands the name and value to Add a secret", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onKeyShaped = vi.fn<(name: string, value: string) => void>();
    renderRefusing({ overrides: [], onKeyShaped, onCommit });

    stageAdd("NOTES", API_KEY_VALUE);

    expect(screen.getByTestId("env-key-refusal").textContent).toBe(REFUSAL);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onKeyShaped).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Add it as a secret." }),
    );

    expect(onKeyShaped).toHaveBeenCalledWith("NOTES", API_KEY_VALUE);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New variable name")).toBeNull();
  });

  it("clears the refusal once the staged value is edited, and then commits a plain value", () => {
    const onCommit = vi.fn<EnvCommit>();
    renderRefusing({
      overrides: [],
      onKeyShaped: vi.fn<(name: string, value: string) => void>(),
      onCommit,
    });
    stageAdd("NOTES", API_KEY_VALUE);
    expect(screen.getByTestId("env-key-refusal")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "plain" },
    });
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));

    expect(onCommit).toHaveBeenCalledWith("", "NOTES", "plain");
  });

  it("refuses a row edited into a key on blur, then reverts it to the stored value when handed to Add a secret", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onKeyShaped = vi.fn<(name: string, value: string) => void>();
    renderRefusing({
      overrides: [{ key: "EDITOR", value: "vim" }],
      onKeyShaped,
      onCommit,
    });

    const field = screen.getByLabelText("Value for EDITOR");
    fireEvent.change(field, { target: { value: API_KEY_VALUE } });
    fireEvent.blur(field);

    expect(screen.getByTestId("env-key-refusal").textContent).toBe(REFUSAL);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Add it as a secret." }),
    );

    expect(onKeyShaped).toHaveBeenCalledWith("EDITOR", API_KEY_VALUE);
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
    expect(screen.getByLabelText("Value for EDITOR")).toBe(
      screen.getByDisplayValue("vim"),
    );
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("stores nothing when a row holding a key-shaped draft unmounts", () => {
    const onCommit = vi.fn<EnvCommit>();
    const view = renderRefusing({
      overrides: [{ key: "EDITOR", value: "vim" }],
      onKeyShaped: vi.fn<(name: string, value: string) => void>(),
      onCommit,
    });

    fireEvent.change(screen.getByLabelText("Value for EDITOR"), {
      target: { value: API_KEY_VALUE },
    });
    view.unmount();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("stores the same value as before where no handler is set", () => {
    const onCommit = vi.fn<EnvCommit>();
    renderRefusing({ overrides: [], onKeyShaped: null, onCommit });

    stageAdd("NOTES", API_KEY_VALUE);

    expect(onCommit).toHaveBeenCalledWith("", "NOTES", API_KEY_VALUE);
    expect(screen.queryByTestId("env-key-refusal")).toBeNull();
  });

  describe("a refusal that clears the value instead of carrying it", () => {
    const OWN_KEY = "ANTHROPIC_API_KEY";
    const ownKey =
      (onLink: (name: string, value: string) => void): KeyRefusalFor =>
      (name) =>
        name === OWN_KEY
          ? {
              before: "This is Claude's key. Set it on ",
              link: "Claude's Account tab",
              after: ".",
              clearsValue: true,
              onLink,
            }
          : {
              before: "This looks like a key. ",
              link: "Add it as a secret.",
              after: "",
              clearsValue: false,
              onLink,
            };

    it("clears a staged value on refusal, names the line by the name typed, and stores nothing", () => {
      const onCommit = vi.fn<EnvCommit>();
      const onLink = vi.fn<(name: string, value: string) => void>();
      renderWithRefusal({
        overrides: [],
        keyRefusal: ownKey(onLink),
        onCommit,
      });

      stageAdd(OWN_KEY, API_KEY_VALUE);

      expect(screen.getByTestId("env-key-refusal").textContent).toBe(
        "This is Claude's key. Set it on Claude's Account tab.",
      );
      expect(screen.getByLabelText("New variable value")).toBe(
        screen.getByDisplayValue(""),
      );
      expect(document.body.textContent).not.toContain(API_KEY_VALUE);
      expect(onCommit).not.toHaveBeenCalled();
      // Applying again does not store the cleared field.
      fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("hands the link the name and the value that was typed, then closes the add row", () => {
      const onLink = vi.fn<(name: string, value: string) => void>();
      renderWithRefusal({
        overrides: [],
        keyRefusal: ownKey(onLink),
        onCommit: vi.fn<EnvCommit>(),
      });
      stageAdd(OWN_KEY, API_KEY_VALUE);

      fireEvent.click(
        screen.getByRole("button", { name: "Claude's Account tab" }),
      );

      expect(onLink).toHaveBeenCalledTimes(1);
      expect(screen.queryByLabelText("New variable name")).toBeNull();
    });

    it("clears an edited row on blur, stores nothing on unmount, and a plain edit lifts the refusal", () => {
      const onCommit = vi.fn<EnvCommit>();
      const view = renderWithRefusal({
        overrides: [{ key: OWN_KEY, value: "" }],
        keyRefusal: ownKey(vi.fn<(name: string, value: string) => void>()),
        onCommit,
      });

      const field = screen.getByLabelText(`Value for ${OWN_KEY}`);
      fireEvent.change(field, { target: { value: API_KEY_VALUE } });
      fireEvent.blur(field);

      expect(screen.getByTestId("env-key-refusal")).toBeTruthy();
      expect(screen.queryByDisplayValue(API_KEY_VALUE)).toBeNull();
      view.unmount();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("keeps the typed value in the field for a name that is not the provider's own key", () => {
      const onLink = vi.fn<(name: string, value: string) => void>();
      renderWithRefusal({
        overrides: [],
        keyRefusal: ownKey(onLink),
        onCommit: vi.fn<EnvCommit>(),
      });

      stageAdd("NOTES", API_KEY_VALUE);

      expect(screen.getByTestId("env-key-refusal").textContent).toBe(
        "This looks like a key. Add it as a secret.",
      );
      expect(screen.getByDisplayValue(API_KEY_VALUE)).toBeTruthy();
    });
  });
});

describe("EnvOverrideEditor saved values that look like a key", () => {
  const SAVED_VALUE = "sk-9fA3kLm2Qx7ZpR4tVb8NcW1yHd6Je5Gs";
  const NAME = "ANTHROPIC_API_KEY";
  const onLinkMock = vi.fn<(name: string, value: string) => void>();
  const refusal: KeyRefusalFor = () => ({
    before: "This looks like a key. ",
    link: "Add it as a secret.",
    after: "",
    clearsValue: false,
    onLink: onLinkMock,
  });

  function renderSaved(input: {
    readonly keyRefusal: KeyRefusalFor;
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
        credentialRefusal={null}
        rowNotes={new Map([[NAME, "Only on this computer."]])}
        onHold={NOT_ON_HOLD}
        keyRefusal={input.keyRefusal}
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
      keyRefusal: refusal,
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

  it("shows the refusal line under the row, and its link hands over the saved name and value, changing nothing", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();
    onLinkMock.mockReset();
    renderSaved({ keyRefusal: refusal, onCommit, onDelete });

    const line = within(screen.getByTestId("env-masked-row")).getByTestId(
      "env-key-refusal",
    );
    expect(line.textContent).toBe("This looks like a key. Add it as a secret.");
    fireEvent.click(
      within(line).getByRole("button", { name: "Add it as a secret." }),
    );

    expect(onLinkMock).toHaveBeenCalledTimes(1);
    expect(onLinkMock).toHaveBeenCalledWith(NAME, SAVED_VALUE);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("masks it with no refusal line where nothing refuses a key", () => {
    renderSaved({
      keyRefusal: null,
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
      keyRefusal: refusal,
      onCommit: vi.fn<EnvCommit>(),
      onDelete,
    });

    fireEvent.click(screen.getByRole("button", { name: `Remove ${NAME}` }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(NAME);
  });

  it("keeps an ordinary saved value as an editable field beside it", () => {
    renderSaved({
      keyRefusal: refusal,
      onCommit: vi.fn<EnvCommit>(),
      onDelete: vi.fn<EnvDelete>(),
    });

    const field = screen.getByLabelText<HTMLInputElement>("Value for NODE_ENV");
    expect(field.value).toBe("production");
    expect(screen.getAllByTestId("env-masked-row")).toHaveLength(1);
  });
});
