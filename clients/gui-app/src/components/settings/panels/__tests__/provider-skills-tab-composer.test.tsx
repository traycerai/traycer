import type {
  ProviderNativeScope,
  ProviderSkill,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";

const skillMocks = vi.hoisted(() => ({
  skills: [] as ProviderSkill[],
  createScopes: [] as string[],
  importScopes: [] as string[],
  inspectScopes: [] as string[],
  /** What `useHostCredentialRefusal` answers; `null` is a host that takes credentials. */
  credentialRefusal: null as string | null,
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => skillMocks.credentialRefusal,
}));

// Entry-button suite never switches scope; stub shared hook so F5 workspace
// resolution does not require a QueryClient. Dynamic import: `vi.mock` is
// hoisted above static imports.
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
    mutate: vi.fn<() => void>(),
    mutateAsync: skillMocks.mutateAsync,
    isPending: false,
  }),
}));

// Not exercised in this suite (no row is ever opened), but statically
// imported by the tab through `ProviderSkillDetailDialog`, so it needs a
// well-shaped mock the same way `provider-skills-tab-detail.test.tsx` does.
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: (
    _client: unknown,
    _workspacePath: string | null,
    _filePath: string | null,
    _cacheKeyIdentity: ReadonlyArray<unknown> | undefined,
  ) => ({
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

function scopes(names: readonly string[]): ProviderNativeScope[] {
  return names.flatMap((name) =>
    name === "global" || name === "project" ? [name] : [],
  );
}

function skillsState(): ProviderCliState {
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
          create: scopes(skillMocks.createScopes),
          import: scopes(skillMocks.importScopes),
          remove: [],
          inspect: scopes(skillMocks.inspectScopes),
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

// A non-empty list so the header Add skill is the only one on the page —
// the empty state renders its own copy of the same label.
const SOME_SKILL: ProviderSkill = {
  name: "find-skills",
  description: "Helps users discover and install agent skills.",
  path: "/Users/dev/.agents/skills/find-skills",
  source: "shared",
};

describe("<ProviderSkillsTab /> entry points", () => {
  beforeEach(() => {
    skillMocks.skills = [];
    skillMocks.createScopes = [];
    skillMocks.importScopes = [];
    skillMocks.inspectScopes = [];
    skillMocks.credentialRefusal = null;
    skillMocks.mutateAsync.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders one Add skill button and no menu when both capabilities are open", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    renderTab();

    expect(screen.getByRole("button", { name: /Add skill/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /New skill/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import skill/ })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /^New ▾$/ })).toBeNull();
  });

  it("still renders Add skill for the import-only shape", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = [];
    skillMocks.importScopes = ["global"];
    renderTab();

    expect(screen.getByRole("button", { name: /Add skill/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /New skill/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import skill/ })).toBeNull();
  });

  it("renders no entry buttons and explains why when neither capability is open", () => {
    skillMocks.createScopes = [];
    skillMocks.importScopes = [];
    renderTab();

    expect(screen.queryByRole("button", { name: /Add skill/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New skill/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import skill/ })).toBeNull();
    expect(screen.getByText(/can.t add them/)).toBeDefined();
  });

  it("teaches the SKILL.md format and offers Add skill in the empty state", () => {
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    renderTab();

    expect(screen.getByText("No skills yet")).toBeDefined();
    const example = document.querySelector("pre");
    expect(example).not.toBeNull();
    expect(example?.textContent).toContain("description:");
    expect(screen.getAllByRole("button", { name: /Add skill/ }).length).toBe(2);
  });

  it("opens the composer import-first from the header Add skill button", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    skillMocks.inspectScopes = ["global"];
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^Add skill/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Paste a source");
    expect(screen.getByLabelText("Skill source")).toBeDefined();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen.getByRole("button", { name: "or write one from scratch" }),
    ).toBeDefined();
  });

  it("opens the composer on the write form when only create is advertised", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = [];
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^Add skill/ }));

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByLabelText("Name")).toBeDefined();
    expect(screen.queryByLabelText("Skill source")).toBeNull();
  });
});

describe("<ProviderSkillsTab /> composer on a host that takes no credentials", () => {
  const REFUSAL = "Sandboxes don't take sign-ins";
  const REFUSED_LINE = `${REFUSAL}: remove the sign-in from the source URL to import it here.`;

  beforeEach(() => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    skillMocks.inspectScopes = [];
    skillMocks.credentialRefusal = REFUSAL;
    skillMocks.mutateAsync.mockReset();
    skillMocks.mutateAsync.mockResolvedValue({
      kind: "skills",
      skills: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  function submitSource(source: string, submitName: RegExp): void {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^Add skill/ }));
    fireEvent.change(screen.getByLabelText("Skill source"), {
      target: { value: source },
    });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: submitName }));
  }

  it("refuses an import whose source is a URL with a sign-in, shows the line in the composer, and sends nothing", async () => {
    submitSource("https://ghp_x@github.com/o/skills", /Import skill/);

    expect(await screen.findByText(REFUSED_LINE)).toBeDefined();
    expect(skillMocks.mutateAsync).not.toHaveBeenCalled();
    // The dialog stays open on the source, so the person can fix it.
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("refuses an inspect of such a source the same way, when the host can inspect", async () => {
    skillMocks.inspectScopes = ["global"];

    submitSource("https://alice:token@github.com/o/skills", /Add skill/);

    expect(await screen.findByText(REFUSED_LINE)).toBeDefined();
    expect(skillMocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("still imports a plain source", async () => {
    submitSource("https://github.com/o/skills", /Import skill/);

    await waitFor(() =>
      expect(skillMocks.mutateAsync).toHaveBeenCalledTimes(1),
    );
    const sent: unknown = skillMocks.mutateAsync.mock.lastCall?.[0];
    expect(sent).toMatchObject({
      mutation: { action: "import", source: "https://github.com/o/skills" },
    });
    expect(screen.queryByText(REFUSED_LINE)).toBeNull();
  });

  it("control: on a host that takes credentials the sign-in source is imported", async () => {
    skillMocks.credentialRefusal = null;

    submitSource("https://ghp_x@github.com/o/skills", /Import skill/);

    await waitFor(() =>
      expect(skillMocks.mutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText(REFUSED_LINE)).toBeNull();
  });
});
