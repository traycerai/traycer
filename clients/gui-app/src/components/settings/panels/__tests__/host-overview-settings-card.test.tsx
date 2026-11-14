import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type {
  EnvironmentMoveStopPreviewResponseV11,
  EnvironmentMoveStopRequestV11,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  hostSettingsCardState,
  hostSettingsRowModel,
} from "@/components/settings/panels/host-overview-settings-card-model";
import { HostOverviewSettingsCard } from "@/components/settings/panels/host-overview-settings-card";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

// The drawer itself has a separate suite; keep its controls real so dated
// lines remain covered through the Details action.
vi.mock("@/components/settings/details/settings-details-button", () => ({
  SettingsDetailsButton: (props: { readonly controls: ReactNode }) => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Details
        </button>
        {open ? <div data-testid="details-dialog">{props.controls}</div> : null}
      </>
    );
  },
  SettingsDetailsDialog: (props: {
    readonly open: boolean;
    readonly initialTab: string;
    readonly controls: ReactNode;
  }) =>
    props.open ? (
      <div data-testid="details-dialog" data-tab={props.initialTab}>
        {props.controls}
      </div>
    ) : null,
}));
vi.mock(
  "@/components/settings/details/use-host-settings-details-subject",
  () => ({
    useHostSettingsDetailsSubject: () => ({
      environmentId: "env-a",
      kind: "host_settings",
      key: "old",
    }),
  }),
);
const memberships = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    ownerKind: "user" | "organization";
    ownerId: string;
    roomId: string;
    label: string;
  }>,
  isError: false,
  refetch: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: memberships.isError
      ? undefined
      : { environments: memberships.environments },
    isError: memberships.isError,
    refetch: memberships.refetch,
  }),
}));

const ACCEPTED_AT = Date.UTC(2026, 9, 20, 12);
const STOPPED_AT = Date.UTC(2026, 9, 21, 12);
const PERSONAL_BINDING: EnvironmentHostBinding = {
  hostId: "old",
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
  hostId: "old",
  environment: {
    environmentId: "team",
    ownerKind: "organization",
    ownerId: "org-a",
    roomId: "room-team",
    label: "Designers",
  },
  explicit: true,
  enrolledByUserId: "user-a",
  canUnbind: true,
};
const CURRENT_USER: HostOwnerPrincipal = { kind: "user", id: "user-a" };

interface CardRenderOptions {
  readonly binding: EnvironmentHostBinding;
  readonly retrySupported: boolean;
  readonly owner: HostOwnerPrincipal | null;
  readonly isLocalMachine: boolean;
}

/**
 * The card over a fake host that negotiated the redesign's methods, so the
 * dated lines, Stop using Personal and the retrospective run their real reads.
 */
function renderCard(
  status: EnvironmentStatusResponseV11,
  handlers: MockHandlerMap<HostRpcRegistry>,
): void {
  renderCardWithRetry(status, handlers, true);
}

function renderCardWithRetry(
  status: EnvironmentStatusResponseV11,
  handlers: MockHandlerMap<HostRpcRegistry>,
  retrySupported: boolean,
): void {
  renderCardWithBinding(status, handlers, {
    binding: PERSONAL_BINDING,
    retrySupported,
    owner: null,
    isLocalMachine: false,
  });
}

