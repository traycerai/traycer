import type {
  ProviderNativeScope,
  ProviderSkill,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@uiw/react-codemirror";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";
import { ProviderNativeRpcError } from "@/hooks/providers/native-response-map";
import { fileContentRevision } from "@/lib/workspace/file-content-revision";

type SkillsListMutateResult = {
  readonly kind: "skills";
  readonly skills: readonly ProviderSkill[];
};

const skillMocks = vi.hoisted(() => ({
  skills: [] as ProviderSkill[],
  removeScopes: [] as string[],
  editScopes: [] as string[],
  updateScopes: [] as string[],
  mutate: vi.fn(),
  // Captured through the wrapper below rather than read off
  // `mutate.mock.calls`, which types as `any[]` and trips the repo's
  // no-unsafe-member-access rule the moment a test looks inside it.
  mutations: [] as ProvidersSkillsMutateAction[],
  // The whole variables object, so the suite can assert the flags riding
  // alongside the mutation - `suppressToast` in particular, which is what
  // stops the hook's global toast from double-reporting the error this dialog
  // already renders inline.
  mutateVariables: [] as Array<{ readonly suppressToast: boolean }>,
  mutateIsPending: false,
  onMutateAsync: (
    _mutation: ProvidersSkillsMutateAction,
  ): Promise<SkillsListMutateResult> =>
    Promise.resolve({
      kind: "skills",
      skills: [],
    }),
  readFileCalls: [] as Array<{
    workspacePath: string | null;
    filePath: string | null;
    cacheKeyIdentity: ReadonlyArray<unknown> | undefined;
  }>,
  readFile: {
    data: undefined as
      | {
          content: string | null;
          truncated: boolean;
          error: string | null;
        }
      | undefined,
    isPending: false,
    isError: false,
    error: null as { message: string } | null,
  },
}));

// Detail suite is about open/remove/readFile — not scope switching. Stub the
// shared hook so F5's workspace resolution does not require a QueryClient.
// Dynamic import: `vi.mock` is hoisted above static imports.
vi.mock("@/components/settings/panels/use-provider-native-scope", async () => {
  const { GLOBAL_ONLY_NATIVE_SCOPE } =
    await import("@/components/settings/panels/__tests__/provider-native-scope-test-mocks");
  return {
    useProviderNativeScope: () => GLOBAL_ONLY_NATIVE_SCOPE,
  };
});

vi.mock("@/hooks/providers/use-providers-skills-list-query", () => ({
  useProvidersSkillsList: () => ({
    data: { skills: skillMocks.skills },
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/providers/use-providers-skills-mutate-mutation", () => ({
  useProvidersSkillsMutate: () => ({
    mutate: (
      variables: {
        mutation: ProvidersSkillsMutateAction;
        suppressToast: boolean;
      },
      opts: {
        onSuccess: () => void;
        onError: (err: { message: string }) => void;
      },
    ) => {
      skillMocks.mutations.push(variables.mutation);
      skillMocks.mutateVariables.push({
        suppressToast: variables.suppressToast,
      });
      skillMocks.mutate(variables, opts);
    },
    mutateAsync: async (variables: {
      mutation: ProvidersSkillsMutateAction;
      suppressToast: boolean;
    }) => {
      skillMocks.mutations.push(variables.mutation);
      skillMocks.mutateVariables.push({
        suppressToast: variables.suppressToast,
      });
      return skillMocks.onMutateAsync(variables.mutation);
    },
    isPending: skillMocks.mutateIsPending,
  }),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

// The dialog reads SKILL.md off disk. Mocked at the hook so the suite can say
// what came back - including the failure shape `workspace.readFile` actually
// uses, which RESOLVES with `content: null` and an `error` string rather than
// rejecting.
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: (
    _client: null,
    workspacePath: string | null,
    filePath: string | null,
    cacheKeyIdentity: ReadonlyArray<unknown> | undefined,
  ) => {
    skillMocks.readFileCalls.push({
      workspacePath,
      filePath,
      cacheKeyIdentity,
    });
    return skillMocks.readFile;
  },
}));

function advertisedScopes(names: readonly string[]): ProviderNativeScope[] {
  // Narrowed off the mock's loose `string[]` so a typo in a test reads as an
  // empty scope list (no Remove/Edit/Update button) instead of type-checking
  // as one.
  return names.flatMap((scope) =>
    scope === "global" || scope === "project" ? [scope] : [],
  );
}

function skillsState(): ProviderCliState {
  // `list` only by default: create/import are deliberately empty so the "New"
  // dropdown never mounts here - this suite is about opening an existing skill.
  // `edit` / `update` keys stay omitted unless a test advertises them: absent
  // is the old-host skew gate and is not the same as an empty array.
  const edit = advertisedScopes(skillMocks.editScopes);
  const update = advertisedScopes(skillMocks.updateScopes);
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["skills"],
      mcp: null,
      plugins: null,
      skills: {
        actionScopes: {
          list: ["global"],
          add: [],
          create: [],
          import: [],
          remove: advertisedScopes(skillMocks.removeScopes),
          ...(skillMocks.editScopes.length > 0 ? { edit } : {}),
          ...(skillMocks.updateScopes.length > 0 ? { update } : {}),
        },
      },
      modelProviders: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

function renderTab(): void {
  render(<ProviderSkillsTab state={skillsState()} />);
}

/**
 * The confirmation's destructive button, by role.
 *
 * Scoped through the dialog rather than queried globally even though a bare
 * `getByRole("button", { name: "Remove" })` happens to work: the skill dialog
 * behind it has its own "Remove", and the only reason that one is not also a
 * match is that Radix `aria-hidden`s the background while a modal is open. So
 * the global query returns the CONFIRM button here and the SKILL dialog's
 * button two lines later, which reads as a bug even when it isn't. Scoping
 * says which one is meant.
 */
function confirmAction(): HTMLElement {
  return within(screen.getByTestId("confirm-destructive-dialog")).getByRole(
    "button",
    { name: "Remove" },
  );
}

function confirmUpdateAction(): HTMLElement {
  return within(screen.getByTestId("confirm-destructive-dialog")).getByRole(
    "button",
    { name: "Update" },
  );
}

function replaceInstructions(markdown: string): void {
  const editor = screen.getByTestId("skill-detail-instructions");
  const view = EditorView.findFromDOM(editor);
  if (view === null) throw new Error("Expected a CodeMirror editor element");
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: markdown },
    });
  });
}

