const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

// The page names its environment through the surface's client and the viewer.
const hostBoundary = vi.hoisted((): { client: unknown } => ({ client: null }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostBoundary.client,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

// The computers holding a copy are covered by `secret-remove-preview-computers`;
// here Remove's preview is read with none.
vi.mock("@/components/settings/personal/use-personal-computers", () => ({
  usePersonalComputers: () => ({
    computers: [],
    statuses: new Map(),
    versions: new Map(),
    participants: [],
  }),
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
  EnvironmentSecretsCreateRequest,
  EnvironmentSecretsCreateResponse,
  EnvironmentSecretsVerifyRequest,
  SecretVerifyResult,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import { SECRET_REVOKED_LABEL } from "@/lib/sandboxes/secrets-page-copy";
import { dataHandlingNoticeText } from "@/components/settings/members/data-handling-notice-text";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const HOST_ID = "host-secrets";
const TYPED_VALUE = "sk_live_TYPED_VALUE_9f3a7c";
const PERSONAL_ENV = "env-personal";
const ADDED_AT = Date.UTC(2026, 9, 24, 9, 30);

/** The day and month a row names, as the page formats them. */
function dayMonth(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(at);
}

interface SecretsHostState {
  secrets: EnvironmentSecret[];
  /** What `environment.secrets.versions` answers for any secret. */
  versions: SecretVersion[];
  /** The list read rejects with this. */
  listError: Error | null;
  /** `environment.list` rejects with this. */
  environmentsError: Error | null;
  verifyAnswer: SecretVerifyResult;
  createAnswer: EnvironmentSecretsCreateResponse;
  /** The create rejects with this. */
  createError: Error | null;
  /** The create waits for this to settle before it answers. */
  createHold: Promise<void> | null;
}

interface SecretsHost {
  readonly state: SecretsHostState;
  readonly client: HostClient<HostRpcRegistry>;
  readonly reads: { list: number };
  readonly verifyRequests: EnvironmentSecretsVerifyRequest[];
  readonly createRequests: EnvironmentSecretsCreateRequest[];
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
    currentVersionId: "ver-1",
    revoked: false,
    updatedAt: 1,
    ...overrides,
  };
}

function buildSecretsHost(overrides: Partial<SecretsHostState>): SecretsHost {
  const state: SecretsHostState = {
    secrets: [],
    versions: [
      {
        versionId: "ver-1",
        ordinal: 1,
        createdAt: ADDED_AT,
        supersededAt: null,
        destroyedAt: null,
        current: true,
        rotationState: null,
      },
    ],
    listError: null,
    environmentsError: null,
    verifyAnswer: { evidence: "probe_accepted" },
    createAnswer: {
      outcome: "created",
      secret: secretFixture({ secretId: "sec-new" }),
    },
    createError: null,
    createHold: null,
    ...overrides,
  };
  const reads = { list: 0 };
  const verifyRequests: EnvironmentSecretsVerifyRequest[] = [];
  const createRequests: EnvironmentSecretsCreateRequest[] = [];
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.list": () => {
        if (state.environmentsError !== null) throw state.environmentsError;
        return {
          environments: [
            {
              environmentId: PERSONAL_ENV,
              ownerKind: "user" as const,
              ownerId: "user-me",
              roomId: "room-personal",
              label: "Personal",
              effectiveRole: "owner" as const,
              kind: "personal" as const,
              hostCount: 1,
              providerHandle: null,
            },
          ],
        };
      },
      "environment.secrets.versions": () => ({
        versions: [...state.versions],
        removal: null,
      }),
      "environment.secrets.rotation": () => ({
        rotation: null,
        lastVerify: null,
      }),
      "environment.history": () => ({
        readerScope: "full" as const,
        entries: [],
        hostStates: [],
      }),
      "environment.secrets.list": () => {
        reads.list += 1;
        if (state.listError !== null) throw state.listError;
        return { removed: [], secrets: [...state.secrets] };
      },
      "environment.secrets.verify": (request) => {
        verifyRequests.push(request);
        return state.verifyAnswer;
      },
      "environment.secrets.create": async (request) => {
        createRequests.push(request);
        if (state.createHold !== null) await state.createHold;
        if (state.createError !== null) throw state.createError;
        return state.createAnswer;
      },
    },
  });
  return { state, client, reads, verifyRequests, createRequests };
}