function renderCardWithBinding(
  status: EnvironmentStatusResponseV11,
  handlers: MockHandlerMap<HostRpcRegistry>,
  options: CardRenderOptions,
): void {
  const { client } = buildEnvironmentClient({ hostId: "old", handlers });
  recordNegotiatedHostManifest("old", {
    "environment.status": { major: 1, minor: 1 },
    "environment.review": { major: 1, minor: 1 },
    "environment.review.record": { major: 1, minor: 0 },
    "environment.move.stopPreview": { major: 1, minor: 0 },
    "environment.move.stop": { major: 1, minor: 0 },
    "environment.host.bind": { major: 1, minor: 1 },
    ...(options.retrySupported
      ? { "environment.setup.retry": { major: 1, minor: 0 } }
      : {}),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostOverviewSettingsCard
        client={client}
        hostId="old"
        hostName="Old laptop"
        status={status}
        binding={options.binding}
        owner={options.owner}
        isLocalMachine={options.isLocalMachine}
      />
    </QueryClientProvider>,
  );
}

function renderCardOnThisComputer(
  status: EnvironmentStatusResponseV11,
  handlers: MockHandlerMap<HostRpcRegistry>,
): void {
  renderCardWithBinding(status, handlers, {
    binding: PERSONAL_BINDING,
    retrySupported: true,
    owner: CURRENT_USER,
    isLocalMachine: true,
  });
}

beforeEach(() => {
  memberships.environments = [];
  memberships.isError = false;
  memberships.refetch.mockReset();
  memberships.refetch.mockResolvedValue(undefined);
  useMoveSheetStore.setState({ target: null });
  useRetrospectiveSheetStore.setState({ target: null, open: false });
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("<HostOverviewSettingsCard />", () => {
  it("shows the host name and its detail while awaiting, and selecting Personal opens the move sheet", async () => {
    renderCard(
      environmentStatusFixture({
        principal: null,
        planes: { records: "local", broker: "local", room: "local" },
        setup: { stage: "moving_settings", state: "awaiting_consent" },
      }),
      {},
    );

    const trigger = screen.getByRole("combobox", { name: "Environment" });
    expect(within(trigger).getByText("Old laptop")).toBeTruthy();
    expect(within(trigger).queryByText("Local")).toBeNull();
    expect(
      within(trigger).getByText("its own settings, not in Personal yet")
        .className,
    ).toContain("in-data-[slot=select-trigger]:hidden");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /^Personal/ }));
    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
  });

  it("does not label a team-owned computer Local when its planes are local", () => {
    renderCard(
      environmentStatusFixture({
        principal: { kind: "team", teamName: "Designers" },
        planes: { records: "local", broker: "local", room: "local" },
      }),
      {},
    );

    const trigger = screen.getByRole("combobox", { name: "Environment" });
    expect(trigger.textContent).toContain("Personal");
    expect(within(trigger).queryByText("Local")).toBeNull();
    expect(screen.getByTestId("host-settings-source").textContent).toContain(
      "Runs Personal",
    );
  });

  it("offers team use from a computer whose unresolved setup stopped", async () => {
    memberships.environments = [
      {
        environmentId: "team-a",
        ownerKind: "organization",
        ownerId: "org-a",
        roomId: "room-team",
        label: "Designers",
      },
    ];
    renderCardOnThisComputer(
      environmentStatusFixture({
        principal: null,
        planes: { records: "moved", broker: "moved", room: "moved" },
        setup: { stage: "applying", state: "stalled" },
      }),
      {},
    );

    const source = screen.getByTestId("host-settings-source");
    expect(source.textContent).toContain(
      "Setup stopped while applying your settings.",
    );
    expect(source.textContent).not.toContain("Runs Personal");
    expect(source.textContent).not.toContain("Runs its own settings");
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "local",
        hostId: "old",
        hostName: "Old laptop",
      });
    });

    const trigger = screen.getByRole("combobox", { name: "Environment" });
    expect(within(trigger).getByText("Old laptop")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const teamOption = await screen.findByRole("option", {
      name: /Designers/,
    });
    expect(teamOption.textContent).toContain("Use this computer for the team");
    fireEvent.click(teamOption);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Use Old laptop for Designers?")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm at this computer" }),
    ).toBeTruthy();
  });

  it("offers Retry when the team list read fails", async () => {
    memberships.isError = true;
    renderCardOnThisComputer(environmentStatusFixture({}), {});

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Couldn't load teams.");
    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));
    expect(memberships.refetch).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps a successful empty team list free of the read error", () => {
    memberships.environments = [];
    renderCardOnThisComputer(environmentStatusFixture({}), {});

    expect(screen.queryByText("Couldn't load teams.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the Environment row label and keeps Details beside its value", () => {
    renderCard(
      environmentStatusFixture({
        principal: null,
        planes: { records: "local", broker: "local", room: "local" },
        setup: { stage: "moving_settings", state: "awaiting_consent" },
      }),
      {},
    );

    expect(screen.getByText("Environment")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(screen.getByTestId("host-settings-source").textContent).toContain(
      "Runs its own settings, not in Personal yet",
    );
    expect(screen.getByTestId("host-settings-source").textContent).toContain(
      "Old laptop",
    );
  });

  it("shows N of M items applied while moving", () => {
    renderCard(
      environmentStatusFixture({
        // No consent while a move runs: the status serves the migration
        // MARKER's consent and the host writes that marker only once the upload
        // has finished (`traycer-host/.../migration/migrator.ts`, step 5). A
        // fixture that sets it here invites a reader to key on it.
        setup: { stage: "moving_settings", state: "running" },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "C", status: "pending" }),
        ],
        pendingUploads: [pendingUploadFixture({ kind: "variable", key: "D" })],
      }),
      {},
    );

    expect(
      screen
        .getByTestId("host-settings-card-progress")
        .textContent.replace(/\s+/g, " "),
    ).toBe(
      "Moving this computer's settings to Personal · 2 of 4 items applied",
    );
    const source = screen.getByRole("combobox", { name: "Environment" });
    expect(source.textContent).toBe("Personal");
    expect(source.hasAttribute("disabled")).toBe(true);
    const row = screen.getByTestId("host-settings-card-progress").parentElement;
    expect(row?.contains(screen.getByRole("button", { name: "Details" }))).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("overview-stop-sharing")).toBeTruthy();
  });

  it("shows no count while the move has registered no item", () => {
    renderCard(
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "running" },
      }),
      {},
    );

    expect(
      screen
        .getByTestId("host-settings-card-progress")
        .textContent.replace(/\s+/g, " "),
    ).toBe("Moving this computer's settings to Personal");
  });

  describe("when the move stopped", () => {
    const stoppedStatus = (state: "stalled" | "failed") =>
      environmentStatusFixture({
        setup: { stage: "moving_settings", state },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
          itemStatusFixture({ kind: "variable", key: "C", status: "pending" }),
        ],
        pendingUploads: [pendingUploadFixture({ kind: "variable", key: "D" })],
      });

    it("says it timed out when it stalled, with the items left", () => {
      renderCard(stoppedStatus("stalled"), {});

      expect(
        screen.getByTestId("host-settings-card-move-stopped").textContent,
      ).toBe("Moving stopped: it timed out. 3 items left.");
      const stopped = screen.getByRole("combobox", { name: "Environment" });
      expect(within(stopped).getByText("Old laptop")).toBeTruthy();
      expect(within(stopped).queryByText("Local")).toBeNull();
      expect(stopped.hasAttribute("disabled")).toBe(true);
      expect(screen.queryByTestId("host-settings-card-progress")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.getByTestId("overview-stop-sharing")).toBeTruthy();
    });

    it("says it couldn't finish when it failed", () => {
      renderCard(stoppedStatus("failed"), {});

      expect(
        screen.getByTestId("host-settings-card-move-stopped").textContent,
      ).toBe("Moving stopped: it couldn't finish. 3 items left.");
    });

    it("sends environment.setup.retry from Retry", async () => {
      const retries: unknown[] = [];
      renderCard(stoppedStatus("stalled"), {
        "environment.setup.retry": (request) => {
          retries.push(request);
          return { attemptId: "retry-1" };
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => expect(retries).toEqual([{}]));
    });

    it("offers no Retry on a host without environment.setup.retry", () => {
      renderCardWithRetry(stoppedStatus("failed"), {}, false);

      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Export diagnostics" }),
      ).toBeTruthy();
    });

    it("opens the Details drawer on Export diagnostics", () => {
      renderCard(stoppedStatus("failed"), {});
      expect(screen.queryByTestId("details-dialog")).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Export diagnostics" }),
      );

      expect(screen.getByTestId("details-dialog").dataset.tab).toBe("export");
    });
  });

  it("leaves a configuration's sandbox defaults out of the items moving", () => {
    expect(
      hostSettingsCardState(
        environmentStatusFixture({
          setup: { stage: "moving_settings", state: "running" },
          items: [
            itemStatusFixture({
              kind: "variable",
              key: "A",
              status: "applied",
            }),
            itemStatusFixture({
              kind: "sandbox_defaults",
              key: "sandbox",
              status: "pending",
            }),
          ],
        }),
      ),
    ).toEqual({ kind: "moving", applied: 1, total: 1 });
  });

  it("shows the accepted date in Details after setup is past the move", () => {
    renderCard(
      environmentStatusFixture({
        // Set HERE and nowhere above: the marker that carries this consent is
        // written when the move finishes, so a status past the move is the
        // only one that really has one.
        consent: { acceptedAt: ACCEPTED_AT, planHash: "h" },
        setup: { stage: "done", state: "done" },
      }),
      {},
    );

    expect(screen.getByTestId("host-settings-source").textContent).toContain(
      "Personal",
    );
    expect(screen.queryByText("Moved to Personal on 20 Oct")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("details-dialog").textContent).toContain(
      "Moved to Personal on 20 Oct",
    );
  });

  it("shows the local value while an upload is still pending", () => {
    renderCard(
      environmentStatusFixture({
        planes: { records: "moved", broker: "local", room: "moved" },
        pendingUploads: [pendingUploadFixture({ kind: "variable", key: "D" })],
        setup: null,
      }),
      {},
    );

    const trigger = screen.getByRole("combobox", { name: "Environment" });
    expect(within(trigger).getByText("Old laptop")).toBeTruthy();
    expect(within(trigger).queryByText("Local")).toBeNull();
    expect(
      within(trigger).getByText("its own settings, not in Personal yet"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("overview-stop-sharing")).toBeTruthy();
  });

  it("keeps Stop using Personal in Details for a legacy shared computer", () => {
    renderCard(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "shared_unrecorded",
          room: "shared_unrecorded",
        },
      }),
      {},
    );

    expect(screen.getByTestId("host-settings-source").textContent).toContain(
      "Personal",
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(
      screen.getByTestId("overview-shared-by-earlier-version").textContent,
    ).toContain("Shared by an earlier version");
    expect(screen.getByTestId("overview-stop-sharing").textContent).toBe(
      "Stop using Personal on this computer",
    );
    fireEvent.click(
      screen.getByTestId("overview-shared-by-earlier-version-details"),
    );
    expect(useRetrospectiveSheetStore.getState()).toMatchObject({
      target: { hostId: "old", hostName: "Old laptop" },
      open: true,
    });
  });

  it("shows the team's fixed Settings source in the disabled selector", () => {
    renderCardWithBinding(
      environmentStatusFixture({}),
      {},
      {
        binding: TEAM_BINDING,
        retrySupported: true,
        owner: null,
        isLocalMachine: false,
      },
    );

    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(selector.textContent).toBe("Designers");
    expect(selector.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Runs Designers")).toBeTruthy();
  });

  it("says Runs and the team name on a team-owned computer, and the selector value is that name", () => {
    renderCardWithBinding(
      environmentStatusFixture({}),
      {},
      {
        binding: TEAM_BINDING,
        retrySupported: true,
        owner: null,
        isLocalMachine: false,
      },
    );

    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(screen.getByText("Runs Designers")).toBeTruthy();
    expect(selector.textContent).toBe("Designers");
  });

  it("opens the Stop sharing review when the host's own settings are selected", async () => {
    renderCard(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "shared_unrecorded",
          room: "shared_unrecorded",
        },
      }),
      {
        "environment.move.stopPreview": () => ({
          managed: [],
          needsChoice: [],
        }),
      },
    );

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Environment" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: /^Old laptop/ }));

    expect(
      await screen.findByTestId("stop-sharing-managed-empty"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("stop-sharing-confirm").hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows the host name and its detail after every plane stopped using Personal", () => {
    renderCard(
      environmentStatusFixture({
        principal: null,
        planes: { records: "stopped", broker: "stopped", room: "stopped" },
        stoppedAt: STOPPED_AT,
      }),
      {},
    );

    const trigger = screen.getByRole("combobox", { name: "Environment" });
    expect(within(trigger).getByText("Old laptop")).toBeTruthy();
    expect(within(trigger).queryByText("Local")).toBeNull();
    expect(
      within(trigger).getByText("its own settings, not in Personal yet"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(
      screen.getByText("This computer stopped using Personal on 21 Oct"),
    ).toBeTruthy();
    expect(screen.queryByTestId("overview-stop-sharing")).toBeNull();
  });

  it("shows Personal for an unrecorded shared computer", () => {
    renderCard(environmentStatusFixture({ setup: null }), {});
    expect(screen.getByTestId("host-settings-source").textContent).toContain(
      "Personal",
    );
  });
});