function nativeError(
  code: "external_drift" | "no_change_detected",
  detail: string,
): ProviderNativeRpcError {
  return new ProviderNativeRpcError({
    code,
    detail,
    method: "providers.nativeMutate",
  });
}

const FIND_SKILLS: ProviderSkill = {
  name: "find-skills",
  description: "Helps users discover and install agent skills.",
  path: "/Users/dev/.agents/skills/find-skills",
  source: "shared",
};

describe("<ProviderSkillsTab /> skill detail", () => {
  beforeEach(() => {
    skillMocks.skills = [FIND_SKILLS];
    skillMocks.removeScopes = [];
    skillMocks.editScopes = [];
    skillMocks.updateScopes = [];
    skillMocks.mutate.mockReset();
    skillMocks.mutations = [];
    skillMocks.mutateVariables = [];
    skillMocks.mutateIsPending = false;
    skillMocks.onMutateAsync = () =>
      Promise.resolve({ kind: "skills", skills: [] });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    skillMocks.readFileCalls = [];
    skillMocks.readFile = {
      data: {
        content:
          '---\nname: find-skills\ndescription: "Helps"\n---\n\n# When to use\n\nAsk for a skill.\n',
        truncated: false,
        error: null,
      },
      isPending: false,
      isError: false,
      error: null,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the empty-list copy when no skills are installed", () => {
    skillMocks.skills = [];
    renderTab();

    expect(screen.getByText("No skills yet")).toBeDefined();
    expect(
      screen.getByRole("textbox", { name: "Search skills" }),
    ).toBeDefined();
    expect(screen.queryByText(/No skills match/)).toBeNull();
  });

  it("distinguishes an unmatched query from a truly empty skill list", () => {
    skillMocks.skills = [
      FIND_SKILLS,
      {
        name: "release-notes",
        description: "Write release notes from a changeset.",
        path: "/Users/dev/.traycer/managed-skills/release-notes",
        source: "managed",
      },
    ];
    renderTab();

    expect(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open release-notes (Built-in)" }),
    ).toBeDefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Search skills" }), {
      target: { value: "zzzz-nope" },
    });

    expect(
      screen.queryByRole("button", { name: "Open find-skills (Shared)" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open release-notes (Built-in)" }),
    ).toBeNull();
    expect(
      screen.queryByText(
        "No skills yet. Create one or import from a git URL / folder.",
      ),
    ).toBeNull();
    expect(screen.getByText("No skills match “zzzz-nope”.")).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("No skills match.");
  });

  // Rows are keyed `source:path`, so the SAME name under two roots is a shape
  // the protocol allows outright. An `aria-label` replaces every descendant
  // string, so a name-only label hides the source badge that distinguishes
  // them and hands a screen reader two identical "Open find-skills" buttons.
  // Asserted through a strict role query, which THROWS on an ambiguous match -
  // a `getAllBy` length check here would pass just as well with both labels
  // identical.
  it("distinguishes same-named skills from different roots by accessible name", () => {
    skillMocks.skills = [
      FIND_SKILLS,
      {
        ...FIND_SKILLS,
        path: "/Users/dev/.codex/skills/find-skills",
        source: "provider",
      },
    ];
    renderTab();

    const sharedRow = screen.getByRole("button", {
      name: "Open find-skills (Shared)",
    });
    const providerRow = screen.getByRole("button", {
      name: "Open find-skills (Provider-only)",
    });
    expect(sharedRow).toBeDefined();
    expect(providerRow).toBeDefined();
    expect(within(sharedRow).getByText("Shared")).toBeDefined();
    expect(within(providerRow).getByText("Provider-only")).toBeDefined();
  });

  it("does not mount the file read until a row is opened", () => {
    renderTab();
    expect(screen.getByText("find-skills")).toBeDefined();

    // Asserted as a COUNT, not as "every call was disabled": the dialog is
    // mounted conditionally, so a `.every()` over an empty array would pass
    // for the wrong reason (and keep passing if the gate were removed but the
    // hook happened to be called with nulls). The list may hold dozens of
    // skills; reading every body on mount pays for content nobody asked for,
    // and the host query is what makes the tab need a QueryClient at all.
    expect(skillMocks.readFileCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));
    expect(skillMocks.readFileCalls.length).toBeGreaterThan(0);
  });

  it("keeps the same dialog shell while the skill body loads", () => {
    skillMocks.editScopes = ["global"];
    skillMocks.readFile = {
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
    };
    const view = render(<ProviderSkillsTab state={skillsState()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    const shell = screen.getByRole("dialog");
    expect(shell.textContent).toContain("Loading skill");
    expect(shell.className).toContain("h-[min(86dvh,calc(100dvh-2rem))]");

    skillMocks.readFile = {
      data: {
        content:
          '---\nname: find-skills\ndescription: "Helps"\n---\n\n# When to use\n\nAsk for a skill.\n',
        truncated: false,
        error: null,
      },
      isPending: false,
      isError: false,
      error: null,
    };
    view.rerender(<ProviderSkillsTab state={skillsState()} />);

    expect(screen.getByRole("dialog")).toBe(shell);
    expect(screen.queryByText("Loading skill")).toBeNull();
    expect(screen.getByTestId("skill-detail-body-preview")).toBeDefined();
  });

  it("gives a skill no icon tile, in the row or the dialog", () => {
    // Skills have no artwork source in any provider's format, so a tile here
    // could only be a glyph we invented. Now that plugin rows render a real
    // `<img>` and nothing else, the element check is the meaningful one - and
    // "fs" (what the deleted monogram would have drawn for "find-skills")
    // guards against a text-based tile coming back in its place.
    const { container } = render(<ProviderSkillsTab state={skillsState()} />);
    expect(screen.queryByText("fs")).toBeNull();
    expect(container.querySelector("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")).toBeNull();
    expect(screen.queryByText("fs")).toBeNull();
    // The badge is what actually distinguishes one skill from another here.
    expect(dialog.textContent).toContain("Shared");
  });

  it("opens the skill and renders its body without the frontmatter", () => {
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("When to use");
    expect(dialog.textContent).toContain("Ask for a skill.");
    // The header already shows name + description; re-printing the raw
    // frontmatter would show them twice, as a `---`-delimited paragraph.
    expect(dialog.textContent).not.toContain("description:");
    expect(screen.getByTestId("skill-detail-body-preview")).toBeDefined();
    expect(screen.queryByRole("tab", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Editor view" })).toBeNull();

    expect(
      skillMocks.readFileCalls.some(
        (call) =>
          call.workspacePath === FIND_SKILLS.path &&
          call.filePath === "SKILL.md",
      ),
    ).toBe(true);
  });

  it("reports a readFile that resolves with an error instead of rendering blank", () => {
    skillMocks.readFile = {
      data: { content: null, truncated: false, error: "File is unavailable." },
      isPending: false,
      isError: false,
      error: null,
    };
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    expect(screen.getByRole("dialog").textContent).toContain(
      "File is unavailable.",
    );
  });

  it("offers no Remove action when the contract advertises no remove scope", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("confirms, then removes with the name AND path the row was rendered from", () => {
    skillMocks.removeScopes = ["global"];
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    // Destructive and irreversible (the host `rm -rf`s the directory), so it
    // goes through the shared confirmation rather than firing on one click.
    expect(skillMocks.mutate).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("confirm-destructive-dialog");
    expect(confirm.textContent).toContain(FIND_SKILLS.name);

    fireEvent.click(confirmAction());

    // The host re-lists and matches on BOTH before deleting anything, so a
    // request carrying only one of them could not be refused when stale.
    expect(skillMocks.mutations).toEqual([
      {
        action: "remove",
        name: FIND_SKILLS.name,
        path: FIND_SKILLS.path,
      },
    ]);
    // `suppressToast` rides with it because this dialog renders the failure
    // inline (see the two error tests below). Without the flag the hook's
    // `toastFromHostError` reports the same failure a second time, over a
    // dialog that is already showing it.
    expect(skillMocks.mutateVariables).toEqual([{ suppressToast: true }]);
  });

  it("disables Remove for ANY pending skill mutation, but only spins for its own", () => {
    // A destructive action's pending state is where a double-submit does
    // damage, and nothing else in this suite exercises it.
    //
    // Removal is disabled by any in-flight skill mutation, not only by another
    // removal: every one of them goes through a SINGLE `useMutation` observer,
    // and a second `mutate()` on it replaces the first call's
    // `onSuccess`/`onError`. Starting a removal on top of a pending create can
    // therefore swallow that create's failure with no inline error and no
    // toast - and both share the one `pendingKey`, so whichever settles first
    // clears it while the other is still running.
    //
    // The SPINNER stays specific, which is why these are two props and not
    // one: an unrelated create must not make this button claim to be doing the
    // removing.
    skillMocks.removeScopes = ["global"];
    skillMocks.mutateIsPending = true;
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    // The native `disabled` property, not `toBeDisabled()`: jest-dom's
    // matchers are not wired into this suite, so the matcher would be
    // undefined rather than failing informatively.
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove instanceof HTMLButtonElement && remove.disabled).toBe(true);
    // Still the trash ICON, not the spinner: the pending operation is somebody
    // else's. The spinner renders a `<span>` of braille frames, so the lucide
    // `<svg>` surviving here is what says the button is not claiming the work.
    expect(remove.querySelector("svg")).not.toBeNull();
  });

  it("disables Remove and spins it once THIS removal is in flight", () => {
    // The confirmation is driven for real - the mutate mock takes the call and
    // settles nothing, which is exactly "in flight" - because `pendingKey` is
    // internal state that only the real path sets.
    skillMocks.removeScopes = ["global"];
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    const remove = screen.getByRole("button", { name: "Remove" });
    // Nothing pending yet, so it is live - otherwise the assertions below
    // would pass on a button that was disabled the whole time.
    expect(remove instanceof HTMLButtonElement && remove.disabled).toBe(false);

    fireEvent.click(remove);
    skillMocks.mutateIsPending = true;
    fireEvent.click(confirmAction());

    const pendingRemove = screen.getByRole("button", { name: "Remove" });
    expect(
      pendingRemove instanceof HTMLButtonElement && pendingRemove.disabled,
    ).toBe(true);
    // Now it IS the pending operation, so the icon gives way to the spinner.
    expect(pendingRemove.querySelector("svg")).toBeNull();
  });

  it("blocks removal of a built-in skill and says why, under the same provider", () => {
    // The contract advertises `remove` here - what stops it is the SOURCE.
    // Offering the button would offer a guaranteed host-side failure.
    skillMocks.removeScopes = ["global"];
    skillMocks.skills = [{ ...FIND_SKILLS, source: "managed" }];
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Built-in skills");
  });

  it("closes both dialogs once the removal succeeds", () => {
    skillMocks.removeScopes = ["global"];
    skillMocks.mutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: () => void }) => {
        opts.onSuccess();
      },
    );
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(confirmAction());

    // The open skill no longer exists on disk; leaving its dialog up would
    // leave a readFile pointed at a deleted path.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });

  it("keeps the skill dialog open and shows the host error when removal fails", () => {
    skillMocks.removeScopes = ["global"];
    skillMocks.mutate.mockImplementation(
      (
        _vars: unknown,
        opts: { onError: (err: { message: string }) => void },
      ) => {
        opts.onError({
          message:
            'Cannot remove skill "find-skills": path is outside writable skill roots',
        });
      },
    );
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(confirmAction());

    // The confirmation closes (re-confirming what just failed is not the next
    // step) but the skill dialog stays - the tab's own error banner would be
    // behind it and invisible.
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain(
      "outside writable skill roots",
    );
  });

  it("says so when a skill is frontmatter with no instructions", () => {
    skillMocks.readFile = {
      data: {
        content: "---\nname: find-skills\ndescription: x\n---\n",
        truncated: false,
        error: null,
      },
      isPending: false,
      isError: false,
      error: null,
    };
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^Open find-skills/ }));

    expect(screen.getByRole("dialog").textContent).toContain("no instructions");
  });

  it("shows a Conflict badge and tooltip on a conflict row", async () => {
    const user = userEvent.setup();
    skillMocks.skills = [{ ...FIND_SKILLS, conflict: true }];
    renderTab();

    const row = screen.getByRole("button", {
      name: /Open find-skills \(Shared, Conflict/,
    });
    expect(within(row).getByText("Shared")).toBeDefined();
    const badge = within(row).getByText("Conflict");
    expect(badge).toBeDefined();

    await user.hover(badge);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/occupies this provider's link/i);
    expect(tooltip.textContent).toMatch(/did not adopt or overwrite/i);
  });

  it("shows Imported from origin in the detail dialog, and omits it when there is none", () => {
    skillMocks.skills = [
      { ...FIND_SKILLS, origin: "Imported from owner/repo" },
    ];
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    const withOrigin = screen.getByRole("dialog").textContent;
    expect(withOrigin).toContain("Imported from owner/repo");
    expect(withOrigin).not.toContain("Imported from Imported from");

    cleanup();
    skillMocks.skills = [FIND_SKILLS];
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    expect(screen.getByRole("dialog").textContent).not.toContain(
      "Imported from",
    );
  });

  it("edits in the existing detail dialog and submits edit not create", async () => {
    const user = userEvent.setup();
    skillMocks.editScopes = ["global"];
    skillMocks.removeScopes = ["global"];
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    const detail = screen.getByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("dialog")).toBe(detail);
    expect(screen.queryByText("Add a skill")).toBeNull();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDefined();
    expect(save instanceof HTMLButtonElement && save.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText("Markdown")).toBeDefined();
    expect(screen.queryByRole("tablist", { name: "Editor view" })).toBeNull();
    expect(detail.textContent).toContain(
      "/Users/dev/.agents/skills/find-skills",
    );
    expect(screen.queryByText("Available to")).toBeNull();
    expect(screen.queryByLabelText(/Every provider/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "or import an existing one" }),
    ).toBeNull();

    const nameInput = screen.getByLabelText("Name");
    expect(nameInput instanceof HTMLInputElement && nameInput.value).toBe(
      "find-skills",
    );
    const descriptionInput = screen.getByRole("textbox", {
      name: "When to use",
    });
    expect(
      descriptionInput instanceof HTMLTextAreaElement && descriptionInput.value,
    ).toBe("Helps");
    expect(document.activeElement).toBe(nameInput);
    const editor = screen.getByTestId("skill-detail-instructions");
    const view = EditorView.findFromDOM(editor);
    if (view === null) throw new Error("Expected a CodeMirror editor element");
    expect(view.state.doc.toString()).toBe(
      "# When to use\n\nAsk for a skill.\n",
    );

    fireEvent.change(nameInput, { target: { value: "find-skills-v2" } });
    fireEvent.change(descriptionInput, {
      target: { value: "Updated description" },
    });
    replaceInstructions("# New body\n");

    await user.click(save);

    const baseline = skillMocks.readFile.data?.content;
    if (baseline === undefined || baseline === null) {
      throw new Error("expected the open skill file content");
    }
    const expectedHash = await fileContentRevision(baseline);

    await waitFor(() => {
      expect(skillMocks.mutations).toEqual([
        {
          action: "edit",
          path: FIND_SKILLS.path,
          expectedHash,
          name: "find-skills-v2",
          description: "Updated description",
          body: "# New body\n",
        },
      ]);
    });
    expect(screen.getByRole("dialog")).toBe(detail);
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toBeDefined();
    expect(document.activeElement).toBe(edit);
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("preserves instruction scroll position when switching modes", async () => {
    const user = userEvent.setup();
    skillMocks.editScopes = ["global"];
    renderTab();
    await user.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );

    const preview = screen.getByTestId("skill-detail-body-preview");
    preview.scrollTop = 137;
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const editor = screen.getByTestId("skill-detail-instructions");
    const view = EditorView.findFromDOM(editor);
    if (view === null) throw new Error("Expected a CodeMirror editor element");
    expect(view.scrollDOM.scrollTop).toBe(137);

    view.scrollDOM.scrollTop = 83;
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(preview.scrollTop).toBe(83);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit" }),
    );
  });

  it("keeps Save changes available and focuses the first invalid field", async () => {
    const user = userEvent.setup();
    skillMocks.editScopes = ["global"];
    renderTab();
    await user.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "" } });
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save instanceof HTMLButtonElement && save.disabled).toBe(false);

    await user.click(save);

    expect(screen.getByText("Give the skill a name.")).toBeDefined();
    expect(document.activeElement).toBe(name);
    expect(skillMocks.mutations).toEqual([]);
  });

  it("discards a dirty draft or keeps editing without replacing the detail dialog", async () => {
    const user = userEvent.setup();
    skillMocks.editScopes = ["global"];
    renderTab();
    await user.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    const detail = screen.getByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "changed-name" } });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const warning = screen.getByTestId("skill-unsaved-changes-dialog");
    await user.click(
      within(warning).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.queryByTestId("skill-unsaved-changes-dialog")).toBeNull();
    expect(name instanceof HTMLInputElement && name.value).toBe("changed-name");
    expect(screen.getByRole("dialog")).toBe(detail);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(
      within(screen.getByTestId("skill-unsaved-changes-dialog")).getByRole(
        "button",
        { name: "Discard changes" },
      ),
    );

    expect(screen.getByRole("dialog")).toBe(detail);
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(name instanceof HTMLInputElement && name.value).toBe("find-skills");
  });

  it("treats a reverted draft as unchanged and cancels without a warning", async () => {
    const user = userEvent.setup();
    skillMocks.editScopes = ["global"];
    renderTab();
    await user.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "changed-name" } });
    fireEvent.change(name, { target: { value: "find-skills" } });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("skill-unsaved-changes-dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
  });

  it("guards Escape and closes the detail only after dirty changes are discarded", async () => {
    const user = userEvent.setup();
    skillMocks.editScopes = ["global"];
    renderTab();
    await user.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "changed-name" } });
    name.focus();

    await user.keyboard("{Escape}");
    const warning = screen.getByTestId("skill-unsaved-changes-dialog");
    await user.click(
      within(warning).getByRole("button", { name: "Discard changes" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the draft open when saving fails", async () => {
    const user = userEvent.setup();
    skillMocks.editScopes = ["global"];
    skillMocks.onMutateAsync = () =>
      Promise.reject(new Error("The skill changed on disk."));
    renderTab();
    await user.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "changed-name" } });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("The skill changed on disk.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDefined();
    expect(name instanceof HTMLInputElement && name.value).toBe("changed-name");
  });

  it("asks to overwrite local edits after a dirty-canon update, then resends with confirm", async () => {
    const user = userEvent.setup();
    skillMocks.updateScopes = ["global"];
    skillMocks.skills = [{ ...FIND_SKILLS, origin: "owner/repo" }];
    skillMocks.onMutateAsync = (mutation) => {
      if (mutation.action === "update" && mutation.confirm !== true) {
        return Promise.reject(
          nativeError(
            "external_drift",
            "Inspected source changed (abc123 → def456); inspect again",
          ),
        );
      }
      return Promise.resolve({ kind: "skills", skills: [] });
    };
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Update from source" }),
    );

    const confirm = await screen.findByTestId("confirm-destructive-dialog");
    expect(confirm.textContent).toMatch(
      /local edits that will be overwritten/i,
    );
    expect(confirm.textContent).toMatch(/Overwrite local edits/i);
    expect(skillMocks.mutations).toEqual([
      {
        action: "update",
        name: FIND_SKILLS.name,
        path: FIND_SKILLS.path,
      },
    ]);
    expect(toast.success).not.toHaveBeenCalled();

    await user.click(confirmUpdateAction());

    await waitFor(() => {
      expect(skillMocks.mutations).toEqual([
        {
          action: "update",
          name: FIND_SKILLS.name,
          path: FIND_SKILLS.path,
        },
        {
          action: "update",
          name: FIND_SKILLS.name,
          path: FIND_SKILLS.path,
          confirm: true,
        },
      ]);
    });
  });

  it("toasts Already up to date when update is a no-op, without a confirm dialog", async () => {
    const user = userEvent.setup();
    skillMocks.updateScopes = ["global"];
    skillMocks.skills = [{ ...FIND_SKILLS, origin: "owner/repo" }];
    skillMocks.onMutateAsync = () => {
      return Promise.reject(
        nativeError("no_change_detected", "Source matches the installed skill"),
      );
    };
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Update from source" }),
    );

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Already up to date");
    });
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(skillMocks.mutations).toEqual([
      {
        action: "update",
        name: FIND_SKILLS.name,
        path: FIND_SKILLS.path,
      },
    ]);
  });

  it("hides Edit and Update from source when actionScopes omit those keys", () => {
    // Old-host skew: absent keys, not empty arrays. The fixture must not
    // default edit/update.
    skillMocks.skills = [
      { ...FIND_SKILLS, origin: "Imported from owner/repo" },
    ];
    const caps = skillsState().nativeCapabilities.skills;
    if (caps === null) throw new Error("expected skills capabilities");
    expect("edit" in caps.actionScopes).toBe(false);
    expect("update" in caps.actionScopes).toBe(false);

    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );

    const dialogText = screen.getByRole("dialog").textContent;
    expect(dialogText).toContain("Imported from owner/repo");
    expect(dialogText).not.toContain("Imported from Imported from");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Update from source" }),
    ).toBeNull();
  });

  it("says removing a shared skill removes it for every provider", () => {
    skillMocks.removeScopes = ["global"];
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).toMatch(/removing a shared skill removes it for every provider/i);
  });

  it("refreshes the open dialog in place after a successful Update from source", async () => {
    const user = userEvent.setup();
    skillMocks.updateScopes = ["global"];
    skillMocks.skills = [
      { ...FIND_SKILLS, origin: "Imported from owner/repo" },
    ];
    const updatedRow: ProviderSkill = {
      ...FIND_SKILLS,
      name: "find-skills-v2",
      description: "Updated from source",
      origin: "Imported from owner/repo#next",
    };
    skillMocks.onMutateAsync = () => {
      skillMocks.readFile = {
        data: {
          content:
            '---\nname: find-skills-v2\ndescription: "Updated from source"\n---\n\n# After update\n\nUpdated instructions from source.\n',
          truncated: false,
          error: null,
        },
        isPending: false,
        isError: false,
        error: null,
      };
      return Promise.resolve({ kind: "skills", skills: [updatedRow] });
    };
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );

    const before = screen.getByRole("dialog").textContent;
    expect(before).toContain("find-skills");
    expect(before).toContain("Helps users discover and install agent skills.");
    expect(before).toContain("Imported from owner/repo");
    expect(before).not.toContain("Imported from Imported from");
    expect(before).toContain("Ask for a skill.");
    expect(
      skillMocks.readFileCalls.some(
        (call) =>
          Array.isArray(call.cacheKeyIdentity) &&
          call.cacheKeyIdentity[0] === 0,
      ),
    ).toBe(true);

    await user.click(
      screen.getByRole("button", { name: "Update from source" }),
    );

    await waitFor(() => {
      const after = screen.getByRole("dialog").textContent;
      expect(after).toContain("find-skills-v2");
      expect(after).toContain("Updated from source");
      expect(after).toContain("Imported from owner/repo#next");
      expect(after).toContain("Updated instructions from source.");
    });
    const after = screen.getByRole("dialog").textContent;
    expect(after).not.toContain(
      "Helps users discover and install agent skills.",
    );
    expect(after).not.toContain("Ask for a skill.");
    expect(after).not.toContain("Imported from Imported from");
    expect(
      skillMocks.readFileCalls.some(
        (call) =>
          Array.isArray(call.cacheKeyIdentity) &&
          call.cacheKeyIdentity[0] === 1,
      ),
    ).toBe(true);
  });

  it("closes the detail dialog when update succeeds without the open skill path", async () => {
    const user = userEvent.setup();
    skillMocks.updateScopes = ["global"];
    skillMocks.skills = [
      { ...FIND_SKILLS, origin: "Imported from owner/repo" },
    ];
    skillMocks.onMutateAsync = () =>
      Promise.resolve({
        kind: "skills",
        skills: [
          {
            ...FIND_SKILLS,
            name: "other-skill",
            path: "/Users/dev/.agents/skills/other-skill",
          },
        ],
      });
    renderTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    );
    expect(screen.getByRole("dialog")).toBeDefined();

    await user.click(
      screen.getByRole("button", { name: "Update from source" }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      skillMocks.readFileCalls.some(
        (call) =>
          Array.isArray(call.cacheKeyIdentity) &&
          call.cacheKeyIdentity[0] === 1,
      ),
    ).toBe(false);
  });

  it("does not offer Remove on a conflict row, and says why", () => {
    skillMocks.removeScopes = ["global"];
    skillMocks.skills = [{ ...FIND_SKILLS, conflict: true }];
    renderTab();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open find-skills \(Shared, Conflict/,
      }),
    );

    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByRole("dialog").textContent).toMatch(
      /occupies the provider link/i,
    );
  });
});
