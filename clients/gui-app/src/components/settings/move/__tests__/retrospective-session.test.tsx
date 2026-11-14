import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  applyReviewChoice,
  readReviewHolds,
  type ReviewChoiceOutcome,
  type ReviewHeldEntry,
} from "@traycer-clients/shared/environment/environment-review";
import type {
  EnvironmentReviewEntryV12,
  EnvironmentReviewResponseV12,
  EnvironmentStatusResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import { reviewEntryFixture } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import {
  mountTeamPage,
  personalPoolSource,
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

vi.mock(
  "@traycer-clients/shared/environment/environment-review",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@traycer-clients/shared/environment/environment-review")
      >();
    return {
      ...original,
      readReviewHolds: vi.fn(original.readReviewHolds),
      applyReviewChoice: vi.fn(original.applyReviewChoice),
    };
  },
);

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => requireTeamEnvironmentAuthnBinding(),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-1",
}));

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: vi.fn(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useMoveSheetStore.setState({ target: null });
  vi.mocked(readReviewHolds).mockReset();
  vi.mocked(applyReviewChoice).mockReset();
});

const COMMAND_DETAIL_TAIL =
  "Once approved, it runs on every computer and sandbox running Personal.";

function reviewOf(
  entries: readonly EnvironmentReviewEntryV12[],
): EnvironmentReviewResponseV12 {
  return {
    entries: [...entries],
    shownAt: null,
    acknowledgedAt: null,
    evidence: { version: "1.5.2", at: Date.UTC(2026, 9, 14, 12) },
  };
}

/** A review entry as a `@1.2` host sends it, naming what a held executable runs. */
function entryOf(overrides: Partial<ReviewHeldEntry>): ReviewHeldEntry {
  return {
    ...reviewEntryFixture({}),
    command: null,
    event: null,
    description: null,
    harness: null,
    value: null,
    op: "put",
    heldRevision: 1,
    liveRevision: 1,
    ...overrides,
  };
}

function renderSession(
  status: EnvironmentStatusResponseV12,
  entries: readonly ReviewHeldEntry[],
  recorded: string[],
): void {
  renderSessionWith(status, entries, recorded, {
    onOpenChange: vi.fn(),
  });
}

function renderSessionWith(
  status: EnvironmentStatusResponseV12,
  entries: readonly ReviewHeldEntry[],
  recorded: string[],
  session: {
    readonly onOpenChange: (open: boolean) => void;
    readonly applyOutcome?: ReviewChoiceOutcome;
    readonly readFailures?: number;
  },
): { readonly rerender: (open: boolean) => void } {
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => status,
    "environment.list": () => ({
      environments: [
        {
          environmentId: "env-personal",
          ownerKind: "user",
          ownerId: "user-1",
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner",
          kind: "personal",
          hostCount: 1,
          providerHandle: null,
        },
      ],
    }),
    "environment.review": () => reviewOf([]),
    "environment.review.record": (request) => {
      recorded.push(request.event);
      return { outcome: "recorded" };
    },
  };
  const harness = mountTeamPage(personalPoolSource(), handlers);
  const client = requireTeamHostClient();
  let remainingReadFailures = session.readFailures ?? 0;
  vi.mocked(readReviewHolds).mockImplementation(() => {
    if (remainingReadFailures > 0) {
      remainingReadFailures -= 1;
      return Promise.reject(new Error("authn temporarily unavailable"));
    }
    return Promise.resolve(entries);
  });
  vi.mocked(applyReviewChoice).mockResolvedValue(
    session.applyOutcome ?? { outcome: "applied" },
  );
  recordNegotiatedHostManifest(mockLocalHostEntry.hostId, {
    "environment.status": { major: 1, minor: 1 },
    "environment.review": { major: 1, minor: 2 },
    "environment.review.record": { major: 1, minor: 0 },
    "environment.list": { major: 1, minor: 1 },
  });
  harness.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
    mutations: { retry: false },
  });
  const ui = (open: boolean) => (
    <harness.Wrapper>
      <RetrospectiveSession
        client={client}
        reviewHostId={mockLocalHostEntry.hostId}
        stopClient={client}
        stopHostId={mockLocalHostEntry.hostId}
        hostName="Old laptop"
        open={open}
        held={null}
        onOpenChange={session.onOpenChange}
      />
    </harness.Wrapper>
  );
  const view = render(ui(true));
  return { rerender: (open) => view.rerender(ui(open)) };
}

