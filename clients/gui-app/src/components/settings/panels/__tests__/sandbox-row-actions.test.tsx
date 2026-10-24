import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";

const SURFACE = "landing:window-test";

const mutation = () => ({ mutate: vi.fn(), isPending: false });

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostKey: () => SURFACE,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => mutation(),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-patch-mutation", () => ({
  useSandboxPatch: () => mutation(),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-create-mutation", () => ({
  useSandboxCreate: () => mutation(),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({ useSandboxRepairGuestConfigurationOnHost: () => mutation() }),
);
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
// The confirm dialogs read the account; this suite never opens one.
vi.mock("@/components/hosts/sandbox-confirm-dialogs", () => ({
  SandboxDestroyDialog: () => null,
  SandboxIdleSettingsDialog: () => null,
  SandboxKeepDialog: () => null,
  SandboxRenameDialog: () => null,
  SandboxStopDialog: () => null,
  SandboxSuspendDialog: () => null,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: vi.fn() }),
}));

beforeEach(() => {
  useStagedSandboxStore.setState({ bySurface: {} });
  useSurfaceHostSelectionStore.setState({ selections: {} });
});

afterEach(cleanup);

describe("<SandboxRowActions />", () => {
  it("drops the landing composer's staged New sandbox when a row opens its own sandbox there", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: 10_080,
      },
      name: "",
      wakeString: null,
    });
    render(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          state: "awake",
          burst: false,
          guestConfigured: true,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open a tab" }),
    );

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      "host-build",
    );
  });

  it("stages a suspended sandbox to resume when a row opens it there, so the first send wakes it", async () => {
    render(
      <SandboxRowActions
        summary={sandboxSummaryFixture({
          id: "sbx-build",
          hostId: "host-build",
          displayName: "build-box",
          state: "suspended",
          burst: false,
          frozen: false,
        })}
        configuration={{ kind: "personal" }}
        unreachable={false}
        frozenNeedsOwnCredits={false}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^More actions for/ }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open a tab" }),
    );

    expect(readStagedSandbox(SURFACE)?.target).toEqual({
      kind: "existing",
      hostId: "host-build",
      sandboxId: "sbx-build",
      name: "build-box",
      configuration: { kind: "personal" },
      verb: "resume",
    });
    expect(useSurfaceHostSelectionStore.getState().selections[SURFACE]).toBe(
      "host-build",
    );
  });
});
