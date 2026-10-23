// What a link asks the app to open. The page under test does not open one, but
// its Add dialog reads the hook.
const openLinkMock = vi.hoisted(() => vi.fn<OpenLink>());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentSecret,
  EnvironmentSecretsDestroyRequest,
  EnvironmentSecretsDestroyResponse,
  EnvironmentSecretsReplaceValueRequest,
  EnvironmentSecretsReplaceValueResponse,
  EnvironmentSecretsRotationResponse,
  EnvironmentSecretsUndoRequest,
  EnvironmentSecretsUndoResponse,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import type { OpenLink } from "@/lib/links/open-link";
import {
  SECRET_RECOVERY_STEPS,
  SECRET_RESTART_LINE,
  SECRET_SAVED_OFFLINE,
} from "@/lib/sandboxes/secrets-page-copy";
import { RunnerHostContext } from "@/providers/runner-host-context";

const HOST_ID = "host-secrets";
const TYPED_VALUE = "sk_live_REPLACEMENT_VALUE_4d1e8b";

type Rotation = EnvironmentSecretsRotationResponse["rotation"];
type LiveRotation = NonNullable<Rotation>;

interface RotationHostState {
  secrets: EnvironmentSecret[];
  rotation: Rotation;
  versions: SecretVersion[];
  replaceAnswer: EnvironmentSecretsReplaceValueResponse;
  undoAnswer: EnvironmentSecretsUndoResponse;
  destroyAnswer: EnvironmentSecretsDestroyResponse;
}

interface RotationHost {
  readonly state: RotationHostState;
  readonly client: HostClient<HostRpcRegistry>;
  readonly reads: { list: number; rotation: number; versions: number };
  readonly replaceRequests: EnvironmentSecretsReplaceValueRequest[];
  readonly undoRequests: EnvironmentSecretsUndoRequest[];
  readonly destroyRequests: EnvironmentSecretsDestroyRequest[];
}

function secretFixture(
  overrides: Partial<EnvironmentSecret>,
): EnvironmentSecret {
  return {
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: "https",
    destinations: ["api.stripe.com"],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-3",
    revoked: false,
    updatedAt: 1,
    ...overrides,
  };
}

function versionFixture(overrides: Partial<SecretVersion>): SecretVersion {
  return {
    versionId: "ver-1",
    ordinal: 1,
    createdAt: Date.UTC(2026, 9, 1, 12),
    supersededAt: null,
    destroyedAt: null,
    current: false,
    rotationState: null,
    ...overrides,
  };
}

/** Version 3 is current, 2 was replaced, 1 was destroyed. */
function threeVersions(): SecretVersion[] {
  return [
    versionFixture({ versionId: "ver-3", ordinal: 3, current: true }),
    versionFixture({
      versionId: "ver-2",
      ordinal: 2,
      supersededAt: Date.UTC(2026, 9, 3, 12),
    }),
    versionFixture({
      versionId: "ver-1",
      ordinal: 1,
      supersededAt: Date.UTC(2026, 9, 2, 12),
      destroyedAt: Date.UTC(2026, 9, 4, 12),
    }),
  ];
}

function enforcingRotation(): LiveRotation {
  return {
    rotationId: "rot-1",
    fromVersionId: "ver-3",
    toVersionId: "ver-4",
    state: "enforcing",
    issuedAt: 1_791_000_000_000,
    producers: [
      {
        producer: "worker",
        workerClass: "https",
        incarnation: "inc-1",
        status: "missing",
        evidence: null,
      },
    ],
  };
}

function enforcedRotation(): LiveRotation {
  return {
    rotationId: "rot-1",
    fromVersionId: "ver-3",
    toVersionId: "ver-4",
    state: "enforced",
    issuedAt: 1_791_000_000_000,
    producers: [
      {
        producer: "worker",
        workerClass: "https",
        incarnation: "inc-1",
        status: "acknowledged",
        evidence: [{ kind: "session_closed", count: 3 }],
      },
      {
        producer: "host",
        hostId: "host-2",
        incarnation: "proc-1",
        status: "acknowledged",
        evidence: [{ kind: "cache_cleared", count: 1 }],
      },
    ],
  };
}