function heldChoiceEntries(): readonly ReviewHeldEntry[] {
  return [
    entryOf({
      entryId: "hook-1",
      reason: "executable_entry",
      kind: "hook",
      key: "notify",
      command: "notify.sh",
      event: "stop",
    }),
    entryOf({
      entryId: "hook-2",
      reason: "executable_entry",
      kind: "hook",
      key: "format",
      command: "format.sh",
      event: "save",
    }),
  ];
}

describe("<RetrospectiveSession /> Stop using Personal", () => {
  it("keeps the local settings list but hides Move to Personal for a team-owned computer", async () => {
    renderSession(
      environmentStatusFixture({
        principal: { kind: "team", teamName: "Designers" },
        planes: { records: "local", broker: "local", room: "local" },
      }),
      [],
      [],
    );

    expect(await screen.findByTestId("retrospective-still-local")).toBeTruthy();
    expect(screen.queryByTestId("retrospective-move-to-personal")).toBeNull();
  });

  it.each([null, { kind: "personal" } as const])(
    "offers Move to Personal for a non-team principal",
    async (principal) => {
      renderSession(
        environmentStatusFixture({
          principal,
          planes: { records: "local", broker: "local", room: "local" },
        }),
        [],
        [],
      );

      fireEvent.click(
        await screen.findByTestId("retrospective-move-to-personal"),
      );
      expect(useMoveSheetStore.getState().target).toEqual({
        hostId: mockLocalHostEntry.hostId,
        hostName: "Old laptop",
      });
    },
  );

  it("offers it while a plane is still shared by an earlier version", async () => {
    renderSession(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "local",
          room: "local",
        },
      }),
      [],
      [],
    );

    expect(
      (await screen.findByTestId("retrospective-stop-sharing")).textContent,
    ).toBe("Stop using Personal on this computer");
  });

  it("hides it once every plane has stopped, and keeps Got it", async () => {
    const recorded: string[] = [];
    renderSession(
      environmentStatusFixture({
        planes: { records: "stopped", broker: "stopped", room: "stopped" },
        stoppedAt: Date.UTC(2026, 9, 21, 12),
      }),
      [],
      recorded,
    );

    // The sheet records `shown` once the review and the planes have loaded.
    await waitFor(() => expect(recorded).toEqual(["shown"]));
    expect(screen.queryByTestId("retrospective-stop-sharing")).toBeNull();
    expect(screen.getByTestId("retrospective-got-it")).toBeTruthy();
  });
});