function renderPage(host: SecretsHost): QueryClient {
  hostBoundary.client = host.client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider value={dashboardRunnerHost()}>
        <SecretsPage
          client={host.client}
          hostId={HOST_ID}
          hostName={() => "dev-box"}
        />
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  useAuthStore.setState({ status: "signed-in" });
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  cleanup();
  hostBoundary.client = null;
  navigateToSettingsSectionMock.mockReset();
  useAuthStore.setState({ status: "signed-out" });
});

async function openAddDialog(): Promise<void> {
  fireEvent.click(await screen.findByTestId("secrets-add"));
  await screen.findByTestId("secret-kind-picker");
}

async function openApiKeyForm(): Promise<void> {
  await openAddDialog();
  fireEvent.click(screen.getByTestId("secret-kind-option-api_key"));
  await screen.findByTestId("secret-form-name");
}

function fillApiKeyForm(): void {
  fireEvent.change(screen.getByTestId("secret-form-name"), {
    target: { value: "STRIPE_KEY" },
  });
  fireEvent.change(screen.getByTestId("secret-form-hosts"), {
    target: { value: "api.stripe.com" },
  });
  fireEvent.change(screen.getByTestId("secret-form-value"), {
    target: { value: TYPED_VALUE },
  });
}

/** Opens a row's Details and waits for the secret's own controls. */
async function openRowDetails(row: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(within(row).getByRole("button", { name: "Details" }));
  return screen.findByTestId("secret-details-controls");
}

function buttonOf(testId: string): HTMLButtonElement {
  const element = screen.getByTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`${testId} is not a button`);
  }
  return element;
}

async function saveApiKey(): Promise<void> {
  await openApiKeyForm();
  fillApiKeyForm();
  fireEvent.click(buttonOf("secret-form-continue"));
  fireEvent.click(await screen.findByTestId("secret-save"));
}

