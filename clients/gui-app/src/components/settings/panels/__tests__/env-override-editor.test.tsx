import "../../../../../__tests__/test-browser-apis";
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
  readonly onCommit: EnvCommit;
  readonly onDelete: EnvDelete;
}) {
  render(
    <EnvOverrideEditor
      overrides={input.overrides}
      disabled={false}
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

    renderEditor({ overrides: [], onCommit, onDelete });

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

    renderEditor({ overrides: [], onCommit, onDelete });

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
      onCommit,
      onDelete,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove OPENAI_API_KEY" }),
    );

    expect(onDelete).toHaveBeenCalledWith("OPENAI_API_KEY");
  });
});
