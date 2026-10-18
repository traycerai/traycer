// What a link asks the app to open. The call is awaited with `.catch`, so it
// answers a promise.
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
  EnvironmentSecretsCreateRequest,
  EnvironmentSecretsCreateResponse,
  EnvironmentSecretsVerifyRequest,
  SecretVerifyResult,
} from "@traycer/protocol/host/environment-schemas";
import {
  DASHBOARD_ORIGIN,
  dashboardRunnerHost,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import type { OpenLink } from "@/lib/links/open-link";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import {
  SECRETS_EMPTY_TEXT,
  SECRET_READABLE_WHERE,
  SECRET_REVOKED_LABEL,
} from "@/lib/sandboxes/secrets-page-copy";
import { RunnerHostContext } from "@/providers/runner-host-context";

const HOST_ID = "host-secrets";
const TYPED_VALUE = "sk_live_TYPED_VALUE_9f3a7c";

interface SecretsHostState {
  secrets: EnvironmentSecret[];
  /** The list read rejects with this. */
  listError: Error | null;
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
    listError: null,
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
      "environment.secrets.list": () => {
        reads.list += 1;
        if (state.listError !== null) throw state.listError;
        return { secrets: [...state.secrets] };
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
  openLinkMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  openLinkMock.mockReset();
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
  it("shows one row per secret, each live row saying where its value is readable", async () => {
    const host = buildSecretsHost({
      secrets: [
        secretFixture({ secretId: "sec-1", name: "STRIPE_KEY" }),
        secretFixture({
          secretId: "sec-2",
          name: "PROD_DB",
          kind: "database",
          protocol: "postgres",
          destinations: ["db.example.com"],
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
    expect(rows[0].textContent).toContain(SECRET_READABLE_WHERE);
    expect(rows[0].textContent).toContain("API key or token");
    expect(rows[0].textContent).toContain("HTTPS");
    expect(rows[0].textContent).toContain("api.stripe.com");
    expect(rows[1].textContent).toContain(SECRET_READABLE_WHERE);
    expect(rows[1].textContent).toContain("Database login");
    expect(rows[1].textContent).toContain("PostgreSQL");
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
  });

  it("marks a revoked secret and offers no Verify on it", async () => {
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
    expect(within(live).getByTestId("secret-row-verify")).toBeTruthy();
    expect(revoked.textContent).toContain(SECRET_REVOKED_LABEL);
    expect(within(revoked).queryByTestId("secret-row-verify")).toBeNull();
    expect(live.textContent).not.toContain(SECRET_REVOKED_LABEL);
  });

  it("says what secrets are when there are none", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));

    const empty = await screen.findByTestId("secrets-empty");
    expect(empty.textContent).toBe(SECRETS_EMPTY_TEXT);
    expect(screen.queryByTestId("secret-row")).toBeNull();
    expect(screen.getByTestId("secrets-add")).toBeTruthy();
  });

  it("shows the host's own words when the list cannot be read", async () => {
    renderPage(
      buildSecretsHost({ listError: new Error("Connect to manage secrets.") }),
    );

    const error = await screen.findByTestId("secrets-page-error");
    expect(error.textContent).toContain("Connect to manage secrets.");
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    expect(screen.queryByTestId("secrets-add")).toBeNull();
  });
});

describe("a row's Verify", () => {
  it("probes the secret by id and names the setting when the port is wrong", async () => {
    const host = buildSecretsHost({
      secrets: [secretFixture({ secretId: "sec-1" })],
      verifyAnswer: { evidence: "probe_refused", hop: "port" },
    });
    renderPage(host);

    fireEvent.click(await screen.findByTestId("secret-row-verify"));

    const line = await screen.findByTestId("secret-verify-line");
    expect(line.textContent).toBe(
      "Nothing answered on that port. Check the port this secret is set to.",
    );
    expect(host.verifyRequests).toEqual([
      { target: "secret", secretId: "sec-1" },
    ]);
  });

  it("says an accepted HTTPS probe reached the destination", async () => {
    const host = buildSecretsHost({
      secrets: [secretFixture({ secretId: "sec-1" })],
    });
    renderPage(host);

    fireEvent.click(await screen.findByTestId("secret-row-verify"));

    expect((await screen.findByTestId("secret-verify-line")).textContent).toBe(
      "Reached the destination. The key is checked the first time an agent uses it.",
    );
  });
});

describe("the add dialog's kind picker", () => {
  it("greys the kinds no protocol of which is brokered, with the table's line", async () => {
    renderPage(buildSecretsHost({ secrets: [] }));
    await openAddDialog();

    for (const kind of ["broker", "mail", "rdp"]) {
      const option = buttonOf(`secret-kind-option-${kind}`);
      expect(option.disabled, kind).toBe(true);
      expect(option.getAttribute("data-unsupported"), kind).toBe("true");
      expect(option.textContent, kind).toContain("is not brokered in v1.");
    }
    expect(buttonOf("secret-kind-option-mail").textContent).toContain(
      "Mail (SMTP, IMAP and POP3) is not brokered in v1.",
    );
    for (const kind of ["api_key", "database", "provider", "ssh", "aws"]) {
      const option = buttonOf(`secret-kind-option-${kind}`);
      expect(option.disabled, kind).toBe(false);
      expect(option.getAttribute("data-unsupported"), kind).toBeNull();
    }
  });

  it("opens the dashboard's add dialog for a kind set up on the web, and closes", async () => {
    const host = buildSecretsHost({ secrets: [] });
    renderPage(host);
    await openAddDialog();

    fireEvent.click(screen.getByTestId("secret-kind-option-ssh"));

    await waitFor(() => {
      expect(openLinkMock).toHaveBeenCalledTimes(1);
    });
    const [url, kind, event] = openLinkMock.mock.calls[0];
    expect(url).toBe(
      `${DASHBOARD_ORIGIN}/environments/personal/secrets?add=ssh`,
    );
    expect(url).toContain("?add=ssh");
    expect(kind).toBe("account");
    expect(event).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    });
    expect(host.createRequests).toEqual([]);
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
    expect(confirmation.textContent).toContain("STRIPE_KEY");
    expect(confirmation.textContent).toContain(
      "plain value on every host you own",
    );
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