describe("the secrets list", () => {
  it("shows one row per secret as one line, with Replace, Remove and Details", async () => {
    const host = buildSecretsHost({
      secrets: [
        secretFixture({ secretId: "sec-1", name: "STRIPE_KEY" }),
        secretFixture({
          secretId: "sec-2",
          name: "PROD_DB",
          kind: "database",
          protocol: "postgres",
          destinations: ["db.example.com", "db2.example.com"],
        }),
        secretFixture({ secretId: "sec-3", name: "OLD_KEY", revoked: true }),
      ],
    });
    renderPage(host);

    const rows = await screen.findAllByTestId("secret-row");
    expect(rows.map((row) => row.getAttribute("data-secret-name"))).toEqual([
      "STRIPE_KEY",
      "PROD_DB",
      "OLD_KEY",
    ]);
    const added = dayMonth(ADDED_AT);
    await waitFor(() => {
      expect(within(rows[0]).getByTestId("secret-row-line").textContent).toBe(
        `STRIPE_KEY · Set · sent to api.stripe.com · added by you ${added}`,
      );
    });
    expect(within(rows[1]).getByTestId("secret-row-line").textContent).toBe(
      `PROD_DB · Set · sent to db.example.com, db2.example.com · added by you ${added}`,
    );
    for (const row of rows) {
      expect(row.textContent).not.toContain("Written as a plain value");
      expect(within(row).queryByTestId("secret-row-verify")).toBeNull();
      expect(within(row).queryByTestId("secret-row-versions")).toBeNull();
      expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();
    }
    expect(
      within(rows[0])
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Replace", "Remove", "Details"]);
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
  });

  it("says replaced, not added, once the current version is a replacement", async () => {
    renderPage(
      buildSecretsHost({
        secrets: [secretFixture({})],
        versions: [
          {
            versionId: "ver-2",
            ordinal: 2,
            createdAt: ADDED_AT,
            supersededAt: null,
            destroyedAt: null,
            current: true,
            rotationState: null,
          },
        ],
      }),
    );

    const line = await screen.findByTestId("secret-row-line");
    await waitFor(() => {
      expect(line.textContent).toBe(
        `STRIPE_KEY · Set · sent to api.stripe.com · replaced by you ${dayMonth(ADDED_AT)}`,
      );
    });
  });

  it("leaves out the added clause while the versions are unread", async () => {
    const host = buildSecretsHost({ secrets: [secretFixture({})] });
    host.state.versions = [];
    renderPage(host);

    const line = await screen.findByTestId("secret-row-line");
    expect(line.textContent).toBe("STRIPE_KEY · Set · sent to api.stripe.com");
  });

  it("marks a revoked secret, and its Details offers no Verify", async () => {
    const host = buildSecretsHost({
      secrets: [
        secretFixture({ secretId: "sec-1", name: "STRIPE_KEY" }),
        secretFixture({ secretId: "sec-3", name: "OLD_KEY", revoked: true }),
      ],
    });
    renderPage(host);

    const rows = await screen.findAllByTestId("secret-row");
    const live = rows[0];
    const revoked = rows[1];
    expect(revoked.textContent).toContain(SECRET_REVOKED_LABEL);
    expect(live.textContent).not.toContain(SECRET_REVOKED_LABEL);

    const liveControls = await openRowDetails(live);
    expect(within(liveControls).getByTestId("secret-row-verify")).toBeTruthy();
    cleanup();

    renderPage(host);
    const again = await screen.findAllByTestId("secret-row");
    const revokedControls = await openRowDetails(again[1]);
    expect(
      within(revokedControls).queryByTestId("secret-row-verify"),
    ).toBeNull();
  });

  it("says what secrets are when there are none", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));

    const empty = await screen.findByTestId("secrets-empty");
    expect(empty.textContent).toBe(
      "Values and logins your agents use. On your computers they are set as values; on sandboxes agents use them without seeing them.",
    );
    expect(screen.queryByTestId("secret-row")).toBeNull();
    expect(screen.getByTestId("secrets-add")).toBeTruthy();
  });

  it("drops the rows it already showed when a later read fails, rather than keeping them beside the failure", async () => {
    const host = buildSecretsHost({ secrets: [secretFixture({})] });
    const queryClient = renderPage(host);
    await screen.findByTestId("secret-row");

    host.state.listError = new Error("Connect to manage secrets.");
    await queryClient.invalidateQueries();

    expect(await screen.findByTestId("secrets-page-error")).toBeTruthy();
    expect(screen.queryByTestId("secret-row")).toBeNull();
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
  });

  it("reads a failed list as Personal's one failure line with Retry, never the empty state", async () => {
    const host = buildSecretsHost({
      secrets: [secretFixture({})],
      listError: new Error("Connect to manage secrets."),
    });
    renderPage(host);

    const error = await screen.findByTestId("secrets-page-error");
    expect(error.textContent).toContain("Couldn't read Personal's secrets.");
    expect(error.textContent).not.toContain("Connect to manage secrets.");
    expect(within(error).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    expect(screen.queryByTestId("secret-row")).toBeNull();
    expect(screen.queryByTestId("secrets-add")).toBeNull();

    host.state.listError = null;
    fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("secret-row")).toBeTruthy();
    expect(screen.queryByTestId("secrets-page-error")).toBeNull();
  });
});

describe("a row's Verify", () => {
  it("probes the secret by id and names the setting when the port is wrong", async () => {
    const host = buildSecretsHost({
      secrets: [secretFixture({ secretId: "sec-1" })],
      verifyAnswer: { evidence: "probe_refused", hop: "port" },
    });
    renderPage(host);

    const controls = await openRowDetails(
      await screen.findByTestId("secret-row"),
    );
    fireEvent.click(within(controls).getByTestId("secret-row-verify"));

    const line = await screen.findByTestId("secret-verify-line");
    expect(line.textContent).toBe(
      "Nothing answered on that port. Check the port this secret is set to.",
    );
    expect(host.verifyRequests).toEqual([
      { target: "secret", secretId: "sec-1", environmentId: PERSONAL_ENV },
    ]);
  });

  it("says an accepted HTTPS probe reached the destination", async () => {
    const host = buildSecretsHost({
      secrets: [secretFixture({ secretId: "sec-1" })],
    });
    renderPage(host);

    const controls = await openRowDetails(
      await screen.findByTestId("secret-row"),
    );
    fireEvent.click(within(controls).getByTestId("secret-row-verify"));

    expect((await screen.findByTestId("secret-verify-line")).textContent).toBe(
      "Reached the destination. The key is checked the first time an agent uses it.",
    );
  });
});

