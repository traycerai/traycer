import { cleanup, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { providerProfile } from "./fallback-fixtures";
import { accounts, kit, resetKit } from "./routing-picker-kit";
import {
  FAILED_PROFILE,
  WORK_PROFILE,
  failedTurn,
  footerConfirm,
  listing,
  mount,
  open,
} from "./routing-picker-scene";

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return { useHostOptions: () => hostOptionsFixture({ hosts: [] }) };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (await import("./routing-picker-kit")).hostClientModule(),
);
vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: undefined,
    error: null,
    isPending: false,
  }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", async () =>
  (await import("./routing-picker-kit")).catalogModule(),
);
vi.mock("@/hooks/providers/use-providers-list-query", async () =>
  (await import("./routing-picker-kit")).providersListModule(),
);
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", async () =>
  (await import("./routing-picker-kit")).providersEnsurePackModule(),
);
vi.mock(
  "@/hooks/providers/use-providers-set-profile-enabled-mutation",
  async () =>
    (await import("./routing-picker-kit")).providersSetProfileEnabledModule(),
);
vi.mock("@/hooks/host/use-reactive-host-readiness", async () =>
  (await import("./routing-picker-kit")).reactiveHostReadinessModule(),
);
vi.mock("@/hooks/agent/use-host-reachability", async () =>
  (await import("./routing-picker-kit")).hostReachabilityModule(),
);
vi.mock("@/hooks/host/use-addressable-host-id", async () =>
  (await import("./routing-picker-kit")).addressableHostIdModule(),
);
vi.mock("@/hooks/host/use-host-directory-entry", async () =>
  (await import("./routing-picker-kit")).hostDirectoryEntryModule(),
);
vi.mock("@/hooks/host/use-host-directory-list-query", async () =>
  (await import("./routing-picker-kit")).hostDirectoryListModule(),
);
vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", async () =>
  (await import("./routing-picker-kit")).usageComparisonModule(),
);
vi.mock("@/components/chat/fallback/use-fallback-targets", async () =>
  (await import("./routing-picker-kit")).listTargetsModule(),
);
vi.mock("@/components/chat/fallback/use-fallback-choice-lease", async () =>
  (await import("./routing-picker-kit")).leaseModule(),
);
vi.mock("@/hooks/host/use-host-scoped-mutation", async () =>
  (await import("./routing-picker-kit")).hostScopedMutationModule(),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) =>
  (await import("./routing-picker-kit")).registryModule(
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >(),
  ),
);
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) =>
    (await import("./routing-picker-kit")).identityModule(
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >(),
    ),
);
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) =>
  (await import("./routing-picker-kit")).botMutationsModule(
    await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>(),
  ),
);
vi.mock("@/stores/tabs/use-system-tab-modal", async () =>
  (await import("./routing-picker-kit")).systemTabModalModule(),
);
vi.mock("react-virtuoso", async () =>
  (await import("./routing-picker-kit")).virtuosoModule(),
);
vi.mock("sonner", async () => ({
  toast: (await import("./routing-picker-kit")).kit.toast,
}));

const created = vi.hoisted(
  () =>
    [] as Array<{
      readonly options: unknown;
      readonly setOnSettingsChange: Mock;
      readonly store: ComposerToolbarStore;
    }>,
);

vi.mock("@/stores/composer/composer-toolbar-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/composer/composer-toolbar-store")
    >();
  return {
    ...actual,
    createComposerToolbarStore: (
      options: Parameters<typeof actual.createComposerToolbarStore>[0],
    ) => {
      const store = actual.createComposerToolbarStore(options);
      const spy = vi.fn(store.getState().setOnSettingsChange);
      store.setState({ setOnSettingsChange: spy });
      created.push({ options, setOnSettingsChange: spy, store });
      return store;
    },
  };
});

function aliased(
  profileId: string,
  label: string,
  aliases: readonly string[],
): ProviderProfile {
  return {
    ...providerProfile({
      profileId,
      kind: "managed",
      label,
      authenticated: true,
    }),
    aliases: [...aliases],
  };
}

function profileTrigger(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", {
    name: /^Claude profile: /,
  });
}

describe("failed-turn picker alias pin", () => {
  beforeEach(() => {
    resetKit();
    created.length = 0;
    kit.providers = [
      accounts(
        [
          aliased("side01-profile", "Side", []),
          aliased(WORK_PROFILE, "Work", [FAILED_PROFILE]),
        ],
        "claude-code",
      ),
    ];
    kit.listData = listing({ recommendedWork: false });
    useComposerHarnessMemoryStore.getState().resetForTests();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });

  afterEach(() => {
    resetKit();
    cleanup();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  it("picking the canonical row of an alias is not a switch", async () => {
    mount(failedTurn(["switch"]));
    await open();
    expect(profileTrigger().getAttribute("aria-label")).toBe(
      "Claude profile: Work",
    );
    expect(footerConfirm().disabled).toBe(true);

    await userEvent.click(profileTrigger());
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Work" }),
    );
    expect(footerConfirm().disabled).toBe(true);

    await userEvent.click(profileTrigger());
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Side" }),
    );
    expect(footerConfirm().disabled).toBe(false);
  });
});