function buildRotationHost(
  overrides: Partial<RotationHostState>,
): RotationHost {
  const state: RotationHostState = {
    secrets: [secretFixture({})],
    rotation: null,
    versions: threeVersions(),
    replaceAnswer: {
      outcome: "accepted",
      rotationId: "rot-1",
      versionId: "ver-4",
    },
    undoAnswer: {
      outcome: "accepted",
      rotationId: "rot-2",
      versionId: "ver-2",
    },
    destroyAnswer: { outcome: "destroyed", destroyedAt: 1_791_000_000_000 },
    ...overrides,
  };
  const reads = { list: 0, rotation: 0, versions: 0 };
  const replaceRequests: EnvironmentSecretsReplaceValueRequest[] = [];
  const undoRequests: EnvironmentSecretsUndoRequest[] = [];
  const destroyRequests: EnvironmentSecretsDestroyRequest[] = [];
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.secrets.list": () => {
        reads.list += 1;
        return { removed: [], secrets: [...state.secrets] };
      },
      "environment.secrets.rotation": () => {
        reads.rotation += 1;
        return { rotation: state.rotation, lastVerify: null };
      },
      "environment.secrets.versions": () => {
        reads.versions += 1;
        return { versions: [...state.versions], removal: null };
      },
      "environment.secrets.replaceValue": (request) => {
        replaceRequests.push(request);
        if (state.replaceAnswer.outcome === "accepted") {
          const { versionId } = state.replaceAnswer;
          state.secrets = state.secrets.map((secret) =>
            secret.secretId === request.secretId
              ? { ...secret, currentVersionId: versionId }
              : secret,
          );
        }
        return state.replaceAnswer;
      },
      "environment.secrets.undo": (request) => {
        undoRequests.push(request);
        return state.undoAnswer;
      },
      "environment.secrets.destroy": (request) => {
        destroyRequests.push(request);
        return state.destroyAnswer;
      },
    },
  });
  return {
    state,
    client,
    reads,
    replaceRequests,
    undoRequests,
    destroyRequests,
  };
}

function renderPage(host: RotationHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider value={dashboardRunnerHost()}>
        <SecretsPage
          client={host.client}
          hostId={HOST_ID}
          hostName={(hostId) => (hostId === "host-2" ? "dev-box" : hostId)}
        />
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  openLinkMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  openLinkMock.mockReset();
});

function buttonOf(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("the element is not a button");
  }
  return element;
}

async function openReplaceDialog(): Promise<void> {
  fireEvent.click(await screen.findByTestId("secret-row-replace"));
  await screen.findByTestId("replace-secret-value");
}

async function typeAndReplace(): Promise<void> {
  await openReplaceDialog();
  fireEvent.change(screen.getByTestId("replace-secret-value"), {
    target: { value: TYPED_VALUE },
  });
  fireEvent.click(buttonOf(screen.getByTestId("replace-secret-confirm")));
}

async function openVersions(): Promise<HTMLElement[]> {
  fireEvent.click(await screen.findByTestId("secret-row-versions"));
  return screen.findAllByTestId("secret-version");
}

describe("the Replace dialog's copy", () => {
  it("says who holds the value and that running tools keep the old one", async () => {
    renderPage(buildRotationHost({ rotation: enforcingRotation() }));
    await openReplaceDialog();

    expect(screen.getByTestId("secret-replace-custody").textContent).toBe(
      "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it through the broker.",
    );
    expect(screen.getByTestId("secret-replace-restart").textContent).toBe(
      SECRET_RESTART_LINE,
    );
  });
});

describe("Remove", () => {
  it("previews what Remove does, with the current version, and names no web page", async () => {
    renderPage(buildRotationHost({ rotation: enforcingRotation() }));

    fireEvent.click(await screen.findByTestId("secret-row-remove"));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain("Current version 3.");
    });
    expect(dialog.textContent).toContain(
      "Came from unknown. Current version 3. Held on unknown. Tools already running keep it until they restart.",
    );
    expect(dialog.textContent).not.toMatch(/on the web|dashboard/i);
  });
});