describe("a row's Details on a Local pick", () => {
  it("keeps Verify and the versions when the environment list cannot be read", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: HOST_ID, hostName: "dev-box" },
    });
    const host = buildSecretsHost({
      secrets: [secretFixture({ secretId: "sec-1" })],
      environmentsError: new Error("environment list unavailable"),
    });
    renderPage(host);

    const row = await screen.findByTestId("secret-row");
    fireEvent.click(
      await within(row).findByRole("button", { name: "Details" }),
    );
    const controls = await screen.findByTestId("secret-details-controls");
    expect(await within(controls).findByTestId("secret-versions")).toBeTruthy();
    fireEvent.click(within(controls).getByTestId("secret-row-verify"));

    expect((await screen.findByTestId("secret-verify-line")).textContent).toBe(
      "Reached the destination. The key is checked the first time an agent uses it.",
    );
    expect(host.verifyRequests).toEqual([
      { target: "secret", secretId: "sec-1", environmentId: null },
    ]);
  });
});

describe("the add dialog's kind picker", () => {
  it("offers only the API key and database kinds, and points provider keys to Providers", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openAddDialog();

    const picker = screen.getByTestId("secret-kind-picker");
    const offered = within(picker)
      .getAllByRole("button")
      .map((option) => option.getAttribute("data-testid"));
    expect(offered.sort()).toEqual([
      "secret-kind-option-api_key",
      "secret-kind-option-database",
    ]);
    expect(screen.queryByText("Model provider API key")).toBeNull();
    for (const kind of ["provider", "ssh", "aws", "broker", "mail", "rdp"]) {
      expect(
        screen.queryByTestId(`secret-kind-option-${kind}`),
        kind,
      ).toBeNull();
    }
    expect(screen.getByTestId("secret-provider-keys-line").textContent).toBe(
      "Provider keys are set on each provider's Account tab, under Providers.",
    );
  });

  it("closes the dialog and opens the Providers page from the provider-keys line", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openAddDialog();

    fireEvent.click(screen.getByTestId("secret-provider-keys-link"));

    expect(navigateToSettingsSectionMock).toHaveBeenCalledTimes(1);
    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("providers");
    await waitFor(() => {
      expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    });
  });

  it("says who holds the value on the form, and the add dialog names no web handoff", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openApiKeyForm();

    expect(screen.getByTestId("secret-custody-sentence").textContent).toBe(
      "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.",
    );
    expect(screen.getByTestId("add-secret-dialog").textContent).not.toMatch(
      /on the web|dashboard/i,
    );
  });

  it("opens a database form on PostgreSQL with the plaintext notice", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openAddDialog();

    fireEvent.click(screen.getByTestId("secret-kind-option-database"));

    const port = await screen.findByTestId("secret-form-port");
    if (!(port instanceof HTMLInputElement)) {
      throw new Error("the port field is not an input");
    }
    expect(port.value).toBe("5432");
    const consent = screen.getByTestId("secret-form-consent");
    expect(consent.textContent).toContain("pass through Traycer's gateway");
    expect(consent.textContent).toContain("38 of 100");
  });
});

describe("Verify in the add dialog", () => {
  it("is held until the destination and the value are filled", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openApiKeyForm();

    expect(buttonOf("secret-form-verify").disabled).toBe(true);
    expect(buttonOf("secret-form-continue").disabled).toBe(true);
    expect(screen.getByTestId("secret-form-problem").textContent).toBe(
      "The name is capital letters, digits and underscores, starting with a letter.",
    );
  });

  it("sends the candidate with the typed value and names the port setting above", async () => {
    const host = buildSecretsHost({
      secrets: [],
      verifyAnswer: { evidence: "probe_refused", hop: "port" },
    });
    renderPage(host);
    await openApiKeyForm();
    fillApiKeyForm();

    fireEvent.click(buttonOf("secret-form-verify"));

    const line = await screen.findByTestId("secret-form-verify-line");
    expect(line.textContent).toBe(
      "Nothing answered on that port. Check the port above.",
    );
    expect(host.verifyRequests).toHaveLength(1);
    const request = host.verifyRequests[0];
    expect(request.target).toBe("candidate");
    expect(request).toMatchObject({
      target: "candidate",
      kind: "api_key",
      protocol: "https",
      hosts: ["api.stripe.com"],
      port: null,
      value: TYPED_VALUE,
    });
    expect("name" in request).toBe(false);
  });
});

