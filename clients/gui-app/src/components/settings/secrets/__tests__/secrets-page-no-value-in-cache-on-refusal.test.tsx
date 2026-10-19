// What a link asks the app to open. The page opens none here; the mock only
// keeps the real opener (which needs the app shell) out of the render.
const openLinkMock = vi.hoisted(() => vi.fn<OpenLink>());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentSecret,
  EnvironmentSecretsCreateRequest,
  EnvironmentSecretsCreateResponse,
  EnvironmentSecretsVerifyRequest,
  SecretVerifyResult,
} from "@traycer/protocol/host/environment-schemas";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import type { OpenLink } from "@/lib/links/open-link";
import { RunnerHostContext } from "@/providers/runner-host-context";

/**
 * The add dialog's typed value lives in the dialog's own state and is sent by a
 * direct request, so it reaches no query or mutation cache. The page suite
 * proves that on a successful create; this one proves it on the paths where
 * the value is typed, sent and then NOT saved: the host's own rejection, a
 * transport failure, and Verify answered accepted or refused.
 *
 * The value carries characters that JSON-escape (a quote and a backslash), so
 * a cache that held it in a serialised form still shows up under the escaped
 * spelling, and the base64 form is checked too.
 */

const HOST_ID = "host-secrets-refusal";
const TYPED_VALUE = 'p"ss\\w0rd-UNIQUE-7731';

interface SecretsHostState {
  verifyAnswer: SecretVerifyResult;
  createAnswer: EnvironmentSecretsCreateResponse;
  /** The create rejects with this. */
  createError: Error | null;
}

interface SecretsHost {
  readonly client: HostClient<HostRpcRegistry>;
  readonly verifyRequests: EnvironmentSecretsVerifyRequest[];
  readonly createRequests: EnvironmentSecretsCreateRequest[];
}

function createdSecret(): EnvironmentSecret {
  return {
    secretId: "sec-new",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: "https",
    destinations: ["api.stripe.com"],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-1",
    revoked: false,
    updatedAt: 1,
  };
}

function buildSecretsHost(overrides: Partial<SecretsHostState>): SecretsHost {
  const state: SecretsHostState = {
    verifyAnswer: { evidence: "probe_accepted" },
    createAnswer: { outcome: "created", secret: createdSecret() },
    createError: null,
    ...overrides,
  };
  const verifyRequests: EnvironmentSecretsVerifyRequest[] = [];
  const createRequests: EnvironmentSecretsCreateRequest[] = [];
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.secrets.list": () => ({ secrets: [] }),
      "environment.secrets.verify": (request) => {
        verifyRequests.push(request);
        return state.verifyAnswer;
      },
      "environment.secrets.create": (request) => {
        createRequests.push(request);
        if (state.createError !== null) throw state.createError;
        return state.createAnswer;
      },
    },
  });
  return { client, verifyRequests, createRequests };
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

function buttonOf(testId: string): HTMLButtonElement {
  const element = screen.getByTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`${testId} is not a button`);
  }
  return element;
}

function inputOf(testId: string): HTMLInputElement {
  const element = screen.getByTestId(testId);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`${testId} is not an input`);
  }
  return element;
}

async function openApiKeyForm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("secrets-add"));
  await screen.findByTestId("secret-kind-picker");
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

/** Everything the two caches hold, with each query's and mutation's own state. */
function cacheSnapshot(queryClient: QueryClient): string {
  const queries = queryClient.getQueryCache().getAll();
  const mutations = queryClient.getMutationCache().getAll();
  // The list read is a query, so the snapshot is never an empty string by
  // accident.
  expect(queries.length).toBeGreaterThan(0);
  return JSON.stringify([
    ...queries.map((query) => ({
      queryKey: query.queryKey,
      state: query.state,
    })),
    ...mutations.map((mutation) => ({
      mutationKey: mutation.options.mutationKey,
      state: mutation.state,
      variables: mutation.state.variables,
      meta: mutation.options.meta,
    })),
  ]);
}

function expectValueNowhere(snapshot: string): void {
  const escaped = JSON.stringify(TYPED_VALUE).slice(1, -1);
  const encoded = btoa(TYPED_VALUE);
  // The three spellings are three different strings, so each check below is
  // its own.
  expect(escaped).not.toBe(TYPED_VALUE);
  expect(encoded).not.toBe(TYPED_VALUE);
  expect(snapshot).not.toContain(TYPED_VALUE);
  expect(snapshot).not.toContain(escaped);
  expect(snapshot).not.toContain(encoded);
}