describe("<RetrospectiveSession /> commands on hold", () => {
  const SHARED = environmentStatusFixture({
    planes: { records: "shared_unrecorded", broker: "local", room: "local" },
  });

  it("lists held commands under Commands on hold, each naming what it runs and who gets it", async () => {
    renderSession(
      SHARED,
      [
        entryOf({
          entryId: "mcp-1",
          reason: "executable_entry",
          kind: "mcp_server",
          key: "github",
          command: "npx -y @acme/github-mcp --readonly",
        }),
        entryOf({
          entryId: "hook-1",
          reason: "executable_entry",
          kind: "hook",
          key: "notify",
          command: "notify.sh",
          event: "stop",
        }),
        entryOf({
          entryId: "mcp-2",
          reason: "executable_entry",
          kind: "mcp_server",
          key: "legacy",
        }),
      ],
      [],
    );

    const commands = await screen.findByTestId("retrospective-held-commands");
    expect(within(commands).getByText("Commands on hold")).toBeTruthy();
    const rowText = (id: string): string | null =>
      within(commands).getByTestId(`retrospective-held-${id}`).textContent;
    expect(rowText("mcp-1")).toContain(
      `github (MCP server) runs npx -y @acme/github-mcp --readonly. ${COMMAND_DETAIL_TAIL}`,
    );
    expect(rowText("hook-1")).toContain(
      `notify (hook) runs notify.sh on stop. ${COMMAND_DETAIL_TAIL}`,
    );
    expect(rowText("mcp-2")).toContain(
      `legacy (MCP server). ${COMMAND_DETAIL_TAIL}`,
    );
  });

  it("words each held executable kind by what it does and who gets it", async () => {
    const EVERYWHERE = "every computer and sandbox running Personal";
    const cases: readonly {
      readonly entry: ReviewHeldEntry;
      readonly line: string;
    }[] = [
      {
        entry: entryOf({
          entryId: "skill-1",
          kind: "skill",
          key: "review",
        }),
        line: `review (skill). Once approved, it runs on ${EVERYWHERE}.`,
      },
      {
        entry: entryOf({
          entryId: "shell-1",
          kind: "shell",
          key: "shell",
          os: "macos",
          command: "/bin/zsh -l",
        }),
        line: "shell (shell for macOS) is what terminals and agents start in: /bin/zsh -l. Once approved, every macOS computer and sandbox running Personal uses it.",
      },
      {
        entry: entryOf({
          entryId: "shell-2",
          kind: "shell",
          key: "shell",
          os: "any",
        }),
        line: "shell (shell) is what terminals and agents start in. Once approved, every computer and sandbox running Personal uses it.",
      },
      {
        entry: entryOf({
          entryId: "setup-1",
          kind: "setup_script",
          key: "setup",
          command: "brew bundle",
          event: "boot",
        }),
        line: "setup (setup script) runs brew bundle when a sandbox first gets it or it changes. Once approved, it runs on every sandbox running Personal, never on a computer.",
      },
      {
        entry: entryOf({
          entryId: "agent-1",
          kind: "agent_definition",
          key: "reviewer",
        }),
        line: `reviewer (agent definition) describes an agent a provider can start. Once approved, ${EVERYWHERE} gets it.`,
      },
      {
        entry: entryOf({
          entryId: "env-1",
          kind: "env_override",
          key: "claude:NODE_OPTIONS",
          harness: "claude",
          value: "--inspect",
        }),
        line: `NODE_OPTIONS (variable) changes how Claude Code starts: NODE_OPTIONS=--inspect. Once approved, ${EVERYWHERE} starts Claude Code with it.`,
      },
      {
        entry: entryOf({
          entryId: "var-1",
          kind: "variable",
          key: "PATH_EXTRA",
        }),
        line: `PATH_EXTRA (variable) changes how programs start. Once approved, ${EVERYWHERE} starts programs with it.`,
      },
    ];
    renderSession(
      SHARED,
      cases.map(({ entry }) => ({ ...entry, reason: "executable_entry" })),
      [],
    );

    const commands = await screen.findByTestId("retrospective-held-commands");
    for (const { entry, line } of cases) {
      expect(
        within(commands).getByTestId(`retrospective-held-${entry.entryId}`)
          .textContent,
      ).toContain(line);
    }
  });
});

