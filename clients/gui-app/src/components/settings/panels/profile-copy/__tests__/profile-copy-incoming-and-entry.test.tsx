import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import { ProfileCopyIncomingSection } from "@/components/settings/panels/profile-copy/profile-copy-incoming-section";
import { ProfileCopyEntryButton } from "@/components/settings/panels/profile-copy/profile-copy-entry-button";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  DEST_HOST_ID,
  hostDirectoryEntry,
  incomingDraft,
  OPERATION_ID,
  recordedOutcome,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import {
  ambientProfile,
  hostOption,
  managedProfile,
} from "./profile-copy-component-fixtures";

const harness = vi.hoisted(
  (): {
    spine: HostClient<HostRpcRegistry> | null;
    hosts: HostScopeOption[];
    support: boolean | null;
  } => ({
    spine: null,
    hosts: [],
    support: true,
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => harness.support,
  useHostSupportsMethod: () => harness.support === true,
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: DEST_HOST_ID,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

function resetStores(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
  useProfileCopyOperationsStore.setState({ handles: [] });
}

describe("ProfileCopyIncomingSection", () => {
  beforeEach(() => {
    resetStores();
    harness.spine = null;
    harness.support = true;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
    ];
  });
  afterEach(() => {
    cleanup();
    resetStores();
    harness.spine = null;
  });

  it("is hidden unless incoming is supported on the destination", () => {
    harness.support = false;
    const queryClient = createAppQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ProfileCopyIncomingSection
          hostId={DEST_HOST_ID}
          providerId="claude-code"
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByLabelText("Incoming copies")).toBeNull();
  });

  it("filters by provider, shows the Q3 limit sentence, and retries from the source", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.incoming": () => ({
          drafts: [
            incomingDraft({
              metadata: {
                name: "Work",
                color: "#3b82f6",
                desiredEnabled: true,
                skillsPluginsShared: false,
              },
              outcome: recordedOutcome({
                state: "quarantined",
                reason: "writer-unconfirmed",
                replacementAttemptId: null,
              }),
            }),
            incomingDraft({
              outcome: recordedOutcome({
                state: "sign-in-required",
                attempt: {
                  sourceHostId: SOURCE_HOST_ID,
                  sourceProfileId: SOURCE_PROFILE_ID,
                  providerId: "codex",
                  operationId: OPERATION_ID,
                  attemptId: "55555555-5555-4555-8555-555555555555",
                  destinationHostId: DEST_HOST_ID,
                },
              }),
            }),
          ],
          nextCursor: "99999999-9999-4999-8999-999999999999",
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-in",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyIncomingSection
            hostId={DEST_HOST_ID}
            providerId="claude-code"
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Incoming copies")).toBeTruthy(),
    );
    expect(
      screen.getByText(
        /Copies waiting on this device. Copies that never reached it are listed only on the device that started them/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Showing the first/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Retry from Studio Mac/ }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Retry from Studio Mac/ }),
    );
    const handle = useProfileCopyOperationsStore
      .getState()
      .handles.find((entry) => entry.operationId === OPERATION_ID);
    expect(handle).toMatchObject({
      previewRevision: null,
      startAcknowledged: true,
      destinationHostIds: [DEST_HOST_ID],
      sourceHostId: SOURCE_HOST_ID,
    });
    expect(useProfileCopyFlowStore.getState().view).toEqual({
      kind: "operation",
      operationId: OPERATION_ID,
    });
  });
});

