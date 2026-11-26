import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type { EnvironmentStatusResponseV14 } from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentHostBinding,
  EnvironmentListResponseV11,
} from "@traycer/protocol/host/environment/contracts";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { useHostSettingsDetailsSubject } from "@/components/settings/details/use-host-settings-details-subject";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import {
  HostOverviewSettingsCard,
  HostOverviewSettingsCardSlot,
} from "@/components/settings/panels/host-overview-settings-card";
import { hostSettingsRowModel } from "@/components/settings/panels/host-overview-settings-card-model";
import { PERSONAL_HOLD_TEXT } from "@/components/settings/panels/personal-hold-text";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { NO_RECEIPT } from "@/components/settings/panels/__tests__/ownership-receipt-fixture";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { enrichConfigurationList } from "@traycer/protocol/host/environment/configuration-list";
import { environmentReadLostAuthority } from "@/hooks/environment/environment-read-data";
import type { HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

interface DetailsBindingRead {
  enabled: boolean;
  answer: EnvironmentHostBinding | null;
  error: Error | null;
  held: Promise<EnvironmentHostBinding> | null;
}

interface TeamDirectoryRead {
  data: EnvironmentListResponseV11 | undefined;
  isError: boolean;
}

const detailsBinding = vi.hoisted((): DetailsBindingRead => ({
  enabled: false,
  answer: null,
  error: null,
  held: null,
}));
const teamDirectory = vi.hoisted((): TeamDirectoryRead => ({
  data: undefined,
  isError: false,
}));

interface FixtureRead<Data> {
  data: Data | null;
  isError: boolean;
  error: HostRpcError | null;
}

interface SlotReads {
  owner: HostOwnerPrincipal | null;
  isLocalMachine: boolean;
  status: FixtureRead<EnvironmentStatusResponseV14> & { supported: boolean };
  binding: { kind: "binding"; query: FixtureRead<EnvironmentHostBinding> };
  bindingOwnSettings: boolean;
  bindingFailed: boolean;
  bindingSupport: boolean | null;
}

const reads = vi.hoisted((): SlotReads => ({
  owner: null,
  isLocalMachine: false,
  status: {
    data: null,
    supported: true,
    isError: false,
    error: null,
  },
  binding: {
    kind: "binding",
    query: {
      data: null,
      isError: false,
      error: null,
    },
  },
  bindingOwnSettings: false,
  bindingFailed: false,
  bindingSupport: true,
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => reads.status,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => {
    if (reads.bindingFailed) {
      const bindingAuthorityLost = environmentReadLostAuthority(
        reads.binding.query.error,
      );
      return {
        kind: "failed",
        retry: () => undefined,
        lastBinding: bindingAuthorityLost ? null : reads.binding.query.data,
        bindingAuthorityLost,
      };
    }
    return reads.bindingOwnSettings ? { kind: "own_settings" } : reads.binding;
  },
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  readsHostBindingsFromPool: () => detailsBinding.enabled,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => reads.bindingSupport,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => client,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-a",
}));
vi.mock("@/components/settings/details/use-details-recovery", () => ({
  useDetailsRecovery: () => ({ recover: () => undefined, pending: false }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => teamDirectory,
}));
vi.mock("@/hooks/auth/use-team-computers", () => ({
  useTeamComputerClaim: () => ({
    reset: () => undefined,
    mutate: claimComputer,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/components/settings/team/claim-running-work", () => ({
  ClaimRunningWork: () => null,
}));

const claimComputer = vi.fn<(hostId: string) => void>();

const BINDING: EnvironmentHostBinding = {
  hostId: "host-a",
  environment: {
    environmentId: "personal",
    ownerKind: "user",
    ownerId: "user-a",
    roomId: "room-a",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

const TEAM_BINDING: EnvironmentHostBinding = {
  ...BINDING,
  environment: {
    environmentId: "team-settings",
    ownerKind: "organization",
    ownerId: "team-a",
    roomId: "room-team",
    label: "Design",
  },
  explicit: true,
};

const { client } = buildEnvironmentClient({
  hostId: "host-a",
  handlers: {
    "environment.binding.read": () => {
      if (detailsBinding.error !== null) throw detailsBinding.error;
      return detailsBinding.held ?? detailsBinding.answer ?? BINDING;
    },
    "environment.move.stopPreview": () => ({
      managed: [],
      needsChoice: [
        {
          row: {
            kind: "variable",
            key: "LOG_LEVEL",
            os: "any",
            label: "LOG_LEVEL",
            detail: null,
          },
          reason: "edited_here",
          origin: "changed_here",
          usedBy: [],
        },
      ],
      sheetDigest: null,
    }),
  },
});

function mount(usable: boolean, hostId: string | null): void {
  mountWatching(usable, hostId, () => undefined);
}

/** The slot mounted with an `onReturn`; the answer re-renders it with a new `usable`. */
function mountWatching(
  usable: boolean,
  hostId: string | null,
  onReturn: () => void,
): (usable: boolean) => void {
  const queryClient = new QueryClient();
  const slot = (isUsable: boolean): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <HostOverviewSettingsCardSlot
        client={client}
        hostId={hostId}
        hostName="A computer"
        usable={isUsable}
        owner={reads.owner}
        isLocalMachine={reads.isLocalMachine}
        receipt={NO_RECEIPT}
        onReturn={onReturn}
      />
      {detailsBinding.enabled &&
      hostId !== null &&
      reads.status.data !== null ? (
        <BindingReadMarker
          client={client}
          hostId={hostId}
          hostName="A computer"
          status={reads.status.data}
        />
      ) : null}
    </QueryClientProvider>
  );
  const view = render(slot(usable));
  return (next) => view.rerender(slot(next));
}

function committedElement(
  read: () => HTMLElement | null,
): Promise<HTMLElement> {
  const existing = read();
  if (existing !== null) return Promise.resolve(existing);
  const committed = Promise.withResolvers<HTMLElement>();
  const observer = new MutationObserver(() => {
    const element = read();
    if (element === null) return;
    observer.disconnect();
    committed.resolve(element);
  });
  observer.observe(document.body, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  onTestFinished(() => observer.disconnect());
  return committed.promise;
}

function BindingReadMarker(props: OverviewCardLineProps): ReactNode {
  const subject = useHostSettingsDetailsSubject(props);
  const binding = useHostQuery<HostRpcRegistry, "environment.binding.read">({
    client,
    method: "environment.binding.read",
    params: { hostId: "host-a" },
    cacheKeyIdentity: ["user-a"],
    options: { enabled: false },
  });
  return (
    <output
      data-testid="details-binding-read"
      data-code={binding.error?.code}
      data-subject={subject?.environmentId}
    >
      {binding.isError && binding.data !== undefined
        ? "failed with earlier answer"
        : binding.status}
    </output>
  );
}

function mountDetails(): { queryClient: QueryClient; rerender: () => void } {
  detailsBinding.enabled = true;
  recordNegotiatedHostManifest("host-a", {
    "environment.binding.read": { major: 1, minor: 0 },
    "environment.status": { major: 1, minor: 3 },
    "environment.move.stopPreview": { major: 1, minor: 0 },
    "environment.move.stop": { major: 1, minor: 0 },
  });
  const queryClient = createAppQueryClient();
  queryClient.setQueryDefaults(hostQueryKeys.base(), { retry: false });
  const status = environmentStatusFixture({
    planes: {
      records: "shared_unrecorded",
      broker: "shared_unrecorded",
      room: "shared_unrecorded",
    },
  });
  const line = { client, hostId: "host-a", hostName: "A computer", status };
  const details = (): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <OverviewCardDetailsLine {...line} currentStatus={null} />
      <BindingReadMarker {...line} />
    </QueryClientProvider>
  );
  const view = render(details());
  return { queryClient, rerender: () => view.rerender(details()) };
}

async function openDetailsStopAndChooseKeep(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByTestId("overview-stop-sharing"));
  const choice = await committedElement(() =>
    screen.queryByTestId("stop-sharing-choice-variable-LOG_LEVEL-keep_locally"),
  );
  fireEvent.click(choice);
  expect(choice.getAttribute("aria-pressed")).toBe("true");
  return choice;
}

function membershipRemoved(
  method: "environment.status" | "environment.binding.read",
): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message: "Team membership was removed",
    requestId: "reread",
    method,
    fatalDetails: null,
    doorRefusal: {
      code: "UNAUTHORIZED",
      reason: "Team membership was removed",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: false,
      doorReason: "membership_removed",
    },
  });
}

function forbiddenBinding(): HostRpcError {
  return new HostRpcError({
    code: "FORBIDDEN",
    message: "This computer's binding is unavailable to the viewer",
    requestId: "reread",
    method: "environment.binding.read",
    fatalDetails: null,
  });
}

function rereadBinding(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(
        query.queryKey,
        "environment.binding.read",
      ),
  });
}

