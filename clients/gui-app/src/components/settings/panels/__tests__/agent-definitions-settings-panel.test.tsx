// The page reads through the window's own host. The host id the panel
// addresses is mocked at the one hook that names it; the client is a REAL
// `HostClient` over an in-memory messenger (`buildEnvironmentClient`), so a
// save travels the request path the app uses and only the host is faked.
const hostIdMock = vi.hoisted((): { readonly id: string } => ({
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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { AgentDefinition } from "@traycer/protocol/host/environment-schemas";
import { AgentDefinitionsSettingsPanel } from "@/components/settings/panels/agent-definitions-settings-panel";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";

type PutRequest = RequestOfMethod<
  HostRpcRegistry,
  "environment.agentDefinitions.put"
>;
type DeleteRequest = RequestOfMethod<
  HostRpcRegistry,
  "environment.agentDefinitions.delete"
>;

const METHODS = [
  "environment.status",
  "environment.agentDefinitions.list",
  "environment.agentDefinitions.put",
  "environment.agentDefinitions.delete",
];

afterEach(() => {
  cleanup();
  toastInfo.mockClear();
  resetNegotiatedManifests();
  hostMock.client = null;
  hostMock.binding = null;
});

interface Rig {
  /** The definitions the host holds; a write changes them like the host would. */
  readonly definitions: AgentDefinition[];
  readonly puts: PutRequest[];
  readonly deletes: DeleteRequest[];
  readonly lists: () => number;
}

interface RigOptions {
  /** `null` records nothing: no handshake has completed yet. */
  readonly methods: readonly string[] | null;
  readonly failList: boolean;
  /** When set, a save loses to this dashboard change, which the host then holds. */
  readonly dashboardWins: AgentDefinition | null;
}

const DEFAULT_RIG: RigOptions = {
  methods: METHODS,
  failList: false,
  dashboardWins: null,
};

function renderPage(
  initial: readonly AgentDefinition[],
  options: RigOptions,
): Rig {
  const definitions = [...initial];
  const puts: PutRequest[] = [];
  const deletes: DeleteRequest[] = [];
  let listCalls = 0;
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => environmentStatusFixture({}),
    "environment.agentDefinitions.list": () => {
      listCalls += 1;
      if (options.failList) return Promise.reject(new Error("host is down"));
      return Promise.resolve({ definitions: [...definitions] });
    },
    "environment.agentDefinitions.put": (request) => {
      puts.push(request);
      const index = definitions.findIndex((d) => d.name === request.name);
      if (options.dashboardWins !== null) {
        const winner = options.dashboardWins;
        if (index === -1) definitions.push(winner);
        else definitions[index] = winner;
        return Promise.resolve({
          outcome: "stale" as const,
          currentRevision: winner.revision,
          changedBy: { kind: "dashboard" as const },
        });
      }
      const revision = (definitions[index]?.revision ?? 0) + 1;
      const next = { name: request.name, text: request.text, revision };
      if (index === -1) definitions.push(next);
      else definitions[index] = next;
      return Promise.resolve({ outcome: "saved" as const, revision });
    },
    "environment.agentDefinitions.delete": (request) => {
      deletes.push(request);
      const index = definitions.findIndex((d) => d.name === request.name);
      if (index !== -1) definitions.splice(index, 1);
      return Promise.resolve({
        outcome: "saved" as const,
        revision: request.expectedRevision + 1,
      });
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
      <AgentDefinitionsSettingsPanel />
    </QueryClientProvider>,
  );
  return { definitions, puts, deletes, lists: () => listCalls };
}

const REVIEWER: AgentDefinition = {
  name: "reviewer.md",
  text: "Review the change.",
  revision: 3,
};
const PLANNER: AgentDefinition = {
  name: "planner.md",
  text: "Plan the work.",
  revision: 7,
};

/** Lets a request a NEGATIVE assertion depends on happen first. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

function editorFor(name: string): HTMLTextAreaElement {
  const field = screen.getByRole("textbox", { name: `${name} text` });
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error(`${name} text is not a textarea`);
  }
  return field;
}

function sectionFor(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const section = heading.closest("section");
  if (section === null) throw new Error(`no section around ${name}`);
  return section;
}

function nameField(): HTMLInputElement {
  const field = screen.getByRole("textbox", { name: "File name" });
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("File name is not an input");
  }
  return field;
}

describe("<AgentDefinitionsSettingsPanel />", () => {
  it("lists each definition as an editor on its text, with the New form after them", async () => {
    renderPage([REVIEWER, PLANNER], DEFAULT_RIG);

    expect((await screen.findAllByTestId("agent-definition")).length).toBe(2);
    expect(editorFor("reviewer.md").value).toBe("Review the change.");
    expect(editorFor("planner.md").value).toBe("Plan the work.");
    expect(
      screen.getByRole("heading", { name: "New agent definition" }),
    ).toBeTruthy();
    expect(screen.queryByText("No agent definitions yet.")).toBeNull();
  });

  it("says there are none yet, and still offers New", async () => {
    renderPage([], DEFAULT_RIG);

    expect(await screen.findByText("No agent definitions yet.")).toBeTruthy();
    expect(screen.queryAllByTestId("agent-definition")).toEqual([]);
    expect(nameField()).toBeTruthy();
  });

  it("disables Save until the text changed, then saves from the revision it was edited from", async () => {
    const rig = renderPage([REVIEWER, PLANNER], DEFAULT_RIG);
    await screen.findAllByTestId("agent-definition");
    const save = within(sectionFor("reviewer.md")).getByRole("button", {
      name: "Save",
    });
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(editorFor("reviewer.md"), {
      target: { value: "Review the change, then approve." },
    });
    expect(save.hasAttribute("disabled")).toBe(false);
    // Typing is not a write.
    expect(rig.puts).toEqual([]);

    fireEvent.click(save);
    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });
    // Compare-and-set on THIS definition's revision, carrying the grant the
    // person's own session minted: an agent definition is content an agent runs.
    expect(rig.puts[0]).toEqual({
      name: "reviewer.md",
      text: "Review the change, then approve.",
      expectedRevision: 3,
      executableWriteGrant: "grant-1",
    });

    // The re-read remounts the editor on what the host now has: the new
    // revision, so Save is disabled again, and the other definition is untouched.
    await waitFor(() => {
      expect(
        within(sectionFor("reviewer.md"))
          .getByRole("button", { name: "Save" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(editorFor("reviewer.md").value).toBe(
      "Review the change, then approve.",
    );
    expect(editorFor("planner.md").value).toBe("Plan the work.");
    expect(rig.puts).toHaveLength(1);
  });

  it("sends the edited definition's own revision when several are listed", async () => {
    const rig = renderPage([REVIEWER, PLANNER], DEFAULT_RIG);
    await screen.findAllByTestId("agent-definition");

    fireEvent.change(editorFor("planner.md"), {
      target: { value: "Plan, then split." },
    });
    fireEvent.click(
      within(sectionFor("planner.md")).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });
    expect(rig.puts[0]).toMatchObject({
      name: "planner.md",
      expectedRevision: 7,
    });
  });

  it("adds a new definition with a null revision, trimming the name, and clears the form", async () => {
    const rig = renderPage([REVIEWER], DEFAULT_RIG);
    await screen.findAllByTestId("agent-definition");
    const form = screen.getByTestId("new-agent-definition");
    const add = within(form).getByRole("button", { name: "Add" });
    // Nothing to add without a name.
    expect(add.hasAttribute("disabled")).toBe(true);

    fireEvent.change(nameField(), { target: { value: "  triage.md  " } });
    fireEvent.change(
      screen.getByRole("textbox", { name: "New agent definition text" }),
      { target: { value: "Triage the report." } },
    );
    expect(add.hasAttribute("disabled")).toBe(false);
    fireEvent.click(add);

    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });
    expect(rig.puts[0]).toEqual({
      name: "triage.md",
      text: "Triage the report.",
      expectedRevision: null,
      executableWriteGrant: "grant-1",
    });
    // It lists once the host has it, and the form is empty again.
    await screen.findByRole("heading", { name: "triage.md" });
    await waitFor(() => {
      expect(nameField().value).toBe("");
    });
  });

  it("blocks a name that already exists and sends nothing", async () => {
    const rig = renderPage([REVIEWER], DEFAULT_RIG);
    await screen.findAllByTestId("agent-definition");
    const form = screen.getByTestId("new-agent-definition");
    const taken = "An agent definition with this name already exists.";

    fireEvent.change(nameField(), { target: { value: " reviewer.md " } });

    expect(within(form).getByText(taken)).toBeTruthy();
    const add = within(form).getByRole("button", { name: "Add" });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(add);
    await settle();
    expect(rig.puts).toEqual([]);

    // A different name lifts the block.
    fireEvent.change(nameField(), { target: { value: "reviewer-2.md" } });
    expect(within(form).queryByText(taken)).toBeNull();
    expect(add.hasAttribute("disabled")).toBe(false);
  });

  it("deletes only after the confirmation, from the definition's revision", async () => {
    const rig = renderPage([REVIEWER, PLANNER], DEFAULT_RIG);
    await screen.findAllByTestId("agent-definition");

    fireEvent.click(
      within(sectionFor("reviewer.md")).getByRole("button", { name: "Delete" }),
    );
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("reviewer.md");
    // Opening the confirmation is not a delete.
    await settle();
    expect(rig.deletes).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(rig.deletes).toHaveLength(1);
    });
    expect(rig.deletes[0]).toEqual({
      name: "reviewer.md",
      expectedRevision: 3,
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "reviewer.md" })).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "planner.md" })).toBeTruthy();
  });

  it("deletes nothing when the confirmation is cancelled", async () => {
    const rig = renderPage([REVIEWER], DEFAULT_RIG);
    await screen.findAllByTestId("agent-definition");

    fireEvent.click(
      within(sectionFor("reviewer.md")).getByRole("button", { name: "Delete" }),
    );
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    await settle();
    expect(rig.deletes).toEqual([]);
    expect(screen.getByRole("heading", { name: "reviewer.md" })).toBeTruthy();
  });

  it("a save that lost to a dashboard change shows the stale notice and the latest text", async () => {
    const probe: AgentDefinition = {
      name: "probe.md",
      text: "old",
      revision: 55,
    };
    const rig = renderPage([probe], {
      ...DEFAULT_RIG,
      dashboardWins: {
        name: "probe.md",
        text: "from the dashboard",
        revision: 56,
      },
    });
    await screen.findAllByTestId("agent-definition");

    fireEvent.change(editorFor("probe.md"), { target: { value: "mine" } });
    fireEvent.click(
      within(sectionFor("probe.md")).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => {
      expect(rig.puts).toHaveLength(1);
    });

    // The page re-reads and shows what the dashboard saved.
    await waitFor(() => {
      expect(editorFor("probe.md").value).toBe("from the dashboard");
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

  it("asks the person to update a host that does not serve the list, and reads nothing", async () => {
    const rig = renderPage([REVIEWER], {
      ...DEFAULT_RIG,
      methods: ["environment.status"],
    });

    expect(
      await screen.findByText("Update this host to use agent definitions."),
    ).toBeTruthy();
    await settle();
    expect(rig.lists()).toBe(0);
    expect(screen.queryAllByTestId("agent-definition")).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
  });

  it("claims nothing before the host has handshaked", async () => {
    const rig = renderPage([REVIEWER], { ...DEFAULT_RIG, methods: null });

    await settle();
    expect(
      screen.queryByText("Update this host to use agent definitions."),
    ).toBeNull();
    expect(screen.queryAllByTestId("agent-definition")).toEqual([]);
    expect(rig.lists()).toBe(0);
  });

  it("says the read failed instead of showing an empty list", async () => {
    renderPage([REVIEWER], { ...DEFAULT_RIG, failList: true });

    expect(
      await screen.findByText("Couldn't read these agent definitions."),
    ).toBeTruthy();
    expect(screen.queryByText("No agent definitions yet.")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
  });
});