describe("ProfileCopyEntryButton", () => {
  beforeEach(() => {
    resetStores();
    harness.support = true;
    harness.hosts = [
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
      hostOption(DEST_HOST_ID, "Linux box", false),
    ];
  });
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("is hidden for non-v1 providers", () => {
    const queryClient = createAppQueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="cursor"
            profile={managedProfile(SOURCE_PROFILE_ID, "Work")}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /Copy to devices/ }),
    ).toBeNull();
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="cursor"
            profile={ambientProfile()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /Copy to devices/ }),
    ).toBeNull();
  });

  it("disables the Terminal account with a sign-in tooltip until it is signed in", () => {
    const signedIn = ambientProfile();
    const queryClient = createAppQueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={{
              ...signedIn,
              auth: { ...signedIn.auth, status: "unauthenticated" },
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const button = screen.getByRole("button", { name: /Copy to devices/ });
    expect(button).toHaveProperty("disabled", true);
    expect(tooltipTextNear(button)).toBe(
      "Sign in to the Terminal account on Studio Mac first.",
    );

    // Only a KNOWN sign-out blocks. `unknown` is what a disabled or not yet
    // probed Terminal account reports, and the host still reads its row.
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={{
              ...signedIn,
              auth: { ...signedIn.auth, status: "unknown" },
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Copy to devices/ }),
    ).toHaveProperty("disabled", false);

    // The sign-in reason leads the chain: it holds even while support is
    // unknown, and a managed profile that is signed out is not subject to it.
    harness.support = null;
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={{
              ...signedIn,
              auth: { ...signedIn.auth, status: "unauthenticated" },
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(
      tooltipTextNear(screen.getByRole("button", { name: /Copy to devices/ })),
    ).toBe("Sign in to the Terminal account on Studio Mac first.");

    harness.support = true;
    const managed = managedProfile(SOURCE_PROFILE_ID, "Work");
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={{
              ...managed,
              auth: { ...managed.auth, status: "unauthenticated" },
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Copy to devices/ }),
    ).toHaveProperty("disabled", false);
  });

  it("enables the signed-in Terminal account and says each device signs in itself", () => {
    const queryClient = createAppQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={ambientProfile()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const button = screen.getByRole("button", { name: /Copy to devices/ });
    expect(button).toHaveProperty("disabled", false);
    expect(tooltipTextNear(button)).toBe(
      "Copy this account's name and color to your other devices. Each device signs in itself.",
    );
  });

  it("still gates the signed-in Terminal account on support and another device", () => {
    const queryClient = createAppQueryClient();
    harness.support = false;
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={ambientProfile()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    let button = screen.getByRole("button", { name: /Copy to devices/ });
    expect(button).toHaveProperty("disabled", true);
    expect(tooltipTextNear(button)).toMatch(/Update Traycer on Studio Mac/);

    harness.support = true;
    harness.hosts = [hostOption(SOURCE_HOST_ID, "Studio Mac", true)];
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={ambientProfile()}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    button = screen.getByRole("button", { name: /Copy to devices/ });
    expect(button).toHaveProperty("disabled", true);
    expect(tooltipTextNear(button)).toMatch(/Add another device/);
  });

  it("disables with a tooltip while support is unknown, unsupported, or there is no other host", () => {
    const queryClient = createAppQueryClient();
    harness.support = null;
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={managedProfile(SOURCE_PROFILE_ID, "Work")}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    let button = screen.getByRole("button", { name: /Copy to devices/ });
    expect(button).toHaveProperty("disabled", true);
    expect(tooltipTextNear(button)).toMatch(
      /Checking what Studio Mac supports/,
    );

    harness.support = false;
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={managedProfile(SOURCE_PROFILE_ID, "Work")}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    button = screen.getByRole("button", { name: /Copy to devices/ });
    expect(button).toHaveProperty("disabled", true);
    expect(tooltipTextNear(button)).toMatch(/Update Traycer on Studio Mac/);

    harness.support = true;
    harness.hosts = [hostOption(SOURCE_HOST_ID, "Studio Mac", true)];
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyEntryButton
            hostId={SOURCE_HOST_ID}
            providerId="claude-code"
            profile={managedProfile(SOURCE_PROFILE_ID, "Work")}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    button = screen.getByRole("button", { name: /Copy to devices/ });
    expect(button).toHaveProperty("disabled", true);
    expect(tooltipTextNear(button)).toMatch(/Add another device/);
  });
});

describe("incoming drafts stay out of profile pickers", () => {
  it("is not imported by providers.list picker modules", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const guiSrc = join(here, "../../../../../");
    const pickerFiles = [
      "components/home/pickers/picker-profile-dropdown.tsx",
      "components/home/pickers/harness-model-picker.tsx",
    ];
    for (const relative of pickerFiles) {
      const source = readFileSync(join(guiSrc, relative), "utf8");
      expect(source).not.toMatch(/profile-copy-incoming/);
      expect(source).not.toMatch(/useProfileCopyIncomingQuery/);
      expect(source).toMatch(/useProvidersListForClient/);
    }
  });
});
