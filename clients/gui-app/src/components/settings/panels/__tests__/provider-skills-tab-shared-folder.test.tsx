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
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";

const shared = vi.hoisted(() => ({
  hostRunsEnvironments: true,
  skills: [] as ProviderSkill[],
  scope: "global" as ProviderNativeScope,
  promotions: [] as Array<{ scope: string; name: string }>,
  importDialogs: [] as string[],
}));

vi.mock("../use-skill-environment-route", () => ({
  useSkillEnvironmentRoute: () => ({
    hostRunsEnvironments: shared.hostRunsEnvironments,
    available: true,
    hostClient: null,
    writing: false,
    write: () => Promise.resolve(null),
  }),
}));
vi.mock("@/components/settings/panels/use-provider-native-scope", async () => {
  const { GLOBAL_ONLY_NATIVE_SCOPE } =
    await import("@/components/settings/panels/__tests__/provider-native-scope-test-mocks");
  return {
    useProviderNativeScope: () => ({
      ...GLOBAL_ONLY_NATIVE_SCOPE,
      effectiveScope: shared.scope,
    }),
  };
});
vi.mock("@/hooks/providers/use-providers-skills-list-query", () => ({
  useProvidersSkillsList: () => ({
    data: { skills: shared.skills },
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-providers-skills-mutate-mutation", () => ({
  useProvidersSkillsMutate: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: {
      content: "---\nname: hand-placed\n---\n\nbody\n",
      truncated: false,
      error: null,
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 3 }),
}));
vi.mock("@/hooks/providers/use-providers-promote-to-personal-mutation", () => ({
  useProvidersPromoteToPersonal: () => ({
    isPending: false,
    mutate: (request: { mutation: { scope: string; name: string } }) => {
      shared.promotions.push({
        scope: request.mutation.scope,
        name: request.mutation.name,
      });
    },
  }),
}));
vi.mock(
  "@/components/settings/environment/configuration-source-boundary",
  () => ({
    ConfigurationSourceBoundary: (props: { children: React.ReactNode }) =>
      props.children,
  }),
);
vi.mock(
  "@/components/settings/environment/environment-skill-import-dialog",
  () => ({
    EnvironmentSkillImportDialog: (props: { initialSource: string }) => {
      shared.importDialogs.push(props.initialSource);
      return <div data-testid="environment-import" />;
    },
  }),
);

const HAND_PLACED: ProviderSkill = {
  name: "hand-placed",
  description: null,
  path: "/Users/dev/.agents/skills/hand-placed",
  source: "shared",
  origin: "Imported from owner/repo",
};
const OWN: ProviderSkill = {
  name: "own",
  description: null,
  path: "/Users/dev/.cursor/skills/own",
  source: "provider",
  origin: null,
};

function state(): ProviderCliState {
  return {
    providerId: "cursor",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["skills"],
      mcp: null,
      plugins: null,
      skills: {
        actionScopes: {
          list: ["global", "project"],
          add: ["global", "project"],
          create: ["global", "project"],
          import: ["global", "project"],
          remove: ["global", "project"],
          inspect: ["global", "project"],
          edit: ["global", "project"],
          update: ["global", "project"],
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

beforeEach(() => {
  shared.hostRunsEnvironments = true;
  shared.skills = [HAND_PLACED, OWN];
  shared.scope = "global";
  shared.promotions = [];
  shared.importDialogs = [];
});

afterEach(cleanup);

function openRow(name: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

describe("a shared folder's skill on a host that runs environments", () => {
  it("keeps the Shared badge and promotes through the existing flow, at global scope", () => {
    render(<ProviderSkillsTab state={state()} />);

    expect(
      screen.getByRole("button", { name: "Open hand-placed (Shared)" }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Promote to the environment" }),
    );

    expect(shared.promotions).toEqual([
      { scope: "global", name: "hand-placed" },
    ]);
  });

  it("offers no promote at project scope, which the host refuses", () => {
    shared.scope = "project";

    render(<ProviderSkillsTab state={state()} />);

    expect(
      screen.queryByRole("button", { name: "Promote to the environment" }),
    ).toBeNull();
  });

  it("offers no edit, update or remove, and says what to do instead", () => {
    render(<ProviderSkillsTab state={state()} />);

    const dialog = within(openRow("Open hand-placed (Shared)"));

    expect(dialog.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      dialog.queryByRole("button", { name: /Update from source/ }),
    ).toBeNull();
    expect(dialog.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(dialog.getByText(/Traycer reads this folder/)).toBeDefined();
  });

  it("leaves a provider's own skill its edit and remove, and no promote", () => {
    shared.skills = [OWN];

    render(<ProviderSkillsTab state={state()} />);

    expect(
      screen.queryByRole("button", { name: "Promote to the environment" }),
    ).toBeNull();
    const dialog = within(openRow("Open own (Cursor only)"));
    expect(dialog.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(dialog.getByRole("button", { name: "Remove" })).toBeDefined();
  });

  it("carries an import's source from the composer to the environment's import", () => {
    render(<ProviderSkillsTab state={state()} />);

    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.click(screen.getByLabelText(/This environment/));
    fireEvent.change(screen.getByLabelText("Skill source"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add skill",
      }),
    );

    expect(screen.getByTestId("environment-import")).toBeDefined();
    expect(shared.importDialogs).toContain("owner/repo");
    expect(screen.queryByLabelText(/This environment/)).toBeNull();
  });
});

describe("a shared folder's skill on a host from before environments", () => {
  beforeEach(() => {
    shared.hostRunsEnvironments = false;
  });

  it("keeps its edit and remove, and the composer offers today's Every provider", () => {
    render(<ProviderSkillsTab state={state()} />);

    expect(
      screen.queryByRole("button", { name: "Promote to the environment" }),
    ).toBeNull();
    const dialog = within(openRow("Open hand-placed (Shared)"));
    expect(dialog.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(dialog.getByRole("button", { name: "Remove" })).toBeDefined();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));

    expect(screen.getByRole("radio", { name: /Every provider/ })).toBeDefined();
    expect(screen.getByRole("radio", { name: /Cursor only/ })).toBeDefined();
    expect(screen.queryByLabelText(/This environment/)).toBeNull();
  });
});
