import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvOverrideEditor } from "../env-override-editor";

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

    expect(screen.queryByLabelText("New environment variable name")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Add environment variable" }),
    );

    fireEvent.change(screen.getByLabelText("New environment variable name"), {
      target: { value: "OPENAI_API_KEY" },
    });
    fireEvent.change(screen.getByLabelText("New environment variable value"), {
      target: { value: "token" },
    });

    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Apply environment variable" }),
    );

    expect(onCommit).toHaveBeenCalledWith("", "OPENAI_API_KEY", "token");
    expect(screen.queryByLabelText("New environment variable name")).toBeNull();
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

    fireEvent.click(
      screen.getByRole("button", { name: "Add environment variable" }),
    );
    fireEvent.change(screen.getByLabelText("New environment variable name"), {
      target: { value: "ANTHROPIC_API_KEY" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Discard environment variable" }),
    );

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New environment variable name")).toBeNull();
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

    fireEvent.click(
      screen.getByRole("button", { name: "Add environment variable" }),
    );
    fireEvent.change(screen.getByLabelText("New environment variable name"), {
      target: { value: "COPILOT_HOME" },
    });
    const valueField = screen.getByLabelText("New environment variable value");
    fireEvent.change(valueField, { target: { value: "  /workspace/copilot" } });

    fireEvent.click(screen.getByRole("button", { name: "Trim spaces" }));

    // Staged, not written: the add row commits on Apply alone, so trimming here
    // must edit the draft and nothing else.
    expect(onCommit).not.toHaveBeenCalled();
    expect((valueField as HTMLInputElement).value).toBe("/workspace/copilot");

    fireEvent.click(
      screen.getByRole("button", { name: "Apply environment variable" }),
    );

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
      fireEvent.click(
        screen.getByRole("button", { name: "Add environment variable" }),
      );
      fireEvent.change(screen.getByLabelText("New environment variable name"), {
        target: { value: "REPO_URL" },
      });
      fireEvent.change(
        screen.getByLabelText("New environment variable value"),
        {
          target: { value },
        },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Apply environment variable" }),
      );
    }

    it("refuses a staged value that is a URL with a sign-in: no commit, the line shown, the value kept", () => {
      const onCommit = vi.fn<EnvCommit>();

      addRow(REFUSAL, onCommit, SIGN_IN_URL);

      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.getByText(REFUSED_LINE)).toBeDefined();
      const valueField = screen.getByLabelText(
        "New environment variable value",
      );
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
