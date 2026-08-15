import type {
  ProviderNativeScope,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";

const skillMocks = vi.hoisted(() => ({
  skills: [] as ProviderSkill[],
  createScopes: [] as string[],
  importScopes: [] as string[],
  inspectScopes: [] as string[],
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
    mutateAsync: vi.fn(),
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
