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
    isPending: false,
  }),
}));

// Not exercised in this suite (no row is ever opened), but statically
// imported by the tab through `ProviderSkillDetailDialog`, so it needs a
// well-shaped mock the same way `provider-skills-tab-detail.test.tsx` does.
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
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

// A non-empty list, so the header buttons are the only "New skill" / "Import
// skill" text on the page - the empty state renders its own copies of the
// same labels, which would make a bare name-based query ambiguous.
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
  });

  afterEach(() => {
    cleanup();
  });

  it("renders two real buttons and no menu when both capabilities are open", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    renderTab();

    expect(screen.getByRole("button", { name: /New skill/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Import skill/ })).toBeDefined();
    // Killing the menu-of-one is the whole point of this change: there must
    // be no dropdown standing in for either button.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /^New ▾$/ })).toBeNull();
  });

  it("renders exactly one button, Import skill, for the import-only shape every provider ships today", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = [];
    skillMocks.importScopes = ["global"];
    renderTab();

    expect(screen.getByRole("button", { name: /Import skill/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /New skill/ })).toBeNull();
  });

  it("renders no entry buttons and explains why when neither capability is open", () => {
    skillMocks.createScopes = [];
    skillMocks.importScopes = [];
    renderTab();

    expect(screen.queryByRole("button", { name: /New skill/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import skill/ })).toBeNull();
    // A short, stable substring rather than the full sentence: the exact
    // copy is free to be reworded without breaking this assertion.
    expect(screen.getByText(/can.t add them/)).toBeDefined();
  });

  it("teaches the SKILL.md format and offers both entry points in the empty state", () => {
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    renderTab();

    // Short, stable substring per the empty-state copy's history of getting
    // reworded, plus the annotated example (a `<pre>` block) rather than its
    // exact wording.
    expect(screen.getByText("No skills yet")).toBeDefined();
    const example = document.querySelector("pre");
    expect(example).not.toBeNull();
    expect(example?.textContent).toContain("description:");
    expect(
      screen.getByRole("button", { name: /Import from a repo or folder/ }),
    ).toBeDefined();
  });

  it("opens the composer on the write tab from the header New skill button", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^New skill/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Write a new one");
    expect(screen.getByLabelText("Name")).toBeDefined();
  });

  it("opens the composer on the import tab from the header Import skill button", () => {
    skillMocks.skills = [SOME_SKILL];
    skillMocks.createScopes = ["global"];
    skillMocks.importScopes = ["global"];
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: /^Import skill/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Import an existing one");
    expect(screen.getByLabelText("Git URL or folder path")).toBeDefined();
  });
});
