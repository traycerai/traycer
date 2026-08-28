import type {
  ProviderNativeScope,
  ProviderSkillInspectCandidate,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSkillComposerDialog } from "@/components/settings/panels/provider-skill-composer-dialog";
import type { SkillAuthoring } from "@/components/settings/panels/provider-skill-composer-model";
import {
  ProviderNativeRpcError,
  type SkillsMutateData,
} from "@/hooks/providers/native-response-map";

const BOTH: SkillAuthoring = {
  canWrite: true,
  canImport: true,
  canInspect: true,
  canAuthor: true,
};
const WRITE_ONLY: SkillAuthoring = {
  canWrite: true,
  canImport: false,
  canInspect: false,
  canAuthor: true,
};
const IMPORT_ONLY: SkillAuthoring = {
  canWrite: false,
  canImport: true,
  canInspect: true,
  canAuthor: true,
};
const LEGACY_IMPORT: SkillAuthoring = {
  canWrite: true,
  canImport: true,
  canInspect: false,
  canAuthor: true,
};

const SHOW_ME: ProviderSkillInspectCandidate = {
  name: "show-me",
  description: "Visual diagrams for a topic.",
  relPath: "show-me/SKILL.md",
  installed: true,
};
const DESIGN_LOOP: ProviderSkillInspectCandidate = {
  name: "design-control-loop",
  description: "Iterate on a design.",
  relPath: "design-control-loop/SKILL.md",
  installed: false,
};
const IMPROVE_MD: ProviderSkillInspectCandidate = {
  name: "improve-claude-md",
  description: null,
  relPath: "improve-claude-md/SKILL.md",
  installed: false,
};

function inspectData(
  candidates: readonly ProviderSkillInspectCandidate[],
  token: string,
): SkillsMutateData {
  return {
    kind: "inspect",
    token,
    candidates,
  };
}

function renderDialog(
  overrides: Partial<{
    authoring: SkillAuthoring;
    listScope: ProviderNativeScope;
    providerRoot: string | null;
    canProviderScope: boolean;
    pending: boolean;
  }>,
) {
  const onMutate =
    vi.fn<
      (mutation: ProvidersSkillsMutateAction) => Promise<SkillsMutateData>
    >();
  onMutate.mockResolvedValue({ kind: "skills", skills: [] });
  const onClose = vi.fn<() => void>();
  render(
    <ProviderSkillComposerDialog
      providerLabel="Codex"
      authoring={overrides.authoring ?? BOTH}
      listScope={overrides.listScope ?? "global"}
      providerRoot={
        overrides.providerRoot === undefined ? null : overrides.providerRoot
      }
      canProviderScope={overrides.canProviderScope ?? true}
      pending={overrides.pending ?? false}
      onMutate={onMutate}
      onClose={onClose}
    />,
  );
  return { onMutate, onClose };
}

function fillSource(value: string): void {
  fireEvent.change(screen.getByLabelText("Skill source"), {
    target: { value },
  });
}

