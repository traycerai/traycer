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
import type { ReviewHeldEntry } from "@traycer-clients/shared/environment/environment-review";
import type {
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
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
  setTeamEnvironmentCloudOverride,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

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
});

const COMMAND_DETAIL_TAIL =
  "Once approved, it runs on every computer and sandbox running Personal.";
const REVISION_CONFLICT_ANSWER: EnvironmentTransportAnswer = {
  status: 409,
  text: JSON.stringify({ code: "revision_conflict", current: null }),
};

function applyRequests(
  requests: readonly CapturedReviewRequest[],
): CapturedReviewRequest[] {
  return requests.filter(
    ({ method, url }) => method === "POST" && url.includes("/review/held/"),
  );
}

function reviewReads(
  requests: readonly CapturedReviewRequest[],
): CapturedReviewRequest[] {
  return requests.filter(
    ({ method, url }) =>
      method === "GET" && new URL(url).pathname.endsWith("/review"),
  );
}

interface CapturedReviewRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function heldValue(entry: ReviewHeldEntry): unknown {
  switch (entry.kind) {
    case "mcp_server":
      return {
        definition: {
          transport: "stdio",
          command: entry.command ?? "run-server",
          args: [],
        },
      };
    case "shell":
      return { path: entry.command ?? "/bin/zsh", args: [] };
    case "setup_script":
      return { text: entry.command ?? "setup" };
    case "variable":
    case "env_override":
      return { value: entry.value ?? "setting" };
    default:
      return {};
  }
}

function authnHeldEntry(entry: ReviewHeldEntry): Record<string, unknown> {
  return {
    type: "held",
    heldId: entry.entryId,
    revision: entry.heldRevision,
    kind: entry.kind,
    key: entry.key,
    os: entry.os === "any" ? null : entry.os,
    hostId: entry.hostId ?? mockLocalHostEntry.hostId,
    sharingGeneration: null,
    hostName: "Old laptop",
    heldAt: entry.heldAt,
    op: entry.op,
    value: entry.op === "delete" ? null : heldValue(entry),
    live:
      entry.liveRevision === null
        ? null
        : { revision: entry.liveRevision, value: {} },
  };
}

interface SessionHarness {
  readonly rerender: (open: boolean) => void;
  readonly requests: readonly CapturedReviewRequest[];
  /** The base authn's requests are sent to, as the binding's sign-in has it. */
  readonly authnBaseUrl: string;
  readonly resolveApply: (answer: EnvironmentTransportAnswer) => void;
}

/** A held entry with the facts the review sheet displays. */
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
    readonly applyAnswer?: EnvironmentTransportAnswer;
    readonly deferApply?: boolean;
    readonly readFailures?: number;
  },
): SessionHarness {
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
    "environment.review.record": (request) => {
      recorded.push(request.event);
      return { outcome: "recorded" };
    },
  };
  const harness = mountTeamPage(personalPoolSource(), handlers);
  const client = requireTeamHostClient();
  let remainingReadFailures = session.readFailures ?? 0;
  let currentEntries = entries;
  const requests: CapturedReviewRequest[] = [];
  let applyResolver: ((answer: EnvironmentTransportAnswer) => void) | null =
    null;
  const cloud = requireTeamEnvironmentAuthnBinding().auth.environmentCloud();
  setTeamEnvironmentCloudOverride({
    ...cloud,
    transport: async (request: EnvironmentTransportRequest) => {
      const path = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        url: request.url,
        body: request.body,
      });
      if (request.method === "GET" && path.endsWith("/review")) {
        if (remainingReadFailures > 0) {
          remainingReadFailures -= 1;
          return {
            status: 503,
            text: JSON.stringify({ error: "unavailable" }),
          };
        }
        return {
          status: 200,
          text: JSON.stringify({
            review: { hosts: [], needsYou: currentEntries.map(authnHeldEntry) },
          }),
        };
      }
      if (request.method === "POST" && path.includes("/review/held/")) {
        if (session.deferApply === true) {
          return new Promise((resolve) => {
            applyResolver = resolve;
          });
        }
        const answer = session.applyAnswer ?? { status: 200, text: "{}" };
        if (path.endsWith("/discard") && answer.status === 200) {
          const heldId = path.split("/").at(-2);
          currentEntries = currentEntries.filter(
            (entry) => entry.entryId !== heldId,
          );
        }
        return answer;
      }
      return cloud.transport(request);
    },
  });
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
  return {
    rerender: (open) => view.rerender(ui(open)),
    requests,
    authnBaseUrl: cloud.authnBaseUrl,
    resolveApply: (answer) => {
      if (applyResolver === null) throw new Error("Apply did not start");
      const resolve = applyResolver;
      applyResolver = null;
      resolve(answer);
    },
  };
}