describe("saving a secret", () => {
  it("confirms where the value becomes readable, creates it, closes and re-reads the list", async () => {
    const host = buildSecretsHost({ secrets: [] });
    const queryClient = renderPage(host);
    await openApiKeyForm();
    fillApiKeyForm();

    fireEvent.click(buttonOf("secret-form-continue"));

    const confirmation = await screen.findByTestId("secret-save-confirmation");
    // The custody sentence and its disclosure, and nothing else before Save.
    expect(confirmation.textContent).toBe(
      "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.How Traycer handles this",
    );
    expect(confirmation.textContent).not.toContain("plain value");
    expect(host.createRequests).toEqual([]);
    expect(host.reads.list).toBe(1);

    fireEvent.click(screen.getByTestId("secret-save"));

    await waitFor(() => {
      expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    });
    expect(host.createRequests).toEqual([
      {
        name: "STRIPE_KEY",
        kind: "api_key",
        protocol: "https",
        hosts: ["api.stripe.com"],
        port: null,
        identity: null,
        database: null,
        policy: null,
        tlsPolicy: null,
        pinnedHostKeys: null,
        connectorId: null,
        confirmedAddresses: null,
        value: TYPED_VALUE,
        mode: "brokered",
        portOverride: false,
        swapSites: ["header"],
        variables: [],
        exportPolicy: null,
        sandboxesByDefault: true,
        plaintextConsent: null,
        environmentId: PERSONAL_ENV,
      },
    ]);
    await waitFor(() => {
      expect(host.reads.list).toBe(2);
    });

    // The typed value reached no query or mutation cache.
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

    // Closing dropped the form: the dialog opens at the picker again.
    fireEvent.click(await screen.findByTestId("secrets-add"));
    expect(await screen.findByTestId("secret-kind-picker")).toBeTruthy();
    expect(screen.queryByTestId("secret-form-value")).toBeNull();
  });

  it("a stale completion of a closed save does not close the reopened form", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = buildSecretsHost({ secrets: [], createHold: hold });
    renderPage(host);
    await saveApiKey();
    await waitFor(() => {
      expect(host.createRequests).toHaveLength(1);
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    });
    await openApiKeyForm();
    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();

    release();
    await waitFor(() => {
      expect(host.reads.list).toBe(2);
    });

    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();
  });

  it("shows the host's own words when the create is rejected, and keeps the dialog", async () => {
    const host = buildSecretsHost({
      secrets: [],
      createError: new Error("A secret named STRIPE_KEY already exists."),
    });
    renderPage(host);

    await saveApiKey();

    const note = await screen.findByTestId("secret-save-note");
    expect(note.textContent).toBe("A secret named STRIPE_KEY already exists.");
    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();
    expect(screen.getByTestId("secret-save")).toBeTruthy();
    expect(screen.queryByTestId("secret-save-done")).toBeNull();
    expect(host.reads.list).toBe(1);
  });

  it("says why a team's secret is refused, with the refusal line", async () => {
    const host = buildSecretsHost({
      secrets: [],
      createAnswer: { outcome: "refused", code: "team_secrets_are_brokered" },
    });
    renderPage(host);

    await saveApiKey();

    const line = secretChangeRefusalLine("create", "team_secrets_are_brokered");
    expect(line).not.toBeNull();
    const note = await screen.findByTestId("secret-save-note");
    expect(note.textContent).toBe(line);
    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();
    // A refusal saved nothing, so there is nothing to re-read.
    expect(host.reads.list).toBe(1);
  });

  it("says to use the provider's key variable when the name is not a provider's", async () => {
    const host = buildSecretsHost({
      secrets: [],
      createAnswer: { outcome: "refused", code: "provider_name_unknown" },
    });
    renderPage(host);

    await saveApiKey();

    const note = await screen.findByTestId("secret-save-note");
    expect(note.textContent).toBe(
      "Use its provider's key variable as the name.",
    );
    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();
    expect(host.reads.list).toBe(1);
  });

  it("says a code it has no line for with a plain failure line", async () => {
    const host = buildSecretsHost({
      secrets: [],
      createAnswer: { outcome: "refused", code: "a_code_from_a_newer_host" },
    });
    renderPage(host);

    await saveApiKey();

    expect((await screen.findByTestId("secret-save-note")).textContent).toBe(
      "Couldn't save this secret.",
    );
  });

  it("offers only Done once a save is waiting to reach the account, and re-reads the list", async () => {
    const host = buildSecretsHost({
      secrets: [],
      createAnswer: { outcome: "pending", uploadId: "u1" },
    });
    renderPage(host);

    await saveApiKey();

    const note = await screen.findByTestId("secret-save-note");
    expect(note.textContent).toBe(
      "Saved. It reaches your account when this computer is connected.",
    );
    // One more Save would be a second secret.
    expect(screen.queryByTestId("secret-save")).toBeNull();
    const done = await screen.findByTestId("secret-save-done");
    expect(host.createRequests).toHaveLength(1);
    await waitFor(() => {
      expect(host.reads.list).toBe(2);
    });

    fireEvent.click(done);

    await waitFor(() => {
      expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    });
    expect(host.createRequests).toHaveLength(1);
  });
});