describe("Replace value", () => {
  it("sends the typed value against the version the list showed, then shows the rotation and the restart line", async () => {
    const host = buildRotationHost({ rotation: enforcingRotation() });
    renderPage(host);

    await typeAndReplace();

    await waitFor(() => {
      expect(screen.queryByTestId("replace-secret-dialog")).toBeNull();
    });
    expect(host.replaceRequests).toEqual([
      {
        secretId: "sec-1",
        value: TYPED_VALUE,
        expectedVersionId: "ver-3",
        environmentId: null,
      },
    ]);
    const headline = await screen.findByTestId("secret-rotation-headline");
    expect(headline.textContent).toBe(
      "New value accepted, closing old sessions.",
    );
    expect(screen.getByTestId("secret-restart-line").textContent).toBe(
      SECRET_RESTART_LINE,
    );
    expect(
      screen
        .getAllByTestId("secret-rotation-producer")
        .map((line) => line.textContent),
    ).toEqual(["https: not confirmed yet"]);
  });

  it("says nothing of a restart before a value has been replaced", async () => {
    renderPage(buildRotationHost({}));

    await screen.findByTestId("secret-row");

    expect(screen.queryByTestId("secret-restart-line")).toBeNull();
    expect(screen.queryByTestId("secret-rotation-status")).toBeNull();
  });

  it("reads enforced with each producer's proof once the host says every one has proved it", async () => {
    const host = buildRotationHost({ rotation: enforcingRotation() });
    const queryClient = renderPage(host);
    await typeAndReplace();
    expect(
      (await screen.findByTestId("secret-rotation-headline")).textContent,
    ).toBe("New value accepted, closing old sessions.");

    host.state.rotation = enforcedRotation();
    await queryClient.invalidateQueries();

    await waitFor(() => {
      expect(screen.getByTestId("secret-rotation-headline").textContent).toBe(
        "New value enforced.",
      );
    });
    expect(
      screen
        .getAllByTestId("secret-rotation-producer")
        .map((line) => line.textContent),
    ).toEqual(["https: 3 sessions closed", "cached keys dropped on dev-box"]);
  });

  it("keeps saying accepted when the host reports enforced but a producer proved nothing", async () => {
    const host = buildRotationHost({ rotation: enforcingRotation() });
    const queryClient = renderPage(host);
    await typeAndReplace();
    await screen.findByTestId("secret-rotation-headline");

    const unproven: LiveRotation = {
      ...enforcedRotation(),
      producers: [
        {
          producer: "worker",
          workerClass: "https",
          incarnation: "inc-1",
          status: "acknowledged",
          evidence: [{ kind: "session_closed", count: 0 }],
        },
      ],
    };
    host.state.rotation = unproven;
    const readsBefore = host.reads.rotation;
    await queryClient.invalidateQueries();

    await waitFor(() => {
      expect(host.reads.rotation).toBeGreaterThan(readsBefore);
    });
    expect(screen.getByTestId("secret-rotation-headline").textContent).toBe(
      "New value accepted, closing old sessions.",
    );
  });

  it("asks to look again when the value was changed somewhere else, and re-reads the list", async () => {
    const host = buildRotationHost({
      replaceAnswer: {
        outcome: "stale",
        currentVersionId: "ver-9",
        changedBy: { kind: "dashboard" },
      },
    });
    renderPage(host);
    await screen.findByTestId("secret-row");
    const listReadsBefore = host.reads.list;

    await typeAndReplace();

    const note = await screen.findByTestId("replace-secret-note");
    expect(note.textContent).toBe(
      "Changed somewhere else just now. Look again before you replace it.",
    );
    expect(screen.getByTestId("replace-secret-dialog")).toBeTruthy();
    expect(screen.queryByTestId("secret-rotation-status")).toBeNull();
    expect(screen.queryByTestId("secret-restart-line")).toBeNull();
    await waitFor(() => {
      expect(host.reads.list).toBeGreaterThan(listReadsBefore);
    });
  });

  it("keeps the dialog and says the save is waiting when the host queued it", async () => {
    const host = buildRotationHost({
      replaceAnswer: { outcome: "pending", uploadId: "u1" },
    });
    renderPage(host);

    await typeAndReplace();

    expect((await screen.findByTestId("replace-secret-note")).textContent).toBe(
      SECRET_SAVED_OFFLINE,
    );
    expect(screen.queryByTestId("secret-restart-line")).toBeNull();
  });

  it("offers no Replace value on a revoked secret", async () => {
    renderPage(
      buildRotationHost({ secrets: [secretFixture({ revoked: true })] }),
    );

    await screen.findByTestId("secret-row");

    expect(screen.queryByTestId("secret-row-replace")).toBeNull();
    expect(screen.getByTestId("secret-row-versions")).toBeTruthy();
  });

  it("holds the typed value in no query or mutation cache", async () => {
    const host = buildRotationHost({ rotation: enforcingRotation() });
    const queryClient = renderPage(host);

    await typeAndReplace();
    await screen.findByTestId("secret-rotation-headline");
    await waitFor(() => {
      expect(screen.queryByTestId("replace-secret-dialog")).toBeNull();
    });

    const queries = queryClient.getQueryCache().getAll();
    const mutations = queryClient.getMutationCache().getAll();
    expect(queries.length).toBeGreaterThan(0);
    const cached = JSON.stringify([
      ...queries.map((query) => ({
        key: query.queryKey,
        state: query.state,
      })),
      ...mutations.map((mutation) => ({
        key: mutation.options.mutationKey,
        state: mutation.state,
      })),
    ]);
    expect(cached).not.toContain(TYPED_VALUE);

    // Closing dropped the typed value: the dialog opens empty.
    await openReplaceDialog();
    const input = screen.getByTestId("replace-secret-value");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("the value field is not an input");
    }
    expect(input.value).toBe("");
  });
});