describe("<ProviderSkillComposerDialog />", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens import-first with no Write/Import tab strip when import is advertised", () => {
    renderDialog({ authoring: BOTH });

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Add a skill")).toBeDefined();
    expect(screen.getByLabelText("Skill source")).toBeDefined();
    expect(
      screen.getByPlaceholderText("npx skills add owner/repo"),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "or write one from scratch" }),
    ).toBeDefined();
    expect(screen.queryByRole("tab", { name: "Write a new one" })).toBeNull();
    expect(
      screen.queryByRole("tab", { name: "Import an existing one" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("button", { name: "Add skill" })).toBeDefined();
  });

  it("opens write-only with no import field when import is not advertised", () => {
    renderDialog({ authoring: WRITE_ONLY });

    expect(screen.getByLabelText("Name")).toBeDefined();
    expect(screen.queryByLabelText("Skill source")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "or write one from scratch" }),
    ).toBeNull();
    expect(screen.getByRole("tablist", { name: "Editor view" })).toBeDefined();
  });

  it("hides the write link when only import is advertised", () => {
    renderDialog({ authoring: IMPORT_ONLY });

    expect(screen.getByLabelText("Skill source")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "or write one from scratch" }),
    ).toBeNull();
  });

  it("swaps to the write form from the import step", async () => {
    const user = userEvent.setup();
    renderDialog({ authoring: BOTH });

    await user.click(
      screen.getByRole("button", { name: "or write one from scratch" }),
    );

    expect(screen.getByLabelText("Name")).toBeDefined();
    expect(screen.queryByLabelText("Skill source")).toBeNull();
    expect(
      screen.getByRole("button", { name: "or import an existing one" }),
    ).toBeDefined();
  });

  it("pre-fills the body with the scaffold in the instructions editor", async () => {
    const user = userEvent.setup();
    renderDialog({ authoring: WRITE_ONLY });

    const editor = screen.getByRole("textbox", { name: "Instructions" });
    expect(editor.textContent).toContain("## When to use this");

    await user.click(screen.getByRole("tab", { name: "Preview" }));
    expect(
      screen.getByRole("textbox", { name: "Instructions", hidden: true }),
    ).toBe(editor);
    expect(
      screen.getByTestId("skill-composer-instructions-preview").textContent,
    ).toContain("When to use this");

    await user.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBeDefined();
  });

  it("disables submit and states a reason until name and description are filled", () => {
    renderDialog({ authoring: WRITE_ONLY });
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

  it("names the destination path in the footer", () => {
    renderDialog({
      authoring: WRITE_ONLY,
      providerRoot: null,
    });
    expect(screen.getByText("~/.agents/skills")).toBeDefined();
  });

  it("submits a create action from the write form", async () => {
    const { onMutate } = renderDialog({ authoring: WRITE_ONLY });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "review-pr" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Reviews a pull request for bugs." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

    await waitFor(() => {
      expect(onMutate).toHaveBeenCalledTimes(1);
    });
    const call = onMutate.mock.calls[0]?.[0];
    expect(call).toEqual({
      action: "create",
      name: "review-pr",
      description: "Reviews a pull request for bugs.",
      body: expect.stringContaining("## When to use this") as string,
      providerScoped: false,
    });
  });

  it("uses the legacy single-shot import when inspect is not advertised", async () => {
    const { onMutate } = renderDialog({ authoring: LEGACY_IMPORT });
    fillSource("https://github.com/org/skill.git");

    expect(screen.getByRole("button", { name: "Import skill" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));

    await waitFor(() => {
      expect(onMutate).toHaveBeenCalledTimes(1);
    });
    expect(onMutate.mock.calls[0]?.[0]).toEqual({
      action: "import",
      source: "https://github.com/org/skill.git",
      providerScoped: false,
    });
  });

  it("inspects a source and shows an inline empty message when no SKILL.md is found", async () => {
    const { onMutate, onClose } = renderDialog({ authoring: BOTH });
    onMutate.mockResolvedValueOnce(inspectData([], "tok-empty"));
    fillSource("owner/empty-repo");

    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));

    await waitFor(() => {
      expect(
        screen.getByText("No SKILL.md found in that source."),
      ).toBeDefined();
    });
    expect(onMutate).toHaveBeenCalledWith({
      action: "inspect",
      source: "owner/empty-repo",
      scope: "global",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Skill source")).toBeDefined();
  });

  it("sends an installed singleton through the picker instead of auto-importing", async () => {
    const { onMutate, onClose } = renderDialog({
      authoring: BOTH,
      listScope: "project",
    });
    onMutate.mockImplementation((mutation) => {
      if (mutation.action === "inspect") {
        return Promise.resolve(inspectData([SHOW_ME], "tok-one"));
      }
      return Promise.resolve({ kind: "skills", skills: [] });
    });
    fillSource("owner/repo");

    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));

    await waitFor(() => {
      expect(screen.getByText("1 skill found")).toBeDefined();
    });
    expect(
      screen.getByText(
        "Selecting an installed skill overwrites it from this source.",
      ),
    ).toBeDefined();
    expect(screen.getByText("installed")).toBeDefined();
    const showMe = screen.getByRole("checkbox", { name: "show-me" });
    expect(showMe.getAttribute("data-state")).toBe("checked");
    expect(
      screen.getByRole("button", { name: "Install 1 skill" }),
    ).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(onMutate.mock.calls.map((call) => call[0])).toEqual([
      {
        action: "inspect",
        source: "owner/repo",
        scope: "project",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Install 1 skill" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(onMutate.mock.calls.map((call) => call[0])).toEqual([
      {
        action: "inspect",
        source: "owner/repo",
        scope: "project",
      },
      {
        action: "import",
        source: "owner/repo",
        providerScoped: false,
        token: "tok-one",
        names: ["show-me"],
      },
    ]);
  });

  it("imports an uninstalled singleton immediately after inspect", async () => {
    const { onMutate, onClose } = renderDialog({
      authoring: BOTH,
      listScope: "project",
    });
    onMutate.mockImplementation((mutation) => {
      if (mutation.action === "inspect") {
        return Promise.resolve(inspectData([DESIGN_LOOP], "tok-fresh"));
      }
      return Promise.resolve({ kind: "skills", skills: [] });
    });
    fillSource("owner/repo");

    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(onMutate.mock.calls.map((call) => call[0])).toEqual([
      {
        action: "inspect",
        source: "owner/repo",
        scope: "project",
      },
      {
        action: "import",
        source: "owner/repo",
        providerScoped: false,
        token: "tok-fresh",
        names: ["design-control-loop"],
      },
    ]);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("installed")).toBeNull();
  });

  it("advances to a picker with preselect, overwrite badge, and batch install", async () => {
    const user = userEvent.setup();
    const { onMutate, onClose } = renderDialog({
      authoring: BOTH,
      canProviderScope: true,
      providerRoot: "/Users/dev/.codex/skills",
    });
    onMutate.mockImplementation((mutation) => {
      if (mutation.action === "inspect") {
        return Promise.resolve(
          inspectData([SHOW_ME, DESIGN_LOOP, IMPROVE_MD], "tok-many"),
        );
      }
      return Promise.resolve({ kind: "skills", skills: [] });
    });
    fillSource(
      "npx skills add owner/repo -s show-me --skill design-control-loop",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));

    await waitFor(() => {
      expect(screen.getByText("3 skills found")).toBeDefined();
    });
    expect(
      screen.getByText(
        "Selecting an installed skill overwrites it from this source.",
      ),
    ).toBeDefined();
    expect(screen.getByText("installed")).toBeDefined();
    expect(screen.getByText("Visual diagrams for a topic.")).toBeDefined();
    expect(screen.queryByText("Available to")).toBeNull();

    const showMe = screen.getByRole("checkbox", { name: "show-me" });
    const design = screen.getByRole("checkbox", {
      name: "design-control-loop",
    });
    const improve = screen.getByRole("checkbox", { name: "improve-claude-md" });
    expect(showMe.getAttribute("data-state")).toBe("checked");
    expect(design.getAttribute("data-state")).toBe("checked");
    expect(improve.getAttribute("data-state")).toBe("unchecked");

    const selectAll = screen.getByRole("checkbox", {
      name: "Select all skills",
    });
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");
    await user.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("3 of 3 selected")).toBeDefined();
    expect(improve.getAttribute("data-state")).toBe("checked");

    await user.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("0 of 3 selected")).toBeDefined();
    expect(showMe.getAttribute("data-state")).toBe("unchecked");
    expect(design.getAttribute("data-state")).toBe("unchecked");
    expect(improve.getAttribute("data-state")).toBe("unchecked");

    await user.click(showMe);
    await user.click(design);
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");

    await user.click(improve);
    expect(improve.getAttribute("data-state")).toBe("checked");
    expect(
      screen.getByRole("button", { name: "Install 3 skills" }),
    ).toBeDefined();

    await user.click(improve);
    expect(
      screen.getByRole("button", { name: "Install 2 skills" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Install 2 skills" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    const importCall = onMutate.mock.calls
      .map((call) => call[0])
      .find((mutation) => mutation.action === "import");
    expect(importCall).toEqual({
      action: "import",
      source:
        "npx skills add owner/repo -s show-me --skill design-control-loop",
      providerScoped: false,
      token: "tok-many",
      names: ["show-me", "design-control-loop"],
    });
  });

  it("carries the import-step Available-to choice onto the picker install", async () => {
    const user = userEvent.setup();
    const { onMutate } = renderDialog({
      authoring: BOTH,
      canProviderScope: true,
      providerRoot: "/Users/dev/.codex/skills",
    });
    onMutate.mockImplementation((mutation) => {
      if (mutation.action === "inspect") {
        return Promise.resolve(
          inspectData([SHOW_ME, DESIGN_LOOP], "tok-scope"),
        );
      }
      return Promise.resolve({ kind: "skills", skills: [] });
    });
    fillSource("owner/repo");
    await user.click(screen.getByLabelText(/Codex only/));

    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    await waitFor(() => {
      expect(screen.getByText("2 skills found")).toBeDefined();
    });
    await user.click(screen.getByRole("checkbox", { name: "show-me" }));
    fireEvent.click(screen.getByRole("button", { name: "Install 1 skill" }));

    await waitFor(() => {
      expect(
        onMutate.mock.calls.some((call) => call[0].action === "import"),
      ).toBe(true);
    });
    expect(
      onMutate.mock.calls
        .map((call) => call[0])
        .find((mutation) => mutation.action === "import"),
    ).toMatchObject({
      action: "import",
      token: "tok-scope",
      names: ["show-me"],
      providerScoped: true,
    });
  });

  it("re-inspects into a fresh picker when a token import hits a SHA mismatch", async () => {
    const user = userEvent.setup();
    const { onMutate } = renderDialog({ authoring: BOTH });
    let inspectCount = 0;
    onMutate.mockImplementation((mutation) => {
      if (mutation.action === "inspect") {
        inspectCount += 1;
        if (inspectCount === 1) {
          return Promise.resolve(
            inspectData([SHOW_ME, DESIGN_LOOP], "tok-stale"),
          );
        }
        return Promise.resolve(
          inspectData([SHOW_ME, DESIGN_LOOP, IMPROVE_MD], "tok-fresh"),
        );
      }
      throw new ProviderNativeRpcError({
        code: "external_drift",
        detail:
          "Inspected commit abc123 no longer matches source (def456); inspect again",
        method: "providers.nativeMutate",
      });
    });
    fillSource("owner/repo");
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));

    await waitFor(() => {
      expect(screen.getByText("2 skills found")).toBeDefined();
    });
    await user.click(screen.getByRole("checkbox", { name: "show-me" }));
    fireEvent.click(screen.getByRole("button", { name: "Install 1 skill" }));

    await waitFor(() => {
      expect(screen.getByText("3 skills found")).toBeDefined();
    });
    expect(
      screen.getByText(
        "The source changed since the last look. Pick again from the updated list.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("checkbox", { name: "improve-claude-md" }),
    ).toBeDefined();
    const inspectCalls = onMutate.mock.calls.filter(
      (call) => call[0].action === "inspect",
    );
    expect(inspectCalls).toHaveLength(2);
    expect(inspectCalls[1]?.[0]).toEqual({
      action: "inspect",
      source: "owner/repo",
      scope: "global",
    });
  });

  it("hides Available to when neither create nor import advertises the scope", () => {
    renderDialog({
      authoring: BOTH,
      canProviderScope: false,
      providerRoot: null,
    });

    expect(screen.queryByText("Available to")).toBeNull();
    expect(screen.queryByLabelText(/Codex only/)).toBeNull();
    expect(screen.queryByLabelText(/Every provider/)).toBeNull();
  });

  it("shows Available to with generic provider destination when no provider root is known", async () => {
    const user = userEvent.setup();
    renderDialog({
      authoring: BOTH,
      canProviderScope: true,
      providerRoot: null,
    });

    expect(screen.getByText("Available to")).toBeDefined();
    expect(screen.getByLabelText(/Every provider/)).toBeDefined();
    expect(screen.getByLabelText(/Codex only/)).toBeDefined();
    expect(screen.getByText("~/.agents/skills")).toBeDefined();

    await user.click(screen.getByLabelText(/Codex only/));
    expect(screen.getByText("Codex's own skills folder")).toBeDefined();
    expect(screen.queryByText(/\.codex\/skills/)).toBeNull();
  });

  it("shows Available to on import and write when provider scope is honest", async () => {
    const user = userEvent.setup();
    renderDialog({
      authoring: BOTH,
      canProviderScope: true,
      providerRoot: "/Users/dev/.codex/skills",
    });

    expect(screen.getByText("Available to")).toBeDefined();
    expect(screen.getByLabelText(/Every provider/)).toBeDefined();
    expect(screen.getByLabelText(/Codex only/)).toBeDefined();

    await user.click(
      screen.getByRole("button", { name: "or write one from scratch" }),
    );
    expect(screen.getByText("Available to")).toBeDefined();
  });
});