describe("the typed secret value stays out of every cache when nothing is saved", () => {
  it("keeps it out when the host rejects the create with its own words, and keeps it in the open dialog's input only", async () => {
    const host = buildSecretsHost({
      createError: new Error("A secret named STRIPE_KEY already exists."),
    });
    const queryClient = renderPage(host);
    await openApiKeyForm();
    fillApiKeyForm();
    fireEvent.click(buttonOf("secret-form-continue"));
    fireEvent.click(await screen.findByTestId("secret-save"));

    const note = await screen.findByTestId("secret-save-note");
    expect(note.textContent).toBe("A secret named STRIPE_KEY already exists.");
    // The host did receive the value, so the checks below are about a value
    // that was really sent.
    expect(host.createRequests).toHaveLength(1);
    expect(host.createRequests[0].value).toBe(TYPED_VALUE);
    expectValueNowhere(cacheSnapshot(queryClient));

    const dialog = screen.getByTestId("add-secret-dialog");
    expect(dialog.textContent).not.toContain(TYPED_VALUE);

    // Back to the form: the dialog still holds what was typed, in its input.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(inputOf("secret-form-value").value).toBe(TYPED_VALUE);
    expectValueNowhere(cacheSnapshot(queryClient));
  });

  it("keeps it out when the create fails in transport", async () => {
    const host = buildSecretsHost({
      createError: new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "Lost the connection to this computer.",
        requestId: "req-lost",
        method: "environment.secrets.create",
        fatalDetails: null,
      }),
    });
    const queryClient = renderPage(host);
    await openApiKeyForm();
    fillApiKeyForm();
    fireEvent.click(buttonOf("secret-form-continue"));
    fireEvent.click(await screen.findByTestId("secret-save"));

    const note = await screen.findByTestId("secret-save-note");
    expect(note.textContent).toBe("Lost the connection to this computer.");
    expect(host.createRequests).toHaveLength(1);
    expect(host.createRequests[0].value).toBe(TYPED_VALUE);
    expectValueNowhere(cacheSnapshot(queryClient));
    expect(screen.getByTestId("add-secret-dialog").textContent).not.toContain(
      TYPED_VALUE,
    );
  });

  it("keeps it out when Verify in the dialog is answered accepted", async () => {
    const host = buildSecretsHost({
      verifyAnswer: { evidence: "probe_accepted" },
    });
    const queryClient = renderPage(host);
    await openApiKeyForm();
    fillApiKeyForm();

    fireEvent.click(buttonOf("secret-form-verify"));

    const line = await screen.findByTestId("secret-form-verify-line");
    expect(line.textContent).toBe(
      "Reached the destination. The key is checked the first time an agent uses it.",
    );
    expect(host.verifyRequests).toHaveLength(1);
    const request = host.verifyRequests[0];
    expect(request.target).toBe("candidate");
    expect(request).toMatchObject({ target: "candidate", value: TYPED_VALUE });
    expect(host.createRequests).toEqual([]);
    expectValueNowhere(cacheSnapshot(queryClient));
    expect(inputOf("secret-form-value").value).toBe(TYPED_VALUE);
  });

  it("keeps it out when Verify in the dialog is answered with a login refusal", async () => {
    const host = buildSecretsHost({
      verifyAnswer: { evidence: "probe_refused", hop: "login" },
    });
    const queryClient = renderPage(host);
    await openApiKeyForm();
    fillApiKeyForm();

    fireEvent.click(buttonOf("secret-form-verify"));

    const line = await screen.findByTestId("secret-form-verify-line");
    expect(line.textContent).toBe(
      "The server refused the login. Check the login and value above.",
    );
    expect(host.verifyRequests).toHaveLength(1);
    expect(host.verifyRequests[0]).toMatchObject({
      target: "candidate",
      value: TYPED_VALUE,
    });
    expect(host.createRequests).toEqual([]);
    expectValueNowhere(cacheSnapshot(queryClient));
    expect(inputOf("secret-form-value").value).toBe(TYPED_VALUE);
  });
});
