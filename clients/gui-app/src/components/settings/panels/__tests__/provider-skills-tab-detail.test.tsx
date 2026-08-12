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
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";

const skillMocks = vi.hoisted(() => ({
  skills: [] as ProviderSkill[],
  removeScopes: [] as string[],
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
  readFileCalls: [] as Array<{
    workspacePath: string | null;
    filePath: string | null;
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
  ) => {
    skillMocks.readFileCalls.push({ workspacePath, filePath });
    return skillMocks.readFile;
  },
}));

function removeScopes(): ProviderNativeScope[] {
  // Narrowed off the mock's loose `string[]` so a typo in a test reads as an
  // empty scope list (no Remove button) instead of type-checking as one.
  return skillMocks.removeScopes.flatMap((scope) =>
    scope === "global" || scope === "project" ? [scope] : [],
  );
}

function skillsState(): ProviderCliState {
  // `list` only by default: create/import are deliberately empty so the "New"
  // dropdown never mounts here - this suite is about opening an existing skill.
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
          remove: removeScopes(),
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
    skillMocks.mutate.mockReset();
    skillMocks.mutations = [];
    skillMocks.mutateVariables = [];
    skillMocks.mutateIsPending = false;
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

    expect(
      screen.getByRole("button", { name: "Open find-skills (Shared)" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open find-skills (Provider-only)" }),
    ).toBeDefined();
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
});
