// The page reads through the window's own host. The host id the panel
// addresses is mocked at the one hook that names it; the client is a REAL
// `HostClient` over an in-memory messenger (`buildEnvironmentClient`), so a
// save and a retry travel the request path the app uses and only the host is
// faked.
const hostIdMock = vi.hoisted((): { id: string } => ({
  id: "host-a",
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => hostIdMock.id,
}));

const hostMock = vi.hoisted(
  (): { client: unknown; binding: { readonly auth: unknown } | null } => ({
    client: null,
    binding: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => hostMock.client,
    useHostBinding: () => hostMock.binding,
  };
});

// The stale notice is a toast; the rest of sonner stays real.
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, info: toastInfo } };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  SetupAttempt,
  SetupScript,
} from "@traycer/protocol/host/environment-schemas";
import { MachineSetupSettingsPanel } from "@/components/settings/panels/machine-setup-settings-panel";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { HOST_METHOD_POLL_TABLE } from "@/lib/host-rpc-policy/host-method-policy-table";

type PutRequest = RequestOfMethod<HostRpcRegistry, "environment.setup.put">;

const ALL_METHODS = [
  "environment.status",
  "environment.setup.get",
  "environment.setup.put",
  "environment.setup.attempts",
  "environment.setup.retry",
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  toastInfo.mockClear();
  resetNegotiatedManifests();
  hostMock.client = null;
  hostMock.binding = null;
  hostIdMock.id = "host-a";
});

interface Rig {
  readonly puts: PutRequest[];
  readonly retries: unknown[];
  readonly attemptReads: () => number;
  readonly scriptReads: () => number;
}

interface RigOptions {
  /** `null` records nothing: no handshake has completed yet. */
  readonly methods: readonly string[] | null;
  readonly scripts: readonly SetupScript[];
  readonly attempts: readonly SetupAttempt[];
  readonly failScripts: boolean;
  readonly failAttempts: boolean;
  /** When set, a save loses to this dashboard change, which the host then holds. */
  readonly dashboardWins: SetupScript | null;
}

const DEFAULT_RIG: RigOptions = {
  methods: ALL_METHODS,
  scripts: [],
  attempts: [],
  failScripts: false,
  failAttempts: false,
  dashboardWins: null,
};

function attempt(
  overrides: Partial<SetupAttempt> & { attemptId: string },
): SetupAttempt {
  return {
    scriptHash: "hash-1",
    itemRevision: 1,
    trigger: "change",
    startedAt: 1_000,
    endedAt: 2_000,
    exitStatus: null,
    stageReached: null,
    result: "succeeded",
    ...overrides,
  };
}

function renderPage(options: RigOptions): Rig {
  const scripts = [...options.scripts];
  const attempts = [...options.attempts];
  const puts: PutRequest[] = [];
  const retries: unknown[] = [];
  let attemptReads = 0;
  let scriptReads = 0;
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => environmentStatusFixture({}),
    "environment.setup.get": () => {
      scriptReads += 1;
      if (options.failScripts) return Promise.reject(new Error("host is down"));
      return Promise.resolve({ scripts: [...scripts] });
    },
    "environment.setup.put": (request) => {
      puts.push(request);
      const index = scripts.findIndex((s) => s.os === request.os);
      if (options.dashboardWins !== null) {
        const winner = options.dashboardWins;
        if (index === -1) scripts.push(winner);
        else scripts[index] = winner;
        return Promise.resolve({
          outcome: "stale" as const,
          currentRevision: winner.revision,
          changedBy: { kind: "dashboard" as const },
        });
      }
      const revision = (scripts[index]?.revision ?? 0) + 1;
      const next = { os: request.os, text: request.text, revision };
      if (index === -1) scripts.push(next);
      else scripts[index] = next;
      return Promise.resolve({ outcome: "saved" as const, revision });
    },
    "environment.setup.attempts": () => {
      attemptReads += 1;
      if (options.failAttempts) {
        return Promise.reject(new Error("host is down"));
      }
      return Promise.resolve({ attempts: [...attempts] });
    },
    "environment.setup.retry": (request) => {
      retries.push(request);
      // The host starts a run: it shows as running until it ends.
      attempts.push(
        attempt({
          attemptId: "retry-1",
          trigger: "retry",
          startedAt: 9_000,
          endedAt: null,
          result: null,
        }),
      );
      return Promise.resolve({ attemptId: "retry-1" });
    },
  };
  const { client } = buildEnvironmentClient({
    hostId: hostIdMock.id,
    handlers,
  });
  if (options.methods !== null) {
    recordNegotiatedHostMethods(hostIdMock.id, options.methods);
  }
  hostMock.client = client;
  hostMock.binding = {
    auth: {
      mintExecutableWriteGrant: () =>
        Promise.resolve({
          kind: "ok" as const,
          grant: "grant-1",
          expiresInSeconds: 600,
        }),
      getCredentialGeneration: () => 0,
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MachineSetupSettingsPanel />
    </QueryClientProvider>,
  );
  return {
    puts,
    retries,
    attemptReads: () => attemptReads,
    scriptReads: () => scriptReads,
  };
}