describe("a secret's versions", () => {
  it("lists each version with its state, and offers Undo and Destroy only where they apply", async () => {
    renderPage(buildRotationHost({}));

    const rows = await openVersions();

    expect(rows.map((row) => row.getAttribute("data-version-state"))).toEqual([
      "current",
      "replaced",
      "destroyed",
    ]);
    expect(rows[0].textContent).toContain("Version 3");
    expect(within(rows[0]).queryByTestId("secret-version-undo")).toBeNull();
    expect(within(rows[0]).getByTestId("secret-version-destroy")).toBeTruthy();
    expect(within(rows[1]).getByTestId("secret-version-undo").textContent).toBe(
      "Undo",
    );
    expect(within(rows[1]).getByTestId("secret-version-destroy")).toBeTruthy();
    expect(within(rows[2]).queryByTestId("secret-version-undo")).toBeNull();
    expect(within(rows[2]).queryByTestId("secret-version-destroy")).toBeNull();
  });

  it("shows the recovery order in four steps", async () => {
    renderPage(buildRotationHost({}));
    await openVersions();

    const recovery = screen.getByTestId("secret-recovery");
    const steps = within(recovery).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      ...SECRET_RECOVERY_STEPS,
    ]);
    expect(steps).toHaveLength(4);
    expect(recovery.textContent).toContain("If this secret leaked");
  });

  it("undoes a replaced version without re-granting, and re-reads the list and versions", async () => {
    const host = buildRotationHost({});
    renderPage(host);
    const rows = await openVersions();
    const listReadsBefore = host.reads.list;
    const versionReadsBefore = host.reads.versions;

    fireEvent.click(within(rows[1]).getByTestId("secret-version-undo"));

    await waitFor(() => {
      expect(host.undoRequests).toEqual([
        {
          secretId: "sec-1",
          versionId: "ver-2",
          regrant: false,
          environmentId: null,
        },
      ]);
    });
    await waitFor(() => {
      expect(host.reads.list).toBeGreaterThan(listReadsBefore);
      expect(host.reads.versions).toBeGreaterThan(versionReadsBefore);
    });
  });

  it("restores a revoked secret's version with the re-grant, under the label Restore", async () => {
    const host = buildRotationHost({
      secrets: [secretFixture({ revoked: true })],
    });
    renderPage(host);
    const rows = await openVersions();

    const restore = within(rows[1]).getByTestId("secret-version-undo");
    expect(restore.textContent).toBe("Restore");
    fireEvent.click(restore);

    await waitFor(() => {
      expect(host.undoRequests).toEqual([
        {
          secretId: "sec-1",
          versionId: "ver-2",
          regrant: true,
          environmentId: null,
        },
      ]);
    });
  });

  it("says a destroyed value cannot be restored when the host refuses the undo", async () => {
    const host = buildRotationHost({
      undoAnswer: { outcome: "refused", code: "version_destroyed" },
    });
    renderPage(host);
    const rows = await openVersions();

    fireEvent.click(within(rows[1]).getByTestId("secret-version-undo"));

    expect(
      (await within(rows[1]).findByTestId("secret-version-note")).textContent,
    ).toBe("That value was destroyed, so it cannot be restored.");
  });

  it("asks before it destroys, then sends the destroy for that version", async () => {
    const host = buildRotationHost({});
    renderPage(host);
    const rows = await openVersions();

    fireEvent.click(within(rows[1]).getByTestId("secret-version-destroy"));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Destroy version 2 of STRIPE_KEY?");
    expect(host.destroyRequests).toEqual([]);

    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    await waitFor(() => {
      expect(host.destroyRequests).toEqual([
        { secretId: "sec-1", versionId: "ver-2", environmentId: null },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
  });

  it("sends nothing when the destroy is cancelled", async () => {
    const host = buildRotationHost({});
    renderPage(host);
    const rows = await openVersions();

    fireEvent.click(within(rows[1]).getByTestId("secret-version-destroy"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(host.destroyRequests).toEqual([]);
  });

  it("says the current value cannot be destroyed when the host refuses", async () => {
    const host = buildRotationHost({
      destroyAnswer: { outcome: "refused", code: "version_current" },
    });
    renderPage(host);
    const rows = await openVersions();

    fireEvent.click(within(rows[0]).getByTestId("secret-version-destroy"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(
      (await within(rows[0]).findByTestId("secret-version-note")).textContent,
    ).toBe("This is the current value. Replace or revoke it first.");
  });
});