function heldChoiceEntries(): readonly ReviewHeldEntry[] {
  return [
    entryOf({
      entryId: "hook-1",
      reason: "executable_entry",
      kind: "hook",
      key: "notify",
    }),
    entryOf({
      entryId: "hook-2",
      reason: "executable_entry",
      kind: "hook",
      key: "format",
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

  it("lists held commands under Commands on hold with available details", async () => {
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
          entryId: "mcp-2",
          reason: "executable_entry",
          kind: "mcp_server",
          key: "legacy",
          command: "node ./legacy",
        }),
      ],
      [],
    );

    const commands = await screen.findByTestId("retrospective-held-commands");
    expect(within(commands).getByText("Commands on hold")).toBeTruthy();
    const rowLine = (id: string): string => {
      const line = within(commands)
        .getByTestId(`retrospective-held-${id}`)
        .querySelector("p");
      if (line === null) throw new Error(`Missing held row line for ${id}`);
      return line.textContent;
    };
    expect(rowLine("mcp-1")).toBe(
      `github (MCP server) runs npx -y @acme/github-mcp --readonly. ${COMMAND_DETAIL_TAIL}`,
    );
    expect(rowLine("mcp-2")).toBe(
      `legacy (MCP server) runs node ./legacy. ${COMMAND_DETAIL_TAIL}`,
    );
  });

  it.each([
    ["managed_profile", "claude:work", null, "claude:work (managed profile)"],
    ["pack_policy", "pack-a", null, "pack-a (pack policy)"],
    [
      "variable",
      "NODE_ENV",
      "production",
      "NODE_ENV (variable) changes how programs start: NODE_ENV=production. Once approved, every computer and sandbox running Personal starts programs with it.",
    ],
  ])(
    "words a held %s by what it is and what approving it does",
    async (kind, key, value, line) => {
      renderSession(
        SHARED,
        [
          entryOf({
            entryId: "held-1",
            reason: "executable_entry",
            kind,
            key,
            value,
          }),
        ],
        [],
      );

      const row = await screen.findByTestId("retrospective-held-held-1");
      expect(row.querySelector("p")?.textContent).toBe(line);
    },
  );

  it("draws the masked held values from authn's review response", async () => {
    const EVERYWHERE = "every computer and sandbox running Personal";
    const cases: readonly {
      readonly entry: ReviewHeldEntry;
      readonly line: string;
    }[] = [
      {
        entry: entryOf({
          entryId: "future-1",
          kind: "future_widget",
          key: "review",
        }),
        line: "review (future widget)",
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
        line: "shell (shell) is what terminals and agents start in: /bin/zsh. Once approved, every computer and sandbox running Personal uses it.",
      },
      {
        entry: entryOf({
          entryId: "setup-1",
          kind: "setup_script",
          key: "setup",
          command: "brew bundle",
        }),
        line: "setup (setup script) runs brew bundle when a sandbox first gets it or it changes. Once approved, it runs on every sandbox running Personal, never on a computer.",
      },
      {
        entry: entryOf({
          entryId: "setup-secret-1",
          kind: "setup_script",
          key: "setup-secret",
          command: "export API_KEY=abc123\nnpm ci",
        }),
        line: "setup-secret (setup script) runs export API_KEY=•••; npm ci when a sandbox first gets it or it changes. Once approved, it runs on every sandbox running Personal, never on a computer.",
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
        line: `PATH_EXTRA (variable) changes how programs start: PATH_EXTRA=setting. Once approved, ${EVERYWHERE} starts programs with it.`,
      },
    ];
    renderSession(
      SHARED,
      cases.map(({ entry }) => ({ ...entry, reason: "executable_entry" })),
      [],
    );

    const commands = await screen.findByTestId("retrospective-held-commands");
    for (const { entry, line } of cases) {
      const rowLine = within(commands)
        .getByTestId(`retrospective-held-${entry.entryId}`)
        .querySelector("p");
      expect(rowLine).not.toBeNull();
      expect(rowLine?.textContent).toBe(line);
    }
  });
});

