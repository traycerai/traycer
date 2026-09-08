import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { AddProfileDialog } from "@/components/settings/panels/add-profile-dialog";

const mocks = vi.hoisted(() => ({
  supportsMethod: {} as Record<string, boolean>,
  schemaVersion: { major: 1, minor: 2 } as {
    major: number;
    minor: number;
  } | null,
  startLoginMutate: vi.fn(),
  createApiKeyProfileMutate: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    mocks.supportsMethod[method] ?? true,
  useHostMethodSchemaVersion: () => mocks.schemaVersion,
}));

vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => ({
  useProvidersStartLoginForClient: () => ({
    mutate: mocks.startLoginMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => ({
  // Never resolves - parks the flow in "waiting" indefinitely, which is
  // exactly the state these tests need to inspect (mode/toggle/userCode).
  useProvidersAwaitLoginForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => ({
  useProvidersCancelLoginForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-submit-login-code-mutation", () => ({
  useProvidersSubmitLoginCodeForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    data: undefined,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock("@/hooks/providers/use-providers-touch-login-mutation", () => ({
  useProvidersTouchLoginForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
}));

vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfileForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfileForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-create-api-key-profile-mutation",
  () => ({
    useProvidersCreateApiKeyProfileForClient: () => ({
      mutate: mocks.createApiKeyProfileMutate,
      isPending: false,
    }),
  }),
);

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

// Radix's Select needs a pointer-capable layout to open its listbox, which
// jsdom does not provide - same stand-in `providers-settings-panel.test.tsx`
// and `provider-model-provider-connect-dialog.test.tsx` use: every option
// always rendered, `onValueChange` forwarded so a test can pick one by
// clicking it, `data-state` tracking the current value.
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const ValueChangeContext = createContext<(value: string) => void>(() => {});
  const SelectedValueContext = createContext<string | undefined>(undefined);
  return {
    Select: (props: {
      readonly children: ReactNode;
      readonly value?: string;
      readonly onValueChange?: (value: string) => void;
    }) => (
      <ValueChangeContext.Provider value={props.onValueChange ?? (() => {})}>
        <SelectedValueContext.Provider value={props.value}>
          <div>{props.children}</div>
        </SelectedValueContext.Provider>
      </ValueChangeContext.Provider>
    ),
    SelectTrigger: (props: {
      readonly children: ReactNode;
      readonly id?: string;
    }) => (
      <button type="button" id={props.id}>
        {props.children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    SelectItem: (props: {
      readonly children: ReactNode;
      readonly value: string;
    }) => {
      const onValueChange = useContext(ValueChangeContext);
      const selectedValue = useContext(SelectedValueContext);
      return (
        <button
          type="button"
          data-value={props.value}
          data-state={props.value === selectedValue ? "checked" : "unchecked"}
          onClick={() => onValueChange(props.value)}
        >
          {props.children}
        </button>
      );
    },
  };
});

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [
      {
        kind: "bundled",
        path: "/opt/traycer/bin/claude",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
    },
    availabilityPending: false,
    profiles: [],
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    ...overrides,
  };
}

function managedProfile(overrides: Partial<ProviderProfile>): ProviderProfile {
  return {
    profileId: "profile-work",
    kind: "managed",
    authType: "apiKey",
    label: "Work",
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
    enabled: true,
    endpoint: null,
    config: null,
    ...overrides,
  };
}

function goToStep2(label: string): void {
  fireEvent.change(screen.getByLabelText("Profile name"), {
    target: { value: label },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mocks.supportsMethod = {};
  mocks.schemaVersion = { major: 1, minor: 2 };
  mocks.startLoginMutate.mockReset();
  mocks.createApiKeyProfileMutate.mockReset();
});

describe("AddProfileDialog - step 1", () => {
  it("'Start from' defaults to Default account and lists managed profiles + Empty", () => {
    render(
      <AddProfileDialog
        state={providerState({ profiles: [managedProfile({})] })}
        client={null}
        hostId="host-1"
        isSelectedHostLocal
        open
        onOpenChange={vi.fn()}
        onFailedAttempt={vi.fn()}
        onProfileCreated={vi.fn()}
      />,
    );

    const defaultOption = screen.getByRole("button", {
      name: "Default account",
    });
    expect(defaultOption.getAttribute("data-state")).toBe("checked");
    expect(
      screen.getByRole("button", { name: "Work" }).getAttribute("data-value"),
    ).toBe("profile:profile-work");
    expect(screen.getByRole("button", { name: "Empty" })).toBeDefined();
  });
});

describe("AddProfileDialog - API key tab", () => {
  it("a createApiKeyProfile rejection keeps the dialog open, shows the reason, and does not report success", async () => {
    mocks.createApiKeyProfileMutate.mockImplementation(
      (
        _vars: unknown,
        options: {
          onSuccess: (data: { ok: boolean; reason?: string }) => void;
        },
      ) => {
        options.onSuccess({ ok: false, reason: "401 Unauthorized" });
      },
    );
    const onOpenChange = vi.fn();
    const onProfileCreated = vi.fn();

    render(
      <AddProfileDialog
        state={providerState({})}
        client={null}
        hostId="host-1"
        isSelectedHostLocal
        open
        onOpenChange={onOpenChange}
        onFailedAttempt={vi.fn()}
        onProfileCreated={onProfileCreated}
      />,
    );

    goToStep2("New key profile");
    // Radix's `TabsTrigger` selects on `onMouseDown`, not `onClick` - a bare
    // `fireEvent.click()` never fires it (see `usage-metric-toggle.test.tsx`).
    await userEvent.click(screen.getByRole("tab", { name: "API key" }));
    fireEvent.change(screen.getByLabelText("Credential"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    expect(mocks.createApiKeyProfileMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("401 Unauthorized")).toBeDefined();
    expect(onProfileCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("AddProfileDialog - sign-in mode (D22)", () => {
  it("defaults to device mode on a remote host", () => {
    render(
      <AddProfileDialog
        state={providerState({})}
        client={null}
        hostId="host-1"
        isSelectedHostLocal={false}
        open
        onOpenChange={vi.fn()}
        onFailedAttempt={vi.fn()}
        onProfileCreated={vi.fn()}
      />,
    );

    goToStep2("Remote profile");
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    expect(mocks.startLoginMutate).toHaveBeenCalledTimes(1);
    const vars = mocks.startLoginMutate.mock.calls[0]?.[0] as { mode: string };
    expect(vars.mode).toBe("device");
  });

  it("offers 'Use a code instead' on a local host, switches the request to device, and renders a returned userCode", () => {
    mocks.startLoginMutate.mockImplementation(
      (
        vars: { mode: string },
        options: {
          onSuccess: (data: {
            started: boolean;
            profileId: string;
            url: string;
            userCode: string | null;
          }) => void;
        },
      ) => {
        options.onSuccess({
          started: true,
          profileId: "profile-new",
          url: "https://example.com/auth",
          userCode: vars.mode === "device" ? "DEV-456" : "ABC-123",
        });
      },
    );

    render(
      <AddProfileDialog
        state={providerState({})}
        client={null}
        hostId="host-1"
        isSelectedHostLocal
        open
        onOpenChange={vi.fn()}
        onFailedAttempt={vi.fn()}
        onProfileCreated={vi.fn()}
      />,
    );

    goToStep2("Local profile");
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    expect(mocks.startLoginMutate.mock.calls[0]?.[0]).toMatchObject({
      mode: "browser",
    });
    expect(screen.getByText("ABC-123")).toBeDefined();

    const useCodeButton = screen.getByRole("button", {
      name: "Use a code instead",
    });
    fireEvent.click(useCodeButton);

    expect(mocks.startLoginMutate).toHaveBeenCalledTimes(2);
    expect(mocks.startLoginMutate.mock.calls[1]?.[0]).toMatchObject({
      mode: "device",
    });
  });
});

describe("AddProfileDialog - Linked is unconditional (D02/D32)", () => {
  it("renders no ShareSkillsAndPluginsField checkbox anywhere in the dialog", () => {
    render(
      <AddProfileDialog
        state={providerState({})}
        client={null}
        hostId="host-1"
        isSelectedHostLocal
        open
        onOpenChange={vi.fn()}
        onFailedAttempt={vi.fn()}
        onProfileCreated={vi.fn()}
      />,
    );

    goToStep2("Any profile");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/share.*skills.*plugins/i)).toBeNull();
  });
});