const MAC: SetupScript = { os: "macos", text: "brew bundle", revision: 4 };
const LINUX: SetupScript = {
  os: "linux",
  text: "apt-get install -y jq",
  revision: 2,
};

/** Lets a request a NEGATIVE assertion depends on happen first. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

function scriptField(label: string): HTMLTextAreaElement {
  const field = screen.getByRole("textbox", { name: `${label} setup script` });
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error(`${label} setup script is not a textarea`);
  }
  return field;
}

function saveButton(): HTMLElement {
  return within(screen.getByTestId("setup-scripts")).getByRole("button", {
    name: "Save",
  });
}

function retryButton(): HTMLElement {
  return within(screen.getByTestId("setup-attempts")).getByRole("button", {
    name: "Retry",
  });
}

describe("<MachineSetupSettingsPanel /> scripts", () => {
  it("offers macOS, Linux and Windows tabs, opening on macOS with that script", async () => {
    renderPage({ ...DEFAULT_RIG, scripts: [MAC, LINUX] });

    const user = userEvent.setup();
    expect(await screen.findByRole("tab", { name: "macOS" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Linux" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Windows" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "macOS" }).getAttribute("data-state"),
    ).toBe("active");
    expect(scriptField("macOS").value).toBe("brew bundle");

    await user.click(screen.getByRole("tab", { name: "Linux" }));
    expect(scriptField("Linux").value).toBe("apt-get install -y jq");

    // An OS with no script yet is an empty editor, not a missing tab.
    await user.click(screen.getByRole("tab", { name: "Windows" }));
    expect(scriptField("Windows").value).toBe("");
  });

  it("disables Save until the script changed, then saves with the OS and the revision it was edited from", async () => {
    const rig = renderPage({ ...DEFAULT_RIG, scripts: [MAC, LINUX] });
    await screen.findByRole("tab", { name: "macOS" });
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(scriptField("macOS"), {
      target: { value: "brew bundle --no-lock" },
    });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    // Typing is not a write.
    expect(rig.puts).toEqual([]);

    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });
    // The script runs on every computer of that OS, so it carries the grant
    // the person's own session minted.
    expect(rig.puts[0]).toEqual({
      os: "macos",
      text: "brew bundle --no-lock",
      expectedRevision: 4,
      executableWriteGrant: "grant-1",
    });
    // The re-read remounts the editor on the revision it now has.
    await waitFor(() => {
      expect(saveButton().hasAttribute("disabled")).toBe(true);
    });
    expect(scriptField("macOS").value).toBe("brew bundle --no-lock");
  });

  it("saves the OS whose tab is open, from that OS's own revision", async () => {
    const rig = renderPage({ ...DEFAULT_RIG, scripts: [MAC, LINUX] });
    const user = userEvent.setup();
    await screen.findByRole("tab", { name: "Linux" });

    await user.click(screen.getByRole("tab", { name: "Linux" }));
    fireEvent.change(scriptField("Linux"), {
      target: { value: "apt-get install -y jq git" },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });
    expect(rig.puts[0]).toMatchObject({ os: "linux", expectedRevision: 2 });
  });

  it("saves the first script of an OS with a null revision", async () => {
    const rig = renderPage({ ...DEFAULT_RIG, scripts: [MAC] });
    const user = userEvent.setup();
    await screen.findByRole("tab", { name: "Windows" });

    await user.click(screen.getByRole("tab", { name: "Windows" }));
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(scriptField("Windows"), {
      target: { value: "winget install jq" },
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });
    expect(rig.puts[0]).toEqual({
      os: "windows",
      text: "winget install jq",
      expectedRevision: null,
      executableWriteGrant: "grant-1",
    });
  });

  it("a save that lost to a dashboard change shows the stale notice and the latest script", async () => {
    const rig = renderPage({
      ...DEFAULT_RIG,
      scripts: [MAC],
      dashboardWins: { os: "macos", text: "from the dashboard", revision: 5 },
    });
    await screen.findByRole("tab", { name: "macOS" });

    fireEvent.change(scriptField("macOS"), { target: { value: "mine" } });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });

    // The page re-reads and shows what the dashboard saved.
    await waitFor(() => {
      expect(scriptField("macOS").value).toBe("from the dashboard");
    });
    await settle();
    // And the person is told where the change came from.
    expect(toastInfo.mock.calls).toEqual([
      [
        "This setting was changed in the dashboard just now.",
        { id: "environment-write-stale" },
      ],
    ]);
  });

  it("says the read failed instead of showing empty editors", async () => {
    renderPage({ ...DEFAULT_RIG, failScripts: true });

    expect(
      await screen.findByText(
        "Couldn't read your setup scripts from this host.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "macOS" })).toBeNull();
  });
});

describe("<MachineSetupSettingsPanel /> moving between computers", () => {
  it("shows the other computer's script, not a draft, when its OS and revision match", async () => {
    // Same OS, same revision, different text: only the host tells them apart.
    const onA: SetupScript = { os: "macos", text: "brew on A", revision: 4 };
    const onB: SetupScript = { os: "macos", text: "brew on B", revision: 4 };
    const handlersFor = (
      script: SetupScript,
    ): MockHandlerMap<HostRpcRegistry> => ({
      "environment.status": () => environmentStatusFixture({}),
      "environment.setup.get": () => Promise.resolve({ scripts: [script] }),
      "environment.setup.attempts": () => Promise.resolve({ attempts: [] }),
    });
    const a = buildEnvironmentClient({
      hostId: "host-a",
      handlers: handlersFor(onA),
    });
    const b = buildEnvironmentClient({
      hostId: "host-b",
      handlers: handlersFor(onB),
    });
    recordNegotiatedHostMethods("host-a", ALL_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_METHODS);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    // A fresh element each time: React skips re-rendering an identical one.
    const page = (): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <MachineSetupSettingsPanel />
      </QueryClientProvider>
    );
    hostIdMock.id = "host-a";
    hostMock.client = a.client;
    const view = render(page());
    await waitFor(() => {
      expect(scriptField("macOS").value).toBe("brew on A");
    });
    fireEvent.change(scriptField("macOS"), {
      target: { value: "a draft nobody saved" },
    });

    hostIdMock.id = "host-b";
    hostMock.client = b.client;
    view.rerender(page());
    await waitFor(() => {
      expect(scriptField("macOS").value).toBe("brew on B");
    });

    // Back to A, whose read is cached: no pending read unmounts the editor,
    // so only its key can drop the draft.
    hostIdMock.id = "host-a";
    hostMock.client = a.client;
    view.rerender(page());
    await waitFor(() => {
      expect(scriptField("macOS").value).toBe("brew on A");
    });
  });
});

describe("<MachineSetupSettingsPanel /> runs on this host", () => {
  it("shows each run's start with the shared Settings date format", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    renderPage({
      ...DEFAULT_RIG,
      attempts: [
        attempt({
          attemptId: "today",
          startedAt: new Date(2026, 9, 25, 8, 35).getTime(),
        }),
        attempt({
          attemptId: "earlier-this-year",
          startedAt: new Date(2026, 9, 24, 8, 35).getTime(),
        }),
        attempt({
          attemptId: "another-year",
          startedAt: new Date(2025, 9, 25, 8, 35).getTime(),
        }),
      ],
    });

    const rows = await screen.findAllByTestId("setup-attempt");
    expect(rows.map((row) => within(row).getByText(/\d/).textContent)).toEqual([
      "08:35",
      "24 Oct 08:35",
      "25 Oct 2025",
    ]);
  });

  const RUNS: readonly SetupAttempt[] = [
    attempt({
      attemptId: "oldest",
      trigger: "change",
      startedAt: 1_000,
      result: "succeeded",
    }),
    attempt({
      attemptId: "failed",
      trigger: "resume",
      startedAt: 3_000,
      exitStatus: 2,
      stageReached: "dependencies",
      result: "failed",
    }),
    attempt({
      attemptId: "timed-out",
      trigger: "restart",
      startedAt: 2_000,
      stageReached: "build",
      result: "timed_out",
    }),
  ];

  it("lists the runs newest first with their outcome, trigger and stage", async () => {
    renderPage({ ...DEFAULT_RIG, attempts: RUNS });

    const rows = await screen.findAllByTestId("setup-attempt");
    expect(rows).toHaveLength(3);
    // Newest first, whatever order the host answered in.
    expect(rows[0]?.textContent).toContain("Failed (exit 2)");
    expect(rows[0]?.textContent).toContain("On resume");
    expect(rows[0]?.textContent).toContain("Reached dependencies");
    expect(rows[1]?.textContent).toContain("Timed out");
    expect(rows[1]?.textContent).toContain("After a restart");
    expect(rows[1]?.textContent).toContain("Reached build");
    expect(rows[2]?.textContent).toContain("Succeeded");
    expect(rows[2]?.textContent).toContain("After a change");
    // A run that succeeded names no stage.
    expect(rows[2]?.textContent).not.toContain("Reached");
  });

  it("calls a run with no result Running and the other outcomes by name", async () => {
    renderPage({
      ...DEFAULT_RIG,
      attempts: [
        attempt({
          attemptId: "running",
          startedAt: 5_000,
          endedAt: null,
          result: null,
        }),
        attempt({
          attemptId: "cancelled",
          startedAt: 4_000,
          result: "cancelled",
        }),
        attempt({ attemptId: "unknown", startedAt: 3_000, result: "unknown" }),
        attempt({
          attemptId: "failed-no-exit",
          startedAt: 2_000,
          result: "failed",
        }),
      ],
    });

    const rows = await screen.findAllByTestId("setup-attempt");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Running"),
      expect.stringContaining("Cancelled"),
      expect.stringContaining("Ended without a result"),
      expect.stringMatching(/^Failed(?! \()/),
    ]);
  });

  it("sends a retry on the click and then holds Retry while the new run is in progress", async () => {
    const rig = renderPage({ ...DEFAULT_RIG, attempts: RUNS });
    await screen.findAllByTestId("setup-attempt");
    expect(retryButton().hasAttribute("disabled")).toBe(false);
    // Listing the runs is not a retry.
    expect(rig.retries).toEqual([]);

    fireEvent.click(retryButton());
    await waitFor(() => {
      expect(rig.retries).toHaveLength(1);
    });
    expect(rig.retries[0]).toEqual({});

    // The re-read shows the run the host started, newest first, and Retry
    // waits for it to end.
    await waitFor(() => {
      expect(screen.getAllByTestId("setup-attempt")).toHaveLength(4);
    });
    const newest = screen.getAllByTestId("setup-attempt")[0];
    expect(newest.textContent).toContain("Running");
    expect(newest.textContent).toContain("Retried");
    await waitFor(() => {
      expect(retryButton().hasAttribute("disabled")).toBe(true);
    });
    fireEvent.click(retryButton());
    await settle();
    expect(rig.retries).toHaveLength(1);
  });

  it("disables Retry while a run is in progress", async () => {
    const rig = renderPage({
      ...DEFAULT_RIG,
      attempts: [
        attempt({ attemptId: "done", startedAt: 1_000 }),
        attempt({
          attemptId: "running",
          startedAt: 2_000,
          endedAt: null,
          result: null,
        }),
      ],
    });

    await screen.findAllByTestId("setup-attempt");
    expect(retryButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(retryButton());
    await settle();
    expect(rig.retries).toEqual([]);
  });

  it("has nothing to retry before the first run", async () => {
    const rig = renderPage({ ...DEFAULT_RIG, attempts: [] });

    expect(await screen.findByText("No runs on this host yet.")).toBeTruthy();
    expect(screen.queryAllByTestId("setup-attempt")).toEqual([]);
    expect(retryButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(retryButton());
    await settle();
    expect(rig.retries).toEqual([]);
  });

  it("says the runs could not be read instead of claiming there were none", async () => {
    renderPage({ ...DEFAULT_RIG, failAttempts: true });

    expect(
      await screen.findByText("Couldn't read this host's setup runs."),
    ).toBeTruthy();
    expect(screen.queryByText("No runs on this host yet.")).toBeNull();
    expect(retryButton().hasAttribute("disabled")).toBe(true);
  });

  it("is re-read at the fixed 5 s cadence the method's policy declares", () => {
    // The page asks for `poll: true`; a run started by a save, a retry or a
    // restart ends on its own and nothing else tells the page it did.
    expect(HOST_METHOD_POLL_TABLE["environment.setup.attempts"].poll).toEqual({
      kind: "fixed",
      intervalMs: 5_000,
    });
  });
});

describe("<MachineSetupSettingsPanel /> host support", () => {
  it("asks the person to update a host that advertises neither method, and reads nothing", async () => {
    const rig = renderPage({
      ...DEFAULT_RIG,
      methods: ["environment.status"],
      scripts: [MAC],
      attempts: [attempt({ attemptId: "a" })],
    });

    expect(
      await screen.findByText("Update this host to use machine setup."),
    ).toBeTruthy();
    await settle();
    expect(rig.scriptReads()).toBe(0);
    expect(rig.attemptReads()).toBe(0);
    expect(screen.queryByTestId("setup-scripts")).toBeNull();
    expect(screen.queryByTestId("setup-attempts")).toBeNull();
  });

  it("shows only the runs on a host that serves the runs but not the scripts", async () => {
    const rig = renderPage({
      ...DEFAULT_RIG,
      methods: ["environment.status", "environment.setup.attempts"],
      attempts: [attempt({ attemptId: "a" })],
    });

    expect(await screen.findAllByTestId("setup-attempt")).toHaveLength(1);
    expect(screen.queryByTestId("setup-scripts")).toBeNull();
    expect(
      screen.queryByText("Update this host to use machine setup."),
    ).toBeNull();
    expect(rig.scriptReads()).toBe(0);
  });

  it("shows only the scripts on a host that serves the scripts but not the runs", async () => {
    const rig = renderPage({
      ...DEFAULT_RIG,
      methods: ["environment.status", "environment.setup.get"],
      scripts: [MAC],
    });

    expect(await screen.findByRole("tab", { name: "macOS" })).toBeTruthy();
    expect(screen.queryByTestId("setup-attempts")).toBeNull();
    expect(
      screen.queryByText("Update this host to use machine setup."),
    ).toBeNull();
    await settle();
    expect(rig.attemptReads()).toBe(0);
  });

  it("claims nothing before the host has handshaked", async () => {
    const rig = renderPage({ ...DEFAULT_RIG, methods: null });

    await settle();
    expect(
      screen.queryByText("Update this host to use machine setup."),
    ).toBeNull();
    expect(screen.queryByTestId("setup-scripts")).toBeNull();
    expect(screen.queryByTestId("setup-attempts")).toBeNull();
    expect(rig.scriptReads()).toBe(0);
    expect(rig.attemptReads()).toBe(0);
  });
});