describe("the add form's words", () => {
  it("labels the host field Server address with where the key is sent", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openApiKeyForm();

    expect(screen.getByLabelText("Server address")).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(
      screen.getByText(
        "Where this key is sent, e.g. api.stripe.com. Separate several with commas.",
      ),
    ).toBeTruthy();
  });

  it("uses the short hint on a database login's server address", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openAddDialog();
    fireEvent.click(screen.getByTestId("secret-kind-option-database"));

    await screen.findByLabelText("Server address");
    expect(screen.getByText("Separate several with commas.")).toBeTruthy();
    expect(screen.queryByText(/Where this key is sent/)).toBeNull();
  });

  it("says in plain words what each mode does, and warns only on the one that exposes the value", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openApiKeyForm();

    const dialog = screen.getByTestId("add-secret-dialog");
    expect(
      within(dialog).getByLabelText(
        "Agents use it without seeing it (recommended)",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText("Agents can read it")).toBeTruthy();
    expect(dialog.textContent).toContain(
      "On a sandbox, any process can read it, and revoking it does not stop a copy already made.",
    );
    expect(dialog.textContent).not.toContain(
      "agents can use it and never read it",
    );
    expect(dialog.textContent).not.toMatch(/Broker/i);
  });

  it("offers How Traycer handles this on the form and on the confirmation", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openApiKeyForm();
    fillApiKeyForm();

    fireEvent.click(screen.getByTestId("members-data-handling-trigger"));
    expect(screen.getByTestId("members-data-handling-notice").textContent).toBe(
      dataHandlingNoticeText(),
    );

    fireEvent.click(buttonOf("secret-form-continue"));
    const confirmation = await screen.findByTestId("secret-save-confirmation");
    expect(
      within(confirmation).getByTestId("members-data-handling-trigger"),
    ).toBeTruthy();
  });

  it("names the server address typed when the host cannot find it", async () => {
    const host = buildSecretsHost({
      secrets: [],
      createAnswer: { outcome: "refused", code: "destination_unresolvable" },
    });
    renderPage(host);
    await openApiKeyForm();
    fireEvent.change(screen.getByTestId("secret-form-name"), {
      target: { value: "STRIPE_KEY" },
    });
    fireEvent.change(screen.getByTestId("secret-form-hosts"), {
      target: { value: "api.example.com, api2.example.com" },
    });
    fireEvent.change(screen.getByTestId("secret-form-value"), {
      target: { value: TYPED_VALUE },
    });
    fireEvent.click(buttonOf("secret-form-continue"));
    fireEvent.click(await screen.findByTestId("secret-save"));

    const note = await screen.findByTestId("secret-save-note");
    expect(note.textContent).toBe(
      "Couldn't reach api.example.com, api2.example.com. Check the server address, then save again.",
    );
    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();
  });
});
