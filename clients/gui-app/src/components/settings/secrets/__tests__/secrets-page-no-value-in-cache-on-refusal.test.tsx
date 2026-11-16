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
  EnvironmentSecretV12,
  EnvironmentSecretsCreateRequest,
  EnvironmentSecretsVerifyRequest,
  SecretVerifyResult,
} from "@traycer/protocol/host/environment-schemas";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import {
  buildEnvironmentClient,
  type EnvironmentClientFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { OpenLink } from "@/lib/links/open-link";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";
import {
  authnHostRowFixture,
  authnSecretRowFixture,
  createOwnEnvironmentAuthRuntime,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironment,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentTransport,
  type OwnEnvironmentTransportRequest,
} from "@/hooks/environment/__tests__/own-environment-authn-test-support";
import { OwnEnvironmentAuthProvider } from "@/hooks/environment/__tests__/own-environment-auth-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

// The writes name their environment through the surface's client.
const hostBoundary = vi.hoisted((): { client: unknown } => ({ client: null }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostBoundary.client,
}));

/** A host client the page under test reads through `useHostClient()`. */
function buildBoundClient(options: {
  readonly hostId: string;
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
}): EnvironmentClientFixture {
  const built = buildEnvironmentClient(options);
  hostBoundary.client = built.client;
  return built;
}

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
const PERSONAL_ENVIRONMENT = "env-secrets-refusal";
const TYPED_VALUE = 'p"ss\\w0rd-UNIQUE-7731';

interface SecretsHostState {
  verifyAnswer: SecretVerifyResult;
  /** The create rejects with this. */
  createError: Error | null;
}

interface SecretsHost {
  readonly client: HostClient<HostRpcRegistry>;
  readonly verifyRequests: EnvironmentSecretsVerifyRequest[];
  readonly createRequests: EnvironmentSecretsCreateRequest[];
}

let authRuntime: OwnEnvironmentAuthRuntime;
let authnTransport: OwnEnvironmentTransport;
let authnState: SecretsHostState;

function createdSecret(): EnvironmentSecretV12 {
  return {
    ...RETIRED_SECRET_ROW_FIELDS,
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
    secretId: "sec-new",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: "https",
    destinations: ["api.stripe.com"],
    currentVersionId: "ver-1",
    revoked: false,
    updatedAt: 1,
    variables: [],
  };
}