describe("<RetrospectiveSession /> a held choice the host refuses", () => {
  it("says the person no longer has access, and keeps the sheet open", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    renderSessionWith(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "local",
          room: "local",
        },
      }),
      [
        entryOf({
          entryId: "hook-1",
          reason: "executable_entry",
          kind: "hook",
          key: "notify",
          command: "notify.sh",
          event: "stop",
        }),
      ],
      [],
      {
        onOpenChange,
        applyOutcome: { outcome: "forbidden" },
      },
    );

    const row = await screen.findByTestId("retrospective-held-hook-1");
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(applyReviewChoice).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("status")).textContent).toBe(
      "You no longer have access to change these settings.",
    );
    expect(screen.getByTestId("retrospective-sheet")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("<RetrospectiveSession /> an inventory that cannot be read", () => {
  it("says where the settings could not be read, and Retry brings the rows", async () => {
    const entries = [
      entryOf({
        entryId: "hook-1",
        reason: "executable_entry",
        kind: "hook",
        key: "notify",
        command: "notify.sh",
        event: "stop",
      }),
    ];
    renderSessionWith(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "local",
          room: "local",
        },
      }),
      entries,
      [],
      {
        onOpenChange: vi.fn(),
        readFailures: 1,
      },
    );
    const sheet = await screen.findByTestId("retrospective-sheet");
    expect((await within(sheet).findByRole("status")).textContent).toBe(
      "Couldn't read Old laptop's settings.Retry",
    );
    expect(screen.queryByTestId("retrospective-held-hook-1")).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("retrospective-held-hook-1")).toBeTruthy();
  });
});

describe("<RetrospectiveSession /> a held Approve that conflicts", () => {
  const SHARED = environmentStatusFixture({
    planes: { records: "shared_unrecorded", broker: "local", room: "local" },
  });

  it("disables only that row's Approve and sends nothing on another press", async () => {
    renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyOutcome: { outcome: "conflict" },
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );
    await screen.findByTestId("retrospective-held-hook-2-approve");

    fireEvent.click(approve);

    await waitFor(() => expect(applyReviewChoice).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("retrospective-held-hook-1-approve")
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(
      screen
        .getByTestId("retrospective-held-hook-1-discard")
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByTestId("retrospective-held-hook-2-approve")
        .hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByTestId("retrospective-held-hook-1-approve"));

    expect(applyReviewChoice).toHaveBeenCalledTimes(1);
  });

  it("offers Approve again after the sheet closes and opens", async () => {
    const view = renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyOutcome: { outcome: "conflict" },
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );
    fireEvent.click(approve);
    await waitFor(() => expect(applyReviewChoice).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("retrospective-held-hook-1-approve")
          .hasAttribute("disabled"),
      ).toBe(true),
    );

    act(() => view.rerender(false));
    await waitFor(() =>
      expect(
        screen.queryByTestId("retrospective-held-hook-1-approve"),
      ).toBeNull(),
    );
    act(() => view.rerender(true));

    await waitFor(() =>
      expect(
        screen
          .getByTestId("retrospective-held-hook-1-approve")
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });

  it("keeps Approve enabled when the held choice is gone", async () => {
    renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyOutcome: { outcome: "gone" },
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );

    fireEvent.click(approve);

    await waitFor(() => expect(applyReviewChoice).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
  });

  it("does not apply a late conflict to the next opening", async () => {
    const deferred: {
      resolve: ((outcome: ReviewChoiceOutcome) => void) | null;
      answer: Promise<ReviewChoiceOutcome> | null;
    } = { resolve: null, answer: null };
    const view = renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyOutcome: { outcome: "conflict" },
    });
    vi.mocked(applyReviewChoice).mockImplementationOnce(() => {
      deferred.answer = new Promise((resolve) => {
        deferred.resolve = resolve;
      });
      return deferred.answer;
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );
    fireEvent.click(approve);
    await waitFor(() => expect(applyReviewChoice).toHaveBeenCalledTimes(1));

    act(() => view.rerender(false));
    await waitFor(() =>
      expect(
        screen.queryByTestId("retrospective-held-hook-1-approve"),
      ).toBeNull(),
    );
    act(() => view.rerender(true));
    await screen.findByTestId("retrospective-held-hook-1-approve");

    const resolve = deferred.resolve;
    const answer = deferred.answer;
    if (resolve === null || answer === null)
      throw new Error("Approve did not start");
    await act(async () => {
      resolve({ outcome: "conflict" });
      await answer;
    });

    await waitFor(() =>
      expect(
        screen
          .getByTestId("retrospective-held-hook-1-approve")
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });
});
