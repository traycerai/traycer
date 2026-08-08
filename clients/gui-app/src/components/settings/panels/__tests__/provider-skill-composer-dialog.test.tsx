import type { ProvidersSkillsMutateAction } from "@traycer/protocol/host/provider-native-schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSkillComposerDialog } from "@/components/settings/panels/provider-skill-composer-dialog";
import type { SkillAuthoring } from "@/components/settings/panels/provider-skill-composer-model";

const BOTH: SkillAuthoring = {
  canWrite: true,
  canImport: true,
  canAuthor: true,
};
const WRITE_ONLY: SkillAuthoring = {
  canWrite: true,
  canImport: false,
  canAuthor: true,
};
const IMPORT_ONLY: SkillAuthoring = {
  canWrite: false,
  canImport: true,
  canAuthor: true,
};

function renderDialog(
  overrides: Partial<{
    authoring: SkillAuthoring;
    initialTab: "write" | "import";
    providerRoot: string | null;
    pending: boolean;
    error: string | null;
  }>,
) {
  const onSubmit = vi.fn<(mutation: ProvidersSkillsMutateAction) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <ProviderSkillComposerDialog
      providerLabel="Codex"
      authoring={overrides.authoring ?? BOTH}
      initialTab={overrides.initialTab ?? "write"}
      providerRoot={
        overrides.providerRoot === undefined ? null : overrides.providerRoot
      }
      pending={overrides.pending ?? false}
      error={overrides.error ?? null}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
  return { onSubmit, onClose };
}

describe("<ProviderSkillComposerDialog />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a tab strip when both paths are open", () => {
    renderDialog({ authoring: BOTH });
    expect(screen.getByRole("tablist")).toBeDefined();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("renders bare fields with no tablist when only write is open", () => {
    renderDialog({ authoring: WRITE_ONLY, initialTab: "write" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByLabelText("Name")).toBeDefined();
  });

  it("renders bare fields with no tablist when only import is open", () => {
    renderDialog({ authoring: IMPORT_ONLY, initialTab: "import" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByLabelText("Git URL or folder path")).toBeDefined();
  });

  it("pre-fills the body with the scaffold instead of an empty textarea", () => {
    renderDialog({ authoring: WRITE_ONLY, initialTab: "write" });
    const body = screen.getByRole("textbox", { name: "Instructions" });
    if (!(body instanceof HTMLTextAreaElement)) {
      throw new Error("expected a textarea");
    }
    expect(body.value).toContain("## When to use this");
  });

  it("disables submit and states a reason until name and description are filled", () => {
    renderDialog({ authoring: WRITE_ONLY, initialTab: "write" });
    const submit = screen.getByRole("button", { name: "Create skill" });
    expect(submit instanceof HTMLButtonElement && submit.disabled).toBe(true);
    expect(screen.getByText("Give the skill a name.")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "review-pr" },
    });
    expect(
      screen.getByText(
        "Add a description — the agent reads it to decide when to use this skill.",
      ),
    ).toBeDefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Reviews a pull request for bugs." },
    });

    const readySubmit = screen.getByRole("button", { name: "Create skill" });
    expect(
      readySubmit instanceof HTMLButtonElement && readySubmit.disabled,
    ).toBe(false);
    expect(screen.queryByText("Give the skill a name.")).toBeNull();
  });

  it("toggles Preview SKILL.md to the exact frontmatter", () => {
    renderDialog({ authoring: WRITE_ONLY, initialTab: "write" });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "review-pr" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Reviews a pull request for bugs." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview SKILL.md" }));

    const preview = document.querySelector("pre");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe(
      '---\nname: review-pr\ndescription: "Reviews a pull request for bugs."\n---\n\n## When to use this\n\n\n## Steps\n\n1. \n\n## Notes\n',
    );
  });

  it("names the destination path in the footer", () => {
    renderDialog({
      authoring: WRITE_ONLY,
      initialTab: "write",
      providerRoot: null,
    });
    // Shared/global scope is the default, so the fixed cross-provider root
    // is what should show before any name is typed.
    expect(screen.getByText("~/.agents/skills")).toBeDefined();
  });

  it("submits a create action from the write tab", () => {
    const { onSubmit } = renderDialog({
      authoring: WRITE_ONLY,
      initialTab: "write",
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "review-pr" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Reviews a pull request for bugs." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const call = onSubmit.mock.calls[0][0];
    expect(call.action).toBe("create");
    if (call.action !== "create") throw new Error("expected create");
    expect(call.name).toBe("review-pr");
    expect(call.description).toBe("Reviews a pull request for bugs.");
    expect(call.providerScoped).toBe(false);
  });

  it("submits an import action from the import tab", () => {
    const { onSubmit } = renderDialog({
      authoring: IMPORT_ONLY,
      initialTab: "import",
    });
    fireEvent.change(screen.getByLabelText("Git URL or folder path"), {
      target: { value: "https://github.com/org/skill.git" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const call = onSubmit.mock.calls[0][0];
    expect(call.action).toBe("import");
    if (call.action !== "import") throw new Error("expected import");
    expect(call.source).toBe("https://github.com/org/skill.git");
    expect(call.providerScoped).toBe(false);
  });

  it("switches to the import tab and submits from there, when both paths are open", () => {
    const { onSubmit } = renderDialog({ authoring: BOTH, initialTab: "write" });

    // Radix Tabs activates on mouseDown, not click.
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "Import an existing one" }),
    );
    fireEvent.change(screen.getByLabelText("Git URL or folder path"), {
      target: { value: "/Users/dev/skills/review-pr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const call = onSubmit.mock.calls[0][0];
    expect(call.action).toBe("import");
  });
});