function buildSecretsHost(overrides: Partial<SecretsHostState>): SecretsHost {
  const state: SecretsHostState = {
    verifyAnswer: { evidence: "probe_accepted" },
    createError: null,
    ...overrides,
  };
  authnState = state;
  const verifyRequests: EnvironmentSecretsVerifyRequest[] = [];
  const createRequests: EnvironmentSecretsCreateRequest[] = [];
  const { client } = buildBoundClient({
    hostId: HOST_ID,
    handlers: {
      "environment.secrets.list": () => ({ removed: [], secrets: [] }),
      "environment.secrets.verify": (request) => {
        verifyRequests.push(request);
        return state.verifyAnswer;
      },
      "environment.secrets.create": (request) => {
        createRequests.push(request);
        if (state.createError !== null) throw state.createError;
        return { outcome: "created", secret: createdSecret() };
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
    <OwnEnvironmentAuthProvider binding={authRuntime.binding}>
      <QueryClientProvider client={queryClient}>
        <RunnerHostContext.Provider value={dashboardRunnerHost()}>
          <SecretsPage
            client={host.client}
            hostId={HOST_ID}
            emptyText={SECRETS_EMPTY_TEXT}
            hostName={() => "dev-box"}
          />
        </RunnerHostContext.Provider>
      </QueryClientProvider>
    </OwnEnvironmentAuthProvider>,
  );
  return queryClient;
}

beforeEach(async () => {
  // Each case exercises the real authn write path on Personal.
  useSettingsEnvironmentPickStore.setState({
    defaultPick: { kind: "personal" },
    pick: null,
  });
  authnState = {
    verifyAnswer: { evidence: "probe_accepted" },
    createError: null,
  };
  authnTransport = installOwnEnvironmentTransport(
    (request) => {
      const path = request.url.pathname;
      if (
        path === "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/hosts" &&
        request.method === "GET"
      ) {
        return jsonResponse(200, {
          hosts: [
            authnHostRowFixture({
              hostId: HOST_ID,
              hostName: "dev-box",
              hostPlatform: "linux",
            }),
          ],
        });
      }
      if (
        path === "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
        request.method === "GET"
      ) {
        return jsonResponse(200, { secrets: [] });
      }
      if (
        path ===
          "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets/verify" &&
        request.method === "POST"
      ) {
        return jsonResponse(200, authnState.verifyAnswer);
      }
      if (
        path === "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
        request.method === "POST"
      ) {
        if (authnState.createError instanceof HostTransportFailureError) {
          throw authnState.createError;
        }
        if (authnState.createError !== null) {
          return jsonResponse(409, { message: authnState.createError.message });
        }
        return jsonResponse(201, {
          secret: authnSecretRowFixture({
            id: "sec-new",
            name: "STRIPE_KEY",
            kind: "api_key",
            protocol: "https",
            hosts: ["api.stripe.com"],
            currentVersionId: "ver-1",
            updatedAt: 1,
            variables: [],
          }),
        });
      }
      return undefined;
    },
    {
      environments: [
        {
          environmentId: PERSONAL_ENVIRONMENT,
          ownerKind: "user",
          ownerId: "user-1",
          roomId: "room-personal",
          label: "Personal",
        },
      ],
    },
  );
  authRuntime = createOwnEnvironmentAuthRuntime();
  openLinkMock.mockResolvedValue(undefined);
  await signInOwnEnvironment(authRuntime);
  useAuthStore.setState({ shareableTeams: [] });
});

afterEach(() => {
  cleanup();
  authnTransport.restore();
  authRuntime.dispose();
  useAuthStore.setState({ status: "signed-out" });
  hostBoundary.client = null;
  useSettingsEnvironmentPickStore.setState({
    defaultPick: { kind: "personal" },
    pick: null,
  });
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

function findAuthnWrite(
  method: string,
  path: string,
): OwnEnvironmentTransportRequest {
  const request = authnTransport.requests.find(
    (candidate) =>
      candidate.method === method && candidate.url.pathname.endsWith(path),
  );
  if (request === undefined)
    throw new Error(`missing authn request ${method} ${path}`);
  return request;
}

function authnRequestBody(request: OwnEnvironmentTransportRequest): string {
  if (typeof request.body !== "string") {
    throw new Error("authn write request body was not serialized JSON");
  }
  return request.body;
}

describe("the typed secret value stays out of every cache when nothing is saved", () => {
  it("keeps it out when authn refuses create with its own words, and keeps it in the open dialog's input only", async () => {
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
    const createRequest = findAuthnWrite(
      "POST",
      "/" + PERSONAL_ENVIRONMENT + "/secrets",
    );
    expect(authnRequestBody(createRequest)).toContain(
      `"value":${JSON.stringify(TYPED_VALUE)}`,
    );
    expect(host.createRequests).toEqual([]);
    expectValueNowhere(cacheSnapshot(queryClient));

    const dialog = screen.getByTestId("add-secret-dialog");
    expect(dialog.textContent).not.toContain(TYPED_VALUE);

    // Back to the form: the dialog still holds what was typed, in its input.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(inputOf("secret-form-value").value).toBe(TYPED_VALUE);
    expectValueNowhere(cacheSnapshot(queryClient));
  });

  it("keeps it out when the authn transport fails during create", async () => {
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
    expect(note.textContent).toBe("Connect to manage secrets.");
    const createRequest = findAuthnWrite(
      "POST",
      "/" + PERSONAL_ENVIRONMENT + "/secrets",
    );
    expect(authnRequestBody(createRequest)).toContain(
      `"value":${JSON.stringify(TYPED_VALUE)}`,
    );
    expect(host.createRequests).toEqual([]);
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
    const verifyRequest = findAuthnWrite(
      "POST",
      "/" + PERSONAL_ENVIRONMENT + "/secrets/verify",
    );
    expect(authnRequestBody(verifyRequest)).toContain(
      `"value":${JSON.stringify(TYPED_VALUE)}`,
    );
    expect(host.verifyRequests).toEqual([]);
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
    const verifyRequest = findAuthnWrite(
      "POST",
      "/" + PERSONAL_ENVIRONMENT + "/secrets/verify",
    );
    expect(authnRequestBody(verifyRequest)).toContain(
      `"value":${JSON.stringify(TYPED_VALUE)}`,
    );
    expect(host.verifyRequests).toEqual([]);
    expect(host.createRequests).toEqual([]);
    expectValueNowhere(cacheSnapshot(queryClient));
    expect(inputOf("secret-form-value").value).toBe(TYPED_VALUE);
  });
});