function committedBindingState(state: string): Promise<HTMLElement> {
  return committedElement(() => {
    const marker = screen.getByTestId("details-binding-read");
    return marker.textContent === state ? marker : null;
  });
}

function committedBindingError(
  code: HostRpcError["code"],
): Promise<HTMLElement> {
  return committedElement(() => {
    const marker = screen.getByTestId("details-binding-read");
    return marker.getAttribute("data-code") === code ? marker : null;
  });
}

beforeEach(() => {
  useMoveSheetStore.setState({ target: null });
  reads.owner = null;
  reads.isLocalMachine = false;
  reads.status = { data: null, supported: true, isError: false, error: null };
  reads.binding = {
    kind: "binding",
    query: { data: null, isError: false, error: null },
  };
  reads.bindingOwnSettings = false;
  reads.bindingFailed = false;
  reads.bindingSupport = true;
  detailsBinding.enabled = false;
  detailsBinding.answer = null;
  detailsBinding.error = null;
  detailsBinding.held = null;
  teamDirectory.data = undefined;
  teamDirectory.isError = false;
  claimComputer.mockClear();
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("Settings actions during rereads", () => {
  it("keeps the Details Stop choice after a failed pooled binding reread", async () => {
    const { queryClient, rerender } = mountDetails();
    await committedBindingState("success");
    const choice = await openDetailsStopAndChooseKeep();
    const sheet = screen.getByTestId("stop-sharing-sheet");

    detailsBinding.error = new Error("Binding could not be read");
    const failed = committedBindingState("failed with earlier answer");
    await rereadBinding(queryClient);
    await failed;
    rerender();

    expect(screen.getByTestId("stop-sharing-sheet")).toBe(sheet);
    expect(choice.isConnected).toBe(true);
    expect(choice.getAttribute("aria-pressed")).toBe("true");
  });

  it("withdraws the Details Team subject when the pooled binding refuses access", async () => {
    detailsBinding.answer = TEAM_BINDING;
    const { queryClient, rerender } = mountDetails();
    await committedBindingState("success");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await committedElement(() => screen.queryByText("Couldn't load details."));
    const drawer = screen.getByRole("dialog", { name: "Settings" });

    detailsBinding.error = forbiddenBinding();
    const refused = committedBindingError("FORBIDDEN");
    await rereadBinding(queryClient);
    await refused;
    rerender();

    expect(screen.queryByText("Couldn't load details.")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(drawer);
  });

  it("does not restore a refused Team subject on another failed binding reread", async () => {
    detailsBinding.answer = TEAM_BINDING;
    const { queryClient, rerender } = mountDetails();
    const marker = await committedBindingState("success");
    expect(marker.getAttribute("data-subject")).toBe("team-settings");

    detailsBinding.error = forbiddenBinding();
    const refused = committedBindingError("FORBIDDEN");
    await rereadBinding(queryClient);
    await refused;
    rerender();
    expect(marker.hasAttribute("data-subject")).toBe(false);

    detailsBinding.error = new Error("Binding request lost its connection");
    const failed = committedBindingError("RPC_ERROR");
    await rereadBinding(queryClient);
    await failed;
    rerender();
    expect(marker.hasAttribute("data-subject")).toBe(false);

    detailsBinding.error = null;
    const answered = committedBindingState("success");
    await rereadBinding(queryClient);
    await answered;
    rerender();
    expect(marker.getAttribute("data-subject")).toBe("team-settings");
  });

  it("keeps the Details Stop choice when the first pooled binding arrives", async () => {
    const binding = Promise.withResolvers<EnvironmentHostBinding>();
    detailsBinding.held = binding.promise;
    const { rerender } = mountDetails();
    const choice = await openDetailsStopAndChooseKeep();
    const sheet = screen.getByTestId("stop-sharing-sheet");

    expect(screen.getByTestId("details-binding-read").textContent).toBe(
      "pending",
    );
    const answered = committedBindingState("success");
    binding.resolve(BINDING);
    await answered;
    rerender();

    expect(screen.getByTestId("stop-sharing-sheet")).toBe(sheet);
    expect(choice.isConnected).toBe(true);
    expect(choice.getAttribute("aria-pressed")).toBe("true");
  });

  function showClaim(): {
    readonly dialog: HTMLElement;
    readonly confirm: HTMLElement;
    readonly rerender: () => void;
  } {
    setClaimRole("admin");
    const queryClient = new QueryClient();
    const card = (): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <HostOverviewSettingsCard
          client={client}
          hostId="host-a"
          hostName="A computer"
          status={environmentStatusFixture({})}
          binding={TEAM_BINDING}
          owner={{ kind: "team", id: "team-a", name: "Design" }}
          isLocalMachine
          receipt={NO_RECEIPT}
        />
      </QueryClientProvider>
    );
    const view = render(card());
    const claim = "Claim this computer";
    fireEvent.click(screen.getByRole("button", { name: claim }));
    const dialog = screen.getByRole("dialog", { name: "Claim A computer?" });
    const confirm = within(dialog).getByRole("button", { name: claim });
    return { dialog, confirm, rerender: () => view.rerender(card()) };
  }

  function setClaimRole(role: "admin" | "viewer"): void {
    teamDirectory.data = {
      environments: [
        {
          ...TEAM_BINDING.environment,
          kind: "team",
          effectiveRole: role,
          hostCount: 1,
          providerHandle: "design",
        },
      ],
    };
  }

  it("keeps an open Claim dialog while a failed role reread blocks confirmation", () => {
    const { dialog, confirm, rerender } = showClaim();
    expect(confirm.hasAttribute("disabled")).toBe(false);

    teamDirectory.isError = true;
    rerender();

    expect(screen.getByRole("dialog", { name: "Claim A computer?" })).toBe(
      dialog,
    );
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(claimComputer).not.toHaveBeenCalled();

    teamDirectory.isError = false;
    rerender();

    expect(screen.getByRole("dialog", { name: "Claim A computer?" })).toBe(
      dialog,
    );
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    expect(claimComputer).toHaveBeenCalledExactlyOnceWith("host-a");
  });

  it("preserves open Claim when the directory could not read the team's role", async () => {
    const { dialog, confirm, rerender } = showClaim();

    teamDirectory.data = {
      environments: await enrichConfigurationList([TEAM_BINDING.environment], {
        hosts: () => Promise.resolve([]),
        team: () =>
          Promise.reject(new Error("Team membership could not be read")),
        rowFailed: () => undefined,
      }),
    };
    rerender();

    expect(screen.getByRole("dialog", { name: "Claim A computer?" })).toBe(
      dialog,
    );
    expect(confirm.hasAttribute("disabled")).toBe(true);

    setClaimRole("admin");
    rerender();

    expect(screen.getByRole("dialog", { name: "Claim A computer?" })).toBe(
      dialog,
    );
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("closes an open Claim when the directory answers with a Viewer role", () => {
    const { rerender } = showClaim();

    setClaimRole("viewer");
    rerender();

    expect(
      screen.queryByRole("dialog", { name: "Claim A computer?" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Claim this computer" }),
    ).toBeNull();

    setClaimRole("admin");
    rerender();

    expect(
      screen.getByRole("button", { name: "Claim this computer" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Claim A computer?" }),
    ).toBeNull();
  });
});

describe("<HostOverviewSettingsCardSlot />", () => {
  it.each([
    [
      "an unsupported status method",
      () => {
        reads.status.supported = false;
      },
    ],
    [
      "a failed status read",
      () => {
        reads.status.isError = true;
      },
    ],
    [
      "an unsupported binding method",
      () => {
        reads.bindingSupport = false;
      },
    ],
    [
      "a failed binding read",
      () => {
        reads.binding.query.isError = true;
      },
    ],
  ] as const)("hides the row for %s", (_name, configure) => {
    configure();
    mount(true, "host-a");
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.queryByText("Runs the team's settings.")).toBeNull();
  });

  it("hides the row when the host is unusable or unnamed", () => {
    mount(false, "host-a");
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
    cleanup();
    mount(true, null);
    expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
    expect(screen.queryByText("Runs the team's settings.")).toBeNull();
  });

  it("renders nothing for an unusable host instead of guessing Personal or a team", () => {
    mount(false, "host-a");

    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
    expect(screen.queryByText("Runs Personal")).toBeNull();
    expect(screen.queryByText("Runs the team's settings.")).toBeNull();
  });

  it("calls onReturn when the card shows again after the host was away, not when it first shows", () => {
    reads.status.data = environmentStatusFixture({});
    reads.binding.query.data = BINDING;
    const onReturn = vi.fn<() => void>();

    const setUsable = mountWatching(true, "host-a", onReturn);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(onReturn).not.toHaveBeenCalled();

    setUsable(false);
    expect(screen.queryByText("Personal")).toBeNull();
    expect(onReturn).not.toHaveBeenCalled();

    setUsable(true);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it.each(["status", "binding"])(
    "keeps the Overview card and its open Stop sheet after a failed %s reread",
    async (read) => {
      reads.status.data = environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "shared_unrecorded",
          room: "shared_unrecorded",
        },
      });
      reads.binding.query.data = BINDING;
      const rerender = mountWatching(true, "host-a", () => undefined);
      const row = screen.getByTestId("host-settings-source");
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Environment" }), {
        key: "ArrowDown",
      });
      const option = await committedElement(() =>
        screen.queryByRole("option", { name: /^A computer/ }),
      );
      fireEvent.click(option);
      const choiceId = "stop-sharing-choice-variable-LOG_LEVEL-keep_locally";
      const choice = await committedElement(() =>
        screen.queryByTestId(choiceId),
      );
      fireEvent.click(choice);
      expect(choice.getAttribute("aria-pressed")).toBe("true");
      const sheet = screen.getByTestId("stop-sharing-sheet");

      if (read === "status") {
        reads.status.isError = true;
        reads.bindingFailed = true;
      } else {
        reads.binding.query.isError = true;
      }
      rerender(true);

      expect(screen.getByTestId("stop-sharing-sheet")).toBe(sheet);
      expect(screen.getByTestId("host-settings-source")).toBe(row);
      expect(screen.getByTestId(choiceId).getAttribute("aria-pressed")).toBe(
        "true",
      );
    },
  );

  it.each(["status", "binding"] as const)(
    "withdraws the cached Team row after a definitive %s refusal",
    (read) => {
      reads.status.data = environmentStatusFixture({});
      reads.binding.query.data = TEAM_BINDING;
      const rerender = mountWatching(true, "host-a", () => undefined);
      expect(screen.getByText("Runs Design")).toBeTruthy();

      if (read === "status") {
        reads.status.isError = true;
        reads.status.error = membershipRemoved("environment.status");
        reads.bindingFailed = true;
      } else {
        reads.binding.query.isError = true;
        reads.binding.query.error = forbiddenBinding();
      }
      rerender(true);

      expect(screen.queryByText("Runs Design")).toBeNull();
      expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    },
  );

  it("needs an answered status for a different Team binding after a failed reread", () => {
    reads.status.data = environmentStatusFixture({});
    reads.binding.query.data = TEAM_BINDING;
    const rerender = mountWatching(true, "host-a", () => undefined);
    const original = screen.getByText("Runs Design");

    reads.status.isError = true;
    reads.bindingFailed = true;
    rerender(true);
    expect(screen.getByText("Runs Design")).toBe(original);

    reads.binding.query.data = {
      ...TEAM_BINDING,
      environment: {
        ...TEAM_BINDING.environment,
        environmentId: "team-operations-settings",
        ownerId: "team-operations",
        roomId: "room-operations",
        label: "Operations",
      },
    };
    rerender(true);
    expect(screen.queryByText("Environment")).toBeNull();

    reads.status.isError = false;
    reads.bindingFailed = false;
    rerender(true);
    expect(screen.getByText("Runs Operations")).toBeTruthy();
  });

  it("needs a fresh read when the Team owner arrives before the binding after Give", () => {
    reads.status.data = environmentStatusFixture({});
    reads.binding.query.data = BINDING;
    reads.owner = { kind: "user", id: "user-a" };
    const rerender = mountWatching(true, "host-a", () => undefined);
    const row = screen.getByTestId("host-settings-source");

    reads.status.isError = true;
    reads.bindingFailed = true;
    rerender(true);
    expect(screen.getByTestId("host-settings-source")).toBe(row);

    reads.owner = { kind: "team", id: "team-a", name: "Design" };
    rerender(true);
    expect(screen.queryByText("Environment")).toBeNull();

    reads.status.isError = false;
    reads.bindingFailed = false;
    reads.binding.query.data = TEAM_BINDING;
    rerender(true);
    expect(screen.getByText("This computer belongs to Design.")).toBeTruthy();
  });

  it("calls onReturn when a failed reread recovers with the card still mounted", () => {
    reads.status.data = environmentStatusFixture({});
    reads.binding.query.data = BINDING;
    const onReturn = vi.fn<() => void>();
    const setUsable = mountWatching(true, "host-a", onReturn);
    const row = screen.getByTestId("host-settings-source");

    reads.status.isError = true;
    reads.bindingFailed = true;
    setUsable(true);
    expect(screen.getByTestId("host-settings-source")).toBe(row);
    expect(onReturn).not.toHaveBeenCalled();

    reads.status.isError = false;
    reads.bindingFailed = false;
    setUsable(true);
    expect(screen.getByTestId("host-settings-source")).toBe(row);
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it("keeps a skeleton while either supported read is pending", () => {
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
    cleanup();
    reads.status.data = environmentStatusFixture({});
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
    cleanup();
    reads.binding.query.data = BINDING;
    reads.status.data = null;
    mount(true, "host-a");
    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
  });

  it("renders a Local computer's settings row without a binding read", () => {
    reads.status.data = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });

    mount(true, "host-a");

    expect(
      screen.getByText("Runs its own settings, not in Personal yet"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Environment" }));
    expect(screen.getByText("Personal")).toBeTruthy();
  });

  it("renders a Local row when status is supported and host binding is unsupported", () => {
    reads.status.data = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });
    reads.bindingOwnSettings = true;
    reads.bindingSupport = false;

    mount(true, "host-a");

    expect(
      screen.getByText("Runs its own settings, not in Personal yet"),
    ).toBeTruthy();
  });

  it("admits an answered Local row after a binding refusal without restoring Team Give", async () => {
    recordNegotiatedHostManifest("host-a", {
      "environment.move.plan": { major: 2, minor: 0 },
    });
    teamDirectory.data = {
      environments: [
        {
          ...TEAM_BINDING.environment,
          kind: "team",
          effectiveRole: "admin",
          hostCount: 0,
          providerHandle: "design",
        },
      ],
    };
    reads.owner = { kind: "user", id: "user-a" };
    reads.status.data = environmentStatusFixture({});
    reads.binding.query.data = BINDING;
    const rerender = mountWatching(true, "host-a", () => undefined);
    expect(screen.getByTestId("host-settings-source")).toBeTruthy();

    reads.binding.query.isError = true;
    reads.binding.query.error = forbiddenBinding();
    rerender(true);
    expect(screen.queryByText("Environment")).toBeNull();

    reads.status.data = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });
    reads.bindingOwnSettings = true;
    reads.binding.query.data = null;
    rerender(true);

    const row = screen.getByTestId("host-settings-source");
    expect(
      screen.getByText("Runs its own settings, not in Personal yet"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const drawer = screen.getByRole("dialog", { name: "Settings" });

    reads.status.isError = true;
    reads.bindingOwnSettings = false;
    reads.bindingFailed = true;
    rerender(true);
    expect(screen.getByTestId("host-settings-source")).toBe(row);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(drawer);

    reads.status.isError = false;
    reads.bindingOwnSettings = true;
    reads.bindingFailed = false;
    rerender(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Environment" }), {
      key: "ArrowDown",
    });
    await committedElement(() => screen.queryByRole("listbox"));
    expect(screen.queryByRole("option", { name: /^Design/ })).toBeNull();
    expect(screen.getByRole("option", { name: /^Personal/ })).toBeTruthy();
  });

  it.each([
    ["Local", null],
    [
      "Gate-unbound",
      { kind: "unreadable", personalBinding: null, unbound: true },
    ],
  ] as const)(
    "keeps the open Details Stop without exposing Team Claim during a failed %s read",
    async (_status, ownership) => {
      teamDirectory.data = {
        environments: [
          {
            ...TEAM_BINDING.environment,
            kind: "team",
            effectiveRole: "admin",
            hostCount: 0,
            providerHandle: "design",
          },
        ],
      };
      detailsBinding.enabled = true;
      detailsBinding.answer = TEAM_BINDING;
      recordNegotiatedHostManifest("host-a", {
        "environment.binding.read": { major: 1, minor: 0 },
        "environment.status": { major: 1, minor: 4 },
        "environment.move.stopPreview": { major: 1, minor: 0 },
        "environment.move.stop": { major: 1, minor: 0 },
      });
      reads.isLocalMachine = true;
      reads.owner = { kind: "team", id: "team-a", name: "Design" };
      reads.status.data = environmentStatusFixture({
        ownership,
        principal: null,
        planes: { records: "local", broker: "moved", room: "local" },
      });
      reads.binding.query.data = TEAM_BINDING;
      reads.bindingOwnSettings = true;
      const rerender = mountWatching(true, "host-a", () => undefined);
      const binding = await committedBindingState("success");
      expect(binding.getAttribute("data-subject")).toBe("team-settings");
      const row = screen.getByText("This computer belongs to Design.");
      expect(screen.queryByText("Claim this computer")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      const drawer = screen.getByRole("dialog", { name: "Settings" });
      fireEvent.click(screen.getByTestId("overview-stop-sharing"));
      const choice = await committedElement(() =>
        screen.queryByTestId(
          "stop-sharing-choice-variable-LOG_LEVEL-keep_locally",
        ),
      );
      fireEvent.click(choice);
      expect(choice.getAttribute("aria-pressed")).toBe("true");
      const sheet = screen.getByTestId("stop-sharing-sheet");

      reads.status.isError = true;
      reads.status.error = new HostRpcError({
        code: "RPC_ERROR",
        message: "Status could not be read",
        requestId: "status-read",
        method: "environment.status",
        fatalDetails: null,
      });
      reads.bindingOwnSettings = false;
      reads.bindingFailed = true;
      rerender(true);

      expect(screen.getByTestId("stop-sharing-sheet")).toBe(sheet);
      expect(drawer.isConnected).toBe(true);
      expect(row.isConnected).toBe(true);
      expect(choice.isConnected).toBe(true);
      expect(choice.getAttribute("aria-pressed")).toBe("true");
      expect(screen.queryByText("Claim this computer")).toBeNull();

      reads.status.isError = false;
      reads.status.error = null;
      reads.status.data = environmentStatusFixture({});
      reads.bindingFailed = false;
      rerender(true);
      expect(screen.getByText("Claim this computer")).toBeTruthy();
    },
  );

  it("keeps the Local row after a status reread fails without binding support", () => {
    reads.status.data = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });
    reads.bindingOwnSettings = true;
    reads.bindingSupport = false;
    const rerender = mountWatching(true, "host-a", () => undefined);
    const row = screen.getByTestId("host-settings-source");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const drawer = screen.getByRole("dialog", { name: "Settings" });

    reads.status.isError = true;
    reads.bindingOwnSettings = false;
    reads.bindingFailed = true;
    rerender(true);

    expect(screen.getByTestId("host-settings-source")).toBe(row);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(drawer);
  });

  it("keeps the row's skeleton while binding support is unknown", () => {
    reads.status.data = environmentStatusFixture({});
    reads.bindingSupport = null;

    mount(true, "host-a");

    expect(screen.getByRole("status", { name: "Reading" })).toBeTruthy();
  });
});

describe("a computer whose Personal settings are held", () => {
  const EXPLICIT_PERSONAL: EnvironmentHostBinding = {
    ...BINDING,
    explicit: true,
  };

  it.each([
    ["unconfirmed", "a cached Personal binding", EXPLICIT_PERSONAL],
    ["refused", "a cached Personal binding", EXPLICIT_PERSONAL],
    ["refused", "the implicit Personal fallback", BINDING],
  ] as const)(
    "answers %s over %s with its own line, never Runs Personal",
    (cause, _binding, binding) => {
      expect(
        hostSettingsRowModel(
          environmentStatusFixture({ personalHold: cause }),
          binding,
          "A computer",
        ),
      ).toMatchObject({
        kind: "personal_hold",
        cause,
        description: PERSONAL_HOLD_TEXT[cause],
      });
    },
  );

  it("answers Runs Personal over a Personal binding when nothing is held", () => {
    const model = hostSettingsRowModel(
      environmentStatusFixture({ personalHold: "none" }),
      EXPLICIT_PERSONAL,
      "A computer",
    );
    expect(model).toMatchObject({
      kind: "select",
      value: "personal",
      description: "Runs Personal",
    });
  });

  it.each([
    [
      "a cached Personal binding",
      () => {
        reads.binding.query.data = EXPLICIT_PERSONAL;
      },
    ],
    [
      "the implicit Personal fallback",
      () => {
        reads.binding.query.data = BINDING;
      },
    ],
    ["a pending binding read", () => undefined],
    [
      "an unknown binding method",
      () => {
        reads.bindingSupport = null;
      },
    ],
    [
      "a failed binding read",
      () => {
        reads.bindingFailed = true;
      },
    ],
    [
      "a failed binding read that kept its answer",
      () => {
        reads.binding.query.data = BINDING;
        reads.binding.query.isError = true;
      },
    ],
    [
      "an unsupported binding method",
      () => {
        reads.bindingSupport = false;
      },
    ],
  ] as const)(
    "keeps the live Personal source and Details while unconfirmed over %s",
    (_name, configure) => {
      reads.status.data = environmentStatusFixture({
        personalHold: "unconfirmed",
      });
      configure();

      mount(true, "host-a");

      expect(
        screen.getByTestId("host-settings-personal-hold").textContent,
      ).toBe(PERSONAL_HOLD_TEXT.unconfirmed);
      expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
      const control = screen.getByRole("combobox", { name: "Environment" });
      expect(within(control).getByText("Personal")).toBeTruthy();
      expect(control.hasAttribute("disabled")).toBe(false);
      expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    },
  );

  it("shows the refused line over a failed binding read", () => {
    reads.status.data = environmentStatusFixture({ personalHold: "refused" });
    reads.binding.query.isError = true;

    mount(true, "host-a");

    expect(screen.getByTestId("host-settings-personal-hold").textContent).toBe(
      PERSONAL_HOLD_TEXT.refused,
    );
    expect(screen.queryByText("Runs Personal")).toBeNull();
  });

  it.each([
    ["a cached Personal binding", EXPLICIT_PERSONAL],
    ["the implicit Personal fallback", BINDING],
  ] as const)(
    "shows only the computer's fixed source while refused over %s",
    (_name, binding) => {
      reads.status.data = environmentStatusFixture({ personalHold: "refused" });
      reads.binding.query.data = binding;

      mount(true, "host-a");

      const control = screen.getByRole("combobox", { name: "Environment" });
      expect(control.textContent).toBe("A computer");
      expect(control.hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
      fireEvent.pointerDown(control, { button: 0, ctrlKey: false });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(screen.queryByText("Personal")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Move to Personal" }),
      ).toBeNull();
      expect(screen.queryByText("Runs Personal")).toBeNull();
      expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
      expect(
        screen.getByTestId("host-settings-personal-hold").textContent,
      ).toBe(PERSONAL_HOLD_TEXT.refused);
    },
  );

  it.each(["unconfirmed", "refused"] as const)(
    "returns ordinary Personal after %s clears",
    (cause) => {
      reads.status.data = environmentStatusFixture({ personalHold: cause });
      reads.binding.query.data = BINDING;
      const rerender = mountWatching(true, "host-a", () => undefined);
      expect(
        screen.getByTestId("host-settings-personal-hold").textContent,
      ).toBe(PERSONAL_HOLD_TEXT[cause]);

      reads.status.data = environmentStatusFixture({ personalHold: "none" });
      rerender(true);

      const control = screen.getByRole("combobox", { name: "Environment" });
      const statusLine = screen.getByRole("button", {
        name: "Details",
      }).parentElement;
      if (statusLine === null) throw new Error("Details has no status line");
      expect(control.contains(statusLine)).toBe(false);
      expect(within(statusLine).getByText("Runs Personal")).toBeTruthy();
      expect(screen.queryByTestId("host-settings-personal-hold")).toBeNull();
      expect(
        screen
          .getByRole("combobox", { name: "Environment" })
          .hasAttribute("disabled"),
      ).toBe(false);
    },
  );

  it("keeps a failed binding read hidden when the host answers no hold", () => {
    reads.status.data = environmentStatusFixture({ personalHold: "none" });
    reads.binding.query.data = BINDING;
    reads.binding.query.isError = true;

    mount(true, "host-a");

    expect(screen.queryByText("Runs Personal")).toBeNull();
    expect(screen.queryByTestId("host-settings-personal-hold")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
  });

  it.each([
    [
      "a Personal hold",
      environmentStatusFixture({ personalHold: "unconfirmed" }),
    ],
    [
      "Gate recovery",
      environmentStatusFixture({
        ownership: {
          kind: "unreadable",
          personalBinding: null,
          unbound: false,
        },
      }),
    ],
  ] as const)(
    "waits for an answered status before showing %s over a failed binding read",
    (_label, status) => {
      reads.binding.query.data = BINDING;
      reads.binding.query.isError = true;
      reads.status.data = status;
      reads.status.isError = true;
      reads.status.error = new HostRpcError({
        code: "RPC_ERROR",
        message: "Status could not be read",
        requestId: "status-read",
        method: "environment.status",
        fatalDetails: null,
      });

      const rerender = mountWatching(true, "host-a", () => undefined);
      expect(screen.queryByText("Environment")).toBeNull();

      reads.status.isError = false;
      reads.status.error = null;
      rerender(true);
      expect(screen.getByText("Environment")).toBeTruthy();
    },
  );

  it("keeps the host's answered Personal hold after a binding refusal and withdraws it on a status refusal", () => {
    reads.status.data = environmentStatusFixture({ personalHold: "refused" });
    reads.binding.query.data = TEAM_BINDING;
    reads.binding.query.isError = true;
    reads.binding.query.error = forbiddenBinding();

    const rerender = mountWatching(true, "host-a", () => undefined);
    expect(screen.getByTestId("host-settings-personal-hold").textContent).toBe(
      PERSONAL_HOLD_TEXT.refused,
    );
    expect(screen.queryByText("Runs Design")).toBeNull();

    reads.status.isError = true;
    reads.status.error = membershipRemoved("environment.status");
    rerender(true);
    expect(screen.queryByText("Environment")).toBeNull();
  });

  it("keeps Team Give withdrawn during a held row's binding outage after refusal", async () => {
    recordNegotiatedHostManifest("host-a", {
      "environment.move.plan": { major: 2, minor: 0 },
    });
    teamDirectory.data = {
      environments: [
        {
          ...TEAM_BINDING.environment,
          kind: "team",
          effectiveRole: "admin",
          hostCount: 0,
          providerHandle: "design",
        },
      ],
    };
    reads.status.data = environmentStatusFixture({
      personalHold: "unconfirmed",
    });
    reads.binding.query.data = BINDING;
    reads.owner = { kind: "user", id: "user-a" };
    const rerender = mountWatching(true, "host-a", () => undefined);
    const row = screen.getByTestId("host-settings-personal-hold");

    reads.binding.query.isError = true;
    reads.binding.query.error = forbiddenBinding();
    rerender(true);
    expect(screen.getByTestId("host-settings-personal-hold")).toBe(row);

    reads.binding.query.data = null;
    reads.binding.query.error = new HostRpcError({
      code: "RPC_ERROR",
      message: "Binding could not be read",
      requestId: "binding-read",
      method: "environment.binding.read",
      fatalDetails: null,
    });
    rerender(true);
    const selector = () =>
      screen.getByRole("combobox", { name: "Environment" });
    fireEvent.keyDown(selector(), { key: "ArrowDown" });
    await committedElement(() => screen.queryByRole("listbox"));
    expect(screen.queryByRole("option", { name: /^Design/ })).toBeNull();
    expect(screen.getByTestId("host-settings-personal-hold")).toBe(row);

    reads.binding.query.isError = false;
    reads.binding.query.error = null;
    reads.binding.query.data = BINDING;
    rerender(true);
    fireEvent.keyDown(selector(), { key: "ArrowDown" });
    await committedElement(() => screen.queryByRole("listbox"));
    expect(screen.getByRole("option", { name: /^Design/ })).toBeTruthy();
  });

  it("keeps the observed Personal hold and its Details drawer after a recoverable status reread", () => {
    reads.status.data = environmentStatusFixture({
      personalHold: "unconfirmed",
    });
    reads.binding.query.isError = true;
    const rerender = mountWatching(true, "host-a", () => undefined);
    const row = screen.getByTestId("host-settings-personal-hold");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const drawer = screen.getByRole("dialog", { name: "Settings" });

    reads.status.isError = true;
    reads.bindingFailed = true;
    rerender(true);
    expect(screen.getByTestId("host-settings-personal-hold")).toBe(row);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(drawer);
  });
});

describe("a held row's Details and source actions", () => {
  it.each(["unconfirmed", "refused"] as const)(
    "opens Details with the same %s fact when the binding read failed",
    (cause) => {
      reads.status.data = environmentStatusFixture({ personalHold: cause });
      reads.binding.query.isError = true;
      mount(true, "host-a");

      fireEvent.click(screen.getByRole("button", { name: "Details" }));

      const drawer = screen.getByRole("dialog", { name: "Settings" });
      expect(drawer.textContent).toContain(PERSONAL_HOLD_TEXT[cause]);
      expect(drawer.textContent).not.toContain("Applied on 1 host");
      expect(
        screen.queryByRole("tab", { name: "Export diagnostics" }),
      ).toBeNull();
    },
  );

  it("does not open a Move when Personal is chosen again while unconfirmed", () => {
    reads.status.data = environmentStatusFixture({
      personalHold: "unconfirmed",
    });
    mount(true, "host-a");

    fireEvent.click(screen.getByRole("combobox", { name: "Environment" }));
    fireEvent.click(screen.getByRole("option", { name: /^Personal/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useMoveSheetStore.getState().target).toBeNull();
  });
});