describe("<HostOverviewSettingsCard /> after Stop using Personal", () => {
  it("counts the removals a stop still owes, and names each failed one with its failure", () => {
    renderCard(
      environmentStatusFixture({
        principal: null,
        reachability: "offline",
        planes: { records: "stopped", broker: "stopped", room: "stopped" },
        stoppedAt: STOPPED_AT,
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "pending" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
          itemStatusFixture({
            kind: "variable",
            key: "LOG_LEVEL",
            status: "failed",
            code: "permission_denied",
          }),
        ],
      }),
      {},
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(
      screen.getByTestId("overview-stop-cleanup-pending").textContent,
    ).toBe("2 items still being removed from this computer.");
    expect(
      screen
        .getAllByTestId("overview-stop-cleanup-failed")
        .map((line) => line.textContent),
    ).toEqual(["LOG_LEVEL couldn't be removed: permission denied."]);
  });

  it("explains Stop using Personal under its button", () => {
    renderCard(environmentStatusFixture({}), {});
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(screen.getByTestId("overview-stop-sharing").textContent).toBe(
      "Stop using Personal on this computer",
    );
    expect(screen.getByTestId("overview-stop-sharing-help").textContent).toBe(
      "Returns Old laptop to its own settings: it stops receiving Personal and reporting to it. Shows what Personal manages here first. Nothing in Personal is deleted.",
    );
  });

  it("refetches a changed preview on choices_missing, names the row that now needs a choice, and sends again only once it has one", async () => {
    const logLevel = {
      row: {
        kind: "variable",
        key: "LOG_LEVEL",
        os: "any" as const,
        label: "LOG_LEVEL",
        detail: null,
      },
      reason: "edited_here" as const,
      origin: "changed_here" as const,
      usedBy: [],
    };
    const editor = {
      row: {
        kind: "variable",
        key: "EDITOR",
        os: "any" as const,
        label: "EDITOR",
        detail: null,
      },
      reason: "depended_on" as const,
      origin: "depended_on" as const,
      usedBy: [],
    };
    const previews: EnvironmentMoveStopPreviewResponseV11[] = [
      { managed: [], needsChoice: [logLevel] },
      { managed: [], needsChoice: [logLevel, editor] },
    ];
    let previewReads = 0;
    const sent: EnvironmentMoveStopRequestV11[] = [];
    renderCard(environmentStatusFixture({}), {
      "environment.status": () => environmentStatusFixture({}),
      "environment.move.stopPreview": () => {
        const preview = previews[Math.min(previewReads, previews.length - 1)];
        previewReads += 1;
        return preview;
      },
      "environment.move.stop": (request) => {
        sent.push(request);
        return sent.length === 1
          ? { outcome: "choices_missing" }
          : { outcome: "stopped" };
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByTestId("overview-stop-sharing"));
    fireEvent.click(
      await screen.findByTestId(
        "stop-sharing-choice-variable-LOG_LEVEL-keep_locally",
      ),
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    const changed = await screen.findByTestId("stop-sharing-preview-changed");
    expect(changed.textContent).toContain("EDITOR");
    const confirm = screen.getByTestId("stop-sharing-confirm");
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(true);

    fireEvent.click(
      screen.getByTestId(
        "stop-sharing-choice-variable-EDITOR-remove_from_this_computer",
      ),
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({
      profileMode: null,
      profileSignIns: [],
      choices: [
        { kind: "variable", key: "LOG_LEVEL", choice: "keep_locally" },
        {
          kind: "variable",
          key: "EDITOR",
          choice: "remove_from_this_computer",
        },
      ],
    });
  });
});

describe("hostSettingsCardState", () => {
  it("reads moved off status.consent when setup has not started or has left the move", () => {
    const consent = { acceptedAt: ACCEPTED_AT, planHash: "h" };
    expect(
      hostSettingsCardState(environmentStatusFixture({ consent, setup: null })),
    ).toEqual({ kind: "moved", acceptedAt: ACCEPTED_AT });
    expect(hostSettingsCardState(environmentStatusFixture({}))).toEqual({
      kind: "other",
    });
  });
});

describe("hostSettingsRowModel", () => {
  it.each([
    [
      "local",
      { planes: { records: "local", broker: "local", room: "local" } },
      "local",
    ],
    [
      "partly moved",
      { planes: { records: "local", broker: "moved", room: "moved" } },
      "local",
    ],
    [
      "stopped on every plane",
      { planes: { records: "stopped", broker: "stopped", room: "stopped" } },
      "local",
    ],
    [
      "moving",
      { setup: { stage: "moving_settings", state: "running" } },
      "progress",
    ],
    [
      "move stopped",
      { setup: { stage: "moving_settings", state: "failed" } },
      "progress",
    ],
    [
      "moved",
      {
        consent: { acceptedAt: ACCEPTED_AT, planHash: "h" },
        setup: { stage: "done", state: "done" },
      },
      "personal",
    ],
    [
      "legacy shared",
      {
        planes: {
          records: "shared_unrecorded",
          broker: "shared_unrecorded",
          room: "shared_unrecorded",
        },
      },
      "personal",
    ],
  ] as const)("places %s settings", (_name, overrides, expected) => {
    const model = hostSettingsRowModel(
      environmentStatusFixture(overrides),
      PERSONAL_BINDING,
      "Old laptop",
    );
    if (expected === "progress") {
      expect(model.kind).toBe("progress");
      return;
    }
    expect(model.kind).toBe("select");
    if (model.kind !== "select") return;
    expect(model.value).toBe(expected);
    expect(model.options.map((option) => option.label)).not.toContain(
      "Designers",
    );
    expect(model.options.map((option) => option.label)).toContain("Personal");
    expect(model.options.map((option) => option.label)).toContain("Old laptop");
  });

  it("names Personal and this host, and hides the detail sentences in the closed trigger", () => {
    const model = hostSettingsRowModel(
      environmentStatusFixture({
        principal: null,
        planes: { records: "local", broker: "local", room: "local" },
      }),
      PERSONAL_BINDING,
      "Old laptop",
    );
    expect(model).toMatchObject({
      kind: "select",
      value: "local",
      description: "Runs its own settings, not in Personal yet",
      options: [
        {
          value: "personal",
          label: "Personal",
          detail: "Runs Personal",
        },
        {
          value: "local",
          label: "Old laptop",
          detail: "its own settings, not in Personal yet",
        },
      ],
    });
  });

  it("shows Personal rather than a Local selection for a team-owned computer with local planes", () => {
    expect(
      hostSettingsRowModel(
        environmentStatusFixture({
          principal: { kind: "team", teamName: "Designers" },
          planes: { records: "local", broker: "local", room: "local" },
        }),
        PERSONAL_BINDING,
        "Old laptop",
      ),
    ).toMatchObject({ kind: "select", value: "personal" });
  });

  it("uses the team's name as a fixed value", () => {
    expect(
      hostSettingsRowModel(
        environmentStatusFixture({}),
        TEAM_BINDING,
        "Old laptop",
      ),
    ).toEqual({
      kind: "team",
      environmentId: "team",
      label: "Designers",
      description: "Runs Designers",
    });
  });

  it("does not treat an implicit binding as team-owned, including a null principal", () => {
    const status = environmentStatusFixture({
      principal: null,
      planes: {
        records: "shared_unrecorded",
        broker: "shared_unrecorded",
        room: "shared_unrecorded",
      },
    });
    expect(
      hostSettingsRowModel(status, PERSONAL_BINDING, "Old laptop"),
    ).toMatchObject({
      kind: "select",
      value: "personal",
    });
  });

  it("keeps unresolved setup on this computer with its status as the detail", () => {
    expect(
      hostSettingsRowModel(
        environmentStatusFixture({
          principal: null,
          planes: { records: "moved", broker: "moved", room: "moved" },
          setup: { stage: "applying", state: "stalled" },
        }),
        PERSONAL_BINDING,
        "Old laptop",
      ),
    ).toEqual({
      kind: "select",
      value: "local",
      description: "Setup stopped while applying your settings.",
      options: [
        {
          value: "local",
          label: "Old laptop",
          detail: "Setup stopped while applying your settings.",
          action: "none",
        },
      ],
    });
  });

  it("reserves the row while status or binding is unread", () => {
    expect(
      hostSettingsRowModel(null, PERSONAL_BINDING, "Old laptop").kind,
    ).toBe("loading");
    expect(
      hostSettingsRowModel(environmentStatusFixture({}), null, "Old laptop")
        .kind,
    ).toBe("loading");
  });
});

describe("<HostOverviewSettingsCard /> follows the rail", () => {
  const localPick = {
    kind: "local" as const,
    hostId: "old",
    hostName: "Old laptop",
  };

  it("writes Personal, the host, the team, and a move, and leaves a stopped move that has no Local row", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: localPick });
    renderCard(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "shared_unrecorded",
          room: "shared_unrecorded",
        },
      }),
      {},
    );
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        PERSONAL_PICK,
      );
    });
    cleanup();

    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
    renderCard(
      environmentStatusFixture({
        principal: null,
        planes: { records: "local", broker: "local", room: "local" },
      }),
      {},
    );
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        localPick,
      );
    });
    cleanup();

    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
    renderCardWithBinding(
      environmentStatusFixture({}),
      {},
      {
        binding: TEAM_BINDING,
        retrySupported: true,
        owner: null,
        isLocalMachine: false,
      },
    );
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "team",
        environmentId: TEAM_BINDING.environment.environmentId,
      });
    });
    cleanup();

    useSettingsEnvironmentPickStore.setState({ pick: localPick });
    renderCard(
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "running" },
      }),
      {},
    );
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        PERSONAL_PICK,
      );
    });
    cleanup();

    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
    renderCard(
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "failed" },
      }),
      {},
    );
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
    });
  });
});
