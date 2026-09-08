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
  readonly reservedKeys: readonly string[];
  readonly onCommit: EnvCommit;
  readonly onDelete: EnvDelete;
}) {
  render(
    <EnvOverrideEditor
      overrides={input.overrides}
      disabled={false}
      namePlaceholder="OPENAI_API_KEY"
      emptyLabel="No environment variables."
      reservedKeys={input.reservedKeys}
      onCommit={input.onCommit}
      onDelete={input.onDelete}
    />,
  );
}

describe("EnvOverrideEditor", () => {
  it("stages a new environment variable until the apply button is pressed", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({ overrides: [], reservedKeys: [], onCommit, onDelete });

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

    renderEditor({ overrides: [], reservedKeys: [], onCommit, onDelete });

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
      reservedKeys: [],
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
      reservedKeys: [],
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
      reservedKeys: [],
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

    renderEditor({ overrides: [], reservedKeys: [], onCommit, onDelete });

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

  it("masks values whose key looks like a secret and leaves ordinary keys plain", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [
        { key: "ANTHROPIC_API_KEY", value: "sk-1" },
        { key: "GH_TOKEN", value: "gh-1" },
        { key: "MY_SECRET", value: "s-1" },
        { key: "DB_PASSWORD", value: "p-1" },
        { key: "PATH", value: "/usr/bin" },
        { key: "NODE_ENV", value: "production" },
      ],
      reservedKeys: [],
      onCommit,
      onDelete,
    });

    for (const key of [
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "MY_SECRET",
      "DB_PASSWORD",
    ]) {
      const field = screen.getByLabelText(
        `Value for ${key}`,
      ) as HTMLInputElement;
      expect(field.type).toBe("password");
    }
    for (const key of ["PATH", "NODE_ENV"]) {
      const field = screen.getByLabelText(
        `Value for ${key}`,
      ) as HTMLInputElement;
      expect(field.type).toBe("text");
    }
  });

  it("reveals a masked value on demand and hides it again on toggle", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [{ key: "ANTHROPIC_API_KEY", value: "sk-secret" }],
      reservedKeys: [],
      onCommit,
      onDelete,
    });

    const field = screen.getByLabelText(
      "Value for ANTHROPIC_API_KEY",
    ) as HTMLInputElement;
    expect(field.type).toBe("password");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reveal Value for ANTHROPIC_API_KEY",
      }),
    );
    expect(field.type).toBe("text");

    fireEvent.click(
      screen.getByRole("button", { name: "Hide Value for ANTHROPIC_API_KEY" }),
    );
    expect(field.type).toBe("password");
  });

  it("disables Add for a reserved key and names it", () => {
    const onCommit = vi.fn<EnvCommit>();
    const onDelete = vi.fn<EnvDelete>();

    renderEditor({
      overrides: [],
      reservedKeys: ["CLAUDE_CONFIG_DIR"],
      onCommit,
      onDelete,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Add environment variable" }),
    );
    fireEvent.change(screen.getByLabelText("New environment variable name"), {
      target: { value: "CLAUDE_CONFIG_DIR" },
    });

    const applyButton = screen.getByRole("button", {
      name: "Apply environment variable",
    }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    expect(
      screen.queryByText(/"CLAUDE_CONFIG_DIR" is reserved/),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Apply environment variable" }),
    );
    expect(onCommit).not.toHaveBeenCalled();
  });
});