describe("<RetrospectiveSession /> an authn refusal for a held choice", () => {
  it("discards a held choice through authn with its hold revision", async () => {
    const view = renderSessionWith(
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
          heldRevision: 8,
          liveRevision: 3,
        }),
      ],
      [],
      { onOpenChange: vi.fn() },
    );

    fireEvent.click(
      await screen.findByTestId("retrospective-held-hook-1-discard"),
    );

    await waitFor(() => {
      expect(applyRequests(view.requests)).toHaveLength(1);
      expect(screen.queryByTestId("retrospective-held-hook-1")).toBeNull();
    });
    expect(reviewReads(view.requests)[0]).toEqual({
      method: "GET",
      url: `${view.authnBaseUrl}/api/v3/environments/env-personal/review?include=operation`,
      body: null,
    });
    expect(applyRequests(view.requests)).toEqual([
      {
        method: "POST",
        url: `${view.authnBaseUrl}/api/v3/environments/env-personal/review/held/hook-1/discard`,
        body: { revision: 8 },
      },
    ]);
  });

  it("says the person no longer has access, and keeps the sheet open", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const view = renderSessionWith(
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
          heldRevision: 8,
          liveRevision: 3,
        }),
      ],
      [],
      {
        onOpenChange,
        applyAnswer: {
          status: 403,
          text: JSON.stringify({ error: "This change needs permission." }),
        },
      },
    );

    const row = await screen.findByTestId("retrospective-held-hook-1");
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(applyRequests(view.requests)).toHaveLength(1));
    expect(applyRequests(view.requests)).toEqual([
      {
        method: "POST",
        url: `${view.authnBaseUrl}/api/v3/environments/env-personal/review/held/hook-1/apply`,
        body: { revision: 8, expectedLiveRevision: 3 },
      },
    ]);
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
    const view = renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyAnswer: REVISION_CONFLICT_ANSWER,
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );
    await screen.findByTestId("retrospective-held-hook-2-approve");

    fireEvent.click(approve);

    await waitFor(() => expect(applyRequests(view.requests)).toHaveLength(1));
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

    expect(applyRequests(view.requests)).toHaveLength(1);
  });

  it("offers Approve again after the sheet closes and opens", async () => {
    const view = renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyAnswer: REVISION_CONFLICT_ANSWER,
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );
    fireEvent.click(approve);
    await waitFor(() => expect(applyRequests(view.requests)).toHaveLength(1));
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
    const view = renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyAnswer: { status: 404, text: JSON.stringify({ error: "gone" }) },
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );

    fireEvent.click(approve);

    await waitFor(() => expect(applyRequests(view.requests)).toHaveLength(1));
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
  });

  it("keeps Approve enabled when a 409 does not name a live-item conflict", async () => {
    const view = renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      applyAnswer: {
        status: 409,
        text: JSON.stringify({ code: "hold_revision_conflict" }),
      },
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );

    fireEvent.click(approve);

    await waitFor(() => expect(applyRequests(view.requests)).toHaveLength(1));
    expect(applyRequests(view.requests)[0]).toMatchObject({
      method: "POST",
      url: `${view.authnBaseUrl}/api/v3/environments/env-personal/review/held/hook-1/apply`,
      body: { revision: 1, expectedLiveRevision: 1 },
    });
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
  });

  it("does not apply a late conflict to the next opening", async () => {
    const view = renderSessionWith(SHARED, heldChoiceEntries(), [], {
      onOpenChange: vi.fn(),
      deferApply: true,
    });
    const approve = await screen.findByTestId(
      "retrospective-held-hook-1-approve",
    );
    fireEvent.click(approve);
    await waitFor(() => expect(applyRequests(view.requests)).toHaveLength(1));

    act(() => view.rerender(false));
    await waitFor(() =>
      expect(
        screen.queryByTestId("retrospective-held-hook-1-approve"),
      ).toBeNull(),
    );
    act(() => view.rerender(true));
    await screen.findByTestId("retrospective-held-hook-1-approve");

    act(() => view.resolveApply(REVISION_CONFLICT_ANSWER));

    await waitFor(() =>
      expect(
        screen
          .getByTestId("retrospective-held-hook-1-approve")
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });
});
