import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EnvironmentSecretRemoval,
  EnvironmentSecretV12,
} from "@traycer/protocol/host/environment-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useRereadHostReadsOnFocus } from "@/hooks/environment/use-reread-host-reads-on-focus";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { RunnerHostContext } from "@/providers/runner-host-context";
import {
  SECRET_REVOKED_LABEL,
  SECRETS_EMPTY_TEXT,
} from "@/lib/sandboxes/secrets-page-copy";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  createOwnEnvironmentAuthRuntime,
  authnHostRowFixture,
  authnSecretRowFixture,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironment,
  signInOwnEnvironmentAs,
  WINDOW_HOST,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentTransport,
  type OwnEnvironmentTransportRequest,
} from "@/hooks/environment/__tests__/own-environment-authn-test-support";
import { OwnEnvironmentAuthProvider } from "@/hooks/environment/__tests__/own-environment-auth-provider";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const PERSONAL_ENVIRONMENT = "env-personal";
const SECOND_ACCOUNT_ENVIRONMENT = "env-personal-user-2";
const SECRET_ID = "secret-page-authn";
const VERSION_ID = "version-page-authn";
const OLD_VERSION_ID = "version-page-authn-old";
let reportedRevision: number;

const PERSONAL_DIRECTORY = {
  environments: [
    {
      environmentId: PERSONAL_ENVIRONMENT,
      ownerKind: "user" as const,
      ownerId: "user-1",
      roomId: "room-personal",
      label: "Personal",
      effectiveRole: "owner" as const,
      kind: "personal" as const,
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

const SECOND_ACCOUNT_DIRECTORY = {
  environments: [
    {
      environmentId: SECOND_ACCOUNT_ENVIRONMENT,
      ownerKind: "user" as const,
      ownerId: "user-2",
      roomId: "room-personal-user-2",
      label: "Personal",
      effectiveRole: "owner" as const,
      kind: "personal" as const,
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

const SECRET: EnvironmentSecretV12 = {
  ...RETIRED_SECRET_ROW_FIELDS,
  providerVariables: [...RETIRED_PROVIDER_VARIABLES],
  secretId: SECRET_ID,
  name: "STRIPE_KEY",
  kind: "api_key",
  protocol: "https",
  destinations: ["api.stripe.com"],
  currentVersionId: VERSION_ID,
  revoked: false,
  updatedAt: 1,
  variables: [],
};

const AUTHN_SECRET = authnSecretRowFixture({
  id: SECRET_ID,
  name: SECRET.name,
  kind: SECRET.kind,
  protocol: SECRET.protocol ?? SECRET.kind,
  hosts: SECRET.destinations,
  currentVersionId: VERSION_ID,
  updatedAt: SECRET.updatedAt,
  variables: SECRET.variables.map((name) => ({ name })),
});

const SECOND_ACCOUNT_SECRET = {
  ...AUTHN_SECRET,
  name: "USER_2_ONLY_SECRET",
};

const AUTHN_HOST = authnHostRowFixture({
  hostId: WINDOW_HOST,
  hostName: "window host",
  hostPlatform: "linux",
});

let authRuntime: OwnEnvironmentAuthRuntime;
let authnTransport: OwnEnvironmentTransport;
let directoryFails: boolean;
let holdFirstDirectory: boolean;
let releaseFirstDirectory: (() => void) | null;
let activePersonalEnvironment: string;
let directoryForCurrentSignIn: unknown;
let hostSecretCalls: string[];
let secretListFails: boolean;
let versionsRemoval: EnvironmentSecretRemoval | null;
let createRefusal: { readonly status: number; readonly body: unknown } | null;

function PageWithRevisionRead(props: { readonly client: EnvironmentClient }) {
  useEnvironmentStatusRead(props.client, WINDOW_HOST, true);
  useRereadHostReadsOnFocus(WINDOW_HOST);
  return (
    <SecretsPage
      client={props.client}
      hostId={WINDOW_HOST}
      emptyText={SECRETS_EMPTY_TEXT}
      hostName={() => "window host"}
    />
  );
}

type EnvironmentClient = HostClient<HostRpcRegistry>;

function mountSecretsPage(): QueryClient {
  const { client } = buildEnvironmentClient({
    hostId: WINDOW_HOST,
    handlers: {
      "environment.status": () =>
        environmentStatusFixture({
          principal: { kind: "personal" },
          receivedRevision: reportedRevision,
          appliedRevision: reportedRevision,
        }),
      "environment.secrets.list": () => {
        hostSecretCalls.push("environment.secrets.list");
        return { removed: [], secrets: [SECRET] };
      },
      "environment.secrets.versions": () => {
        hostSecretCalls.push("environment.secrets.versions");
        return { versions: [], removal: null };
      },
      "environment.secrets.rotation": () => {
        hostSecretCalls.push("environment.secrets.rotation");
        return { rotation: null, lastVerify: null };
      },
    },
  });
  const binding = { ...authRuntime.binding, hostClient: client };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  recordNegotiatedHostMethods(WINDOW_HOST, ["environment.status"]);
  useSettingsEnvironmentPickStore.setState({
    defaultPick: { kind: "personal" },
    pick: { kind: "local", hostId: WINDOW_HOST, hostName: "window host" },
  });
  render(
    <OwnEnvironmentAuthProvider binding={binding}>
      <QueryClientProvider client={queryClient}>
        <RunnerHostContext.Provider value={dashboardRunnerHost()}>
          <PageWithRevisionRead client={client} />
        </RunnerHostContext.Provider>
      </QueryClientProvider>
    </OwnEnvironmentAuthProvider>,
  );
  return queryClient;
}

function activeEnvironmentPath(suffix: string): string {
  return "/api/v3/environments/" + activePersonalEnvironment + "/" + suffix;
}

function ownEnvironmentDirectoryRoute(
  request: OwnEnvironmentTransportRequest,
): Response | Promise<Response> | undefined {
  if (
    request.method !== "GET" ||
    request.url.pathname !== "/api/environments"
  ) {
    return undefined;
  }
  if (holdFirstDirectory) {
    holdFirstDirectory = false;
    return new Promise<Response>((resolveResponse) => {
      releaseFirstDirectory = () => {
        resolveResponse(jsonResponse(200, PERSONAL_DIRECTORY));
      };
    });
  }
  return directoryFails
    ? jsonResponse(503, {})
    : jsonResponse(200, directoryForCurrentSignIn);
}

function ownEnvironmentHostRoute(
  request: OwnEnvironmentTransportRequest,
): Response | undefined {
  if (
    request.method !== "GET" ||
    request.url.pathname !== activeEnvironmentPath("hosts")
  ) {
    return undefined;
  }
  return jsonResponse(200, { hosts: [AUTHN_HOST] });
}

function ownEnvironmentSecretReadRoute(
  request: OwnEnvironmentTransportRequest,
): Response | undefined {
  if (request.method !== "GET") return undefined;
  const path = request.url.pathname;
  if (path === activeEnvironmentPath("secrets")) {
    if (secretListFails) return jsonResponse(503, {});
    return jsonResponse(200, {
      secrets: [
        activePersonalEnvironment === SECOND_ACCOUNT_ENVIRONMENT
          ? SECOND_ACCOUNT_SECRET
          : AUTHN_SECRET,
      ],
    });
  }
  if (path === activeEnvironmentPath("secrets/" + SECRET_ID + "/versions")) {
    return jsonResponse(200, {
      versions: [
        {
          versionId: VERSION_ID,
          ordinal: 2,
          createdAt: 2,
          supersededAt: null,
          destroyedAt: null,
          current: true,
          rotationState: null,
        },
        {
          versionId: OLD_VERSION_ID,
          ordinal: 1,
          createdAt: 1,
          supersededAt: 2,
          destroyedAt: null,
          current: false,
          rotationState: null,
        },
      ],
      removal: versionsRemoval,
    });
  }
  if (path === activeEnvironmentPath("secrets/" + SECRET_ID + "/rotation")) {
    return jsonResponse(200, { rotation: null, lastVerify: null });
  }
  return undefined;
}

function ownEnvironmentSecretWriteRoute(
  request: OwnEnvironmentTransportRequest,
): Response | undefined {
  const path = request.url.pathname;
  if (request.method === "POST" && path.endsWith("/secrets/verify")) {
    return jsonResponse(200, { evidence: "probe_accepted" });
  }
  if (request.method === "POST" && path.endsWith("/secrets")) {
    return createRefusal === null
      ? jsonResponse(500, {})
      : jsonResponse(createRefusal.status, createRefusal.body);
  }
  if (
    request.method === "POST" &&
    (path.endsWith("/verify") ||
      path.endsWith("/destroy") ||
      path.endsWith("/undo") ||
      path.endsWith("/secrets"))
  ) {
    return jsonResponse(500, {});
  }
  if (request.method === "PATCH" && path.endsWith("/" + SECRET_ID)) {
    return jsonResponse(500, {});
  }
  return undefined;
}

function ownEnvironmentRoute(
  request: OwnEnvironmentTransportRequest,
): Response | Promise<Response> | undefined {
  return (
    ownEnvironmentDirectoryRoute(request) ??
    ownEnvironmentHostRoute(request) ??
    ownEnvironmentSecretReadRoute(request) ??
    ownEnvironmentSecretWriteRoute(request)
  );
}

beforeEach(async () => {
  directoryFails = false;
  holdFirstDirectory = false;
  releaseFirstDirectory = null;
  activePersonalEnvironment = PERSONAL_ENVIRONMENT;
  directoryForCurrentSignIn = PERSONAL_DIRECTORY;
  reportedRevision = 1;
  hostSecretCalls = [];
  secretListFails = false;
  versionsRemoval = null;
  createRefusal = null;
  authRuntime = createOwnEnvironmentAuthRuntime();
  authnTransport = installOwnEnvironmentTransport(
    ownEnvironmentRoute,
    PERSONAL_DIRECTORY,
  );
  await signInOwnEnvironment(authRuntime);
  useAuthStore.setState({ shareableTeams: [] });
});

afterEach(() => {
  cleanup();
  authnTransport.restore();
  authRuntime.dispose();
  useAuthStore.setState({ status: "signed-out" });
  useSettingsEnvironmentPickStore.setState({
    defaultPick: { kind: "personal" },
    pick: null,
  });
  resetNegotiatedManifests();
});

async function endSignInAfterPress(button: HTMLElement): Promise<void> {
  fireEvent.click(button);
  await act(async () => {
    await authRuntime.auth.signOut();
    useAuthStore.setState({ status: "signed-out" });
  });
  await signInOwnEnvironment(authRuntime);
}

function authnSecretPaths(): string[] {
  return authnTransport.requests
    .filter((request) => request.url.pathname.includes("/secrets"))
    .map((request) => request.url.pathname);
}

function secretRequestCount(path: string, method: string): number {
  return authnTransport.requests.filter(
    (request) =>
      request.url.pathname === path && request.method === method,
  ).length;
}

async function fillNewApiKeyForm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("secrets-add"));
  await screen.findByTestId("secret-kind-picker");
  fireEvent.click(screen.getByTestId("secret-kind-option-api_key"));
  fireEvent.change(await screen.findByTestId("secret-form-name"), {
    target: { value: "NEW_API_KEY" },
  });
  fireEvent.change(screen.getByTestId("secret-form-hosts"), {
    target: { value: "api.example.test" },
  });
  fireEvent.change(screen.getByTestId("secret-form-value"), {
    target: { value: "test-secret-value" },
  });
}

async function saveNewApiKey(): Promise<void> {
  await fillNewApiKeyForm();
  fireEvent.click(screen.getByTestId("secret-form-continue"));
  fireEvent.click(await screen.findByTestId("secret-save"));
}

function revokedRemovalFixture(): EnvironmentSecretRemoval {
  return {
    outcome: "revoked",
    revokedAt: 3,
    destroyedAt: null,
    targets: [
      {
        target: "host",
        hostId: "host-other",
        hostName: "other computer",
        state: "confirmed",
        at: 3,
      },
    ],
  };
}

describe("Secrets page reads on the window host's own environment", () => {
  it("reads Local pick list, versions, and rotation through authn with the named Personal environment", async () => {
    mountSecretsPage();

    const row = await screen.findByTestId("secret-row");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    await screen.findByTestId("secret-details-controls");

    await waitFor(() => {
      expect(authnSecretPaths()).toContain(
        "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets",
      );
      expect(authnSecretPaths()).toContain(
        "/api/v3/environments/" +
          PERSONAL_ENVIRONMENT +
          "/secrets/" +
          SECRET_ID +
          "/versions",
      );
      expect(authnSecretPaths()).toContain(
        "/api/v3/environments/" +
          PERSONAL_ENVIRONMENT +
          "/secrets/" +
          SECRET_ID +
          "/rotation",
      );
    });
    expect(hostSecretCalls).toEqual([]);
  });

  it("keeps a cached live row revoked when a newer versions answer reports removal", async () => {
    mountSecretsPage();

    const row = await screen.findByTestId("secret-row");
    expect(row.textContent).not.toContain(SECRET_REVOKED_LABEL);
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const controls = await screen.findByTestId("secret-details-controls");
    await within(controls).findByTestId("secret-versions");

    const listPath = activeEnvironmentPath("secrets");
    const versionsPath = activeEnvironmentPath(
      "secrets/" + SECRET_ID + "/versions",
    );
    const listReadsBeforeRefresh = secretRequestCount(listPath, "GET");
    const versionsReadsBeforeRefresh = secretRequestCount(versionsPath, "GET");
    secretListFails = true;
    versionsRemoval = revokedRemovalFixture();
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(secretRequestCount(listPath, "GET")).toBeGreaterThan(
        listReadsBeforeRefresh,
      );
      expect(secretRequestCount(versionsPath, "GET")).toBeGreaterThan(
        versionsReadsBeforeRefresh,
      );
    });
    expect(screen.getByTestId("secret-row")).toBeTruthy();
    expect(row.textContent).toContain(SECRET_REVOKED_LABEL);
    expect(
      within(controls).queryByTestId("secret-row-verify"),
    ).toBeNull();
    expect(hostSecretCalls).toEqual([]);
  });

  it("sends Verify, Remove, Undo, and version Destroy to authn with the window host's environment", async () => {
    mountSecretsPage();

    const row = await screen.findByTestId("secret-row");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const controls = await screen.findByTestId("secret-details-controls");
    fireEvent.click(within(controls).getByTestId("secret-row-verify"));
    await waitFor(() => {
      expect(
        authnTransport.requests.some((request) =>
          request.url.pathname.endsWith("/secrets/" + SECRET_ID + "/verify"),
        ),
      ).toBe(true);
    });

    fireEvent.click(within(row).getByTestId("secret-row-remove"));
    const removeDialog = await screen.findByTestId(
      "confirm-destructive-dialog",
    );
    fireEvent.click(
      within(removeDialog).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => {
      expect(
        authnTransport.requests.some((request) =>
          request.url.pathname.endsWith(
            "/secrets/" + SECRET_ID + "/versions/" + VERSION_ID + "/destroy",
          ),
        ),
      ).toBe(true);
    });
    const rowDestroy = authnTransport.requests.find((request) =>
      request.url.pathname.endsWith(
        "/secrets/" + SECRET_ID + "/versions/" + VERSION_ID + "/destroy",
      ),
    );
    expect(rowDestroy?.method).toBe("POST");
    expect(rowDestroy?.body).toBe(JSON.stringify({ allowCurrent: true }));
    fireEvent.click(within(removeDialog).getByTestId("confirm-cancel"));

    const versionList = await screen.findByTestId("secret-versions");
    const versions = within(versionList).getAllByTestId("secret-version");
    expect(versions).toHaveLength(2);
    const oldVersion = versions[1];
    fireEvent.click(within(oldVersion).getByTestId("secret-version-undo"));
    await waitFor(() => {
      expect(
        authnTransport.requests.some((request) =>
          request.url.pathname.endsWith(
            "/secrets/" + SECRET_ID + "/versions/" + OLD_VERSION_ID + "/undo",
          ),
        ),
      ).toBe(true);
    });

    const refreshedVersions = within(
      screen.getByTestId("secret-versions"),
    ).getAllByTestId("secret-version");
    expect(refreshedVersions).toHaveLength(2);
    const refreshedOldVersion = refreshedVersions[1];
    fireEvent.click(
      within(refreshedOldVersion).getByTestId("secret-version-destroy"),
    );
    const versionDialog = await screen.findByTestId(
      "confirm-destructive-dialog",
    );
    fireEvent.click(
      within(versionDialog).getByRole("button", { name: "Destroy" }),
    );
    await waitFor(() => {
      expect(
        authnTransport.requests.some((request) =>
          request.url.pathname.endsWith(
            "/secrets/" +
              SECRET_ID +
              "/versions/" +
              OLD_VERSION_ID +
              "/destroy",
          ),
        ),
      ).toBe(true);
    });
    expect(hostSecretCalls).toEqual([]);
    expect(
      authnSecretPaths().every((path) =>
        path.startsWith("/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/"),
      ),
    ).toBe(true);
  });

  it("sends candidate Verify and create through authn for the named environment", async () => {
    mountSecretsPage();

    await fillNewApiKeyForm();
    fireEvent.click(screen.getByTestId("secret-form-verify"));
    await waitFor(() => {
      expect(
        authnTransport.requests.some((request) =>
          request.url.pathname.endsWith("/secrets/verify"),
        ),
      ).toBe(true);
    });
    fireEvent.click(screen.getByTestId("secret-form-continue"));
    await screen.findByTestId("secret-save");
    fireEvent.click(screen.getByTestId("secret-save"));
    await waitFor(() => {
      expect(
        authnTransport.requests.some(
          (request) =>
            request.url.pathname ===
              "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
            request.method === "POST",
        ),
      ).toBe(true);
    });

    expect(hostSecretCalls).toEqual([]);
    expect(
      authnSecretPaths().every((path) =>
        path.startsWith("/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/"),
      ),
    ).toBe(true);
  });

  it("shows authn's provider key variable refusal through the create action", async () => {
    createRefusal = {
      status: 409,
      body: { error: "Use its provider's key variable as the name." },
    };
    mountSecretsPage();

    await saveNewApiKey();

    expect((await screen.findByTestId("secret-save-note")).textContent).toBe(
      "Use its provider's key variable as the name.",
    );
    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();
    expect(hostSecretCalls).toEqual([]);
    expect(
      authnTransport.requests.some(
        (request) =>
          request.method === "POST" &&
          request.url.pathname === activeEnvironmentPath("secrets"),
      ),
    ).toBe(true);
  });

  it("shows the plain authn refusal when a code has no message", async () => {
    createRefusal = {
      status: 409,
      body: { code: "a_code_from_a_newer_server" },
    };
    mountSecretsPage();

    await saveNewApiKey();

    expect((await screen.findByTestId("secret-save-note")).textContent).toBe(
      "Your environment did not accept this change.",
    );
    expect(screen.getByTestId("add-secret-dialog")).toBeTruthy();
    expect(hostSecretCalls).toEqual([]);
    expect(
      authnTransport.requests.some(
        (request) =>
          request.method === "POST" &&
          request.url.pathname === activeEnvironmentPath("secrets"),
      ),
    ).toBe(true);
  });

  it("sends Replace value through authn for the named environment", async () => {
    mountSecretsPage();

    const row = await screen.findByTestId("secret-row");
    fireEvent.click(within(row).getByTestId("secret-row-replace"));
    const replaceValue = await screen.findByTestId("replace-secret-value");
    fireEvent.change(replaceValue, {
      target: { value: "replacement-secret-value" },
    });
    fireEvent.click(screen.getByTestId("replace-secret-confirm"));
    await waitFor(() => {
      expect(
        authnTransport.requests.some(
          (request) =>
            request.url.pathname.endsWith("/secrets/" + SECRET_ID) &&
            request.method === "PATCH",
        ),
      ).toBe(true);
    });
    expect(hostSecretCalls).toEqual([]);
    expect(
      authnSecretPaths().every((path) =>
        path.startsWith("/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/"),
      ),
    ).toBe(true);
  });

  it("re-reads the named secrets when this host reports a newer revision", async () => {
    const queryClient = mountSecretsPage();
    await screen.findByTestId("secret-row");
    await waitFor(() => {
      expect(
        authnTransport.requests.filter(
          (request) =>
            request.url.pathname ===
              "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
            request.method === "GET",
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });

    reportedRevision = 2;
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(WINDOW_HOST, "environment.status"),
    });
    await waitFor(() => {
      expect(
        authnTransport.requests.filter(
          (request) =>
            request.url.pathname ===
              "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
            request.method === "GET",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(hostSecretCalls).toEqual([]);
  });

  it("does not continue an in-flight Personal lookup on the next account's sign-in", async () => {
    holdFirstDirectory = true;
    const queryClient = mountSecretsPage();

    await waitFor(() => {
      expect(
        authnTransport.requests.filter(
          (request) =>
            request.url.pathname === "/api/environments" &&
            request.method === "GET",
        ),
      ).toHaveLength(1);
      expect(releaseFirstDirectory).not.toBeNull();
    });

    const secretPathsBeforeSwitch = authnSecretPaths();
    await act(async () => {
      await authRuntime.auth.signOut();
      useAuthStore.setState({ status: "signed-out" });
    });
    activePersonalEnvironment = SECOND_ACCOUNT_ENVIRONMENT;
    directoryForCurrentSignIn = SECOND_ACCOUNT_DIRECTORY;
    await signInOwnEnvironmentAs(authRuntime, "user-2", "user-2-token");
    useAuthStore.setState({ shareableTeams: [] });

    await screen.findByTestId("secret-row");
    await waitFor(() => {
      expect(
        authnSecretPaths().slice(secretPathsBeforeSwitch.length),
      ).toContain(
        "/api/v3/environments/" + SECOND_ACCOUNT_ENVIRONMENT + "/secrets",
      );
    });
    expect(screen.queryByText("USER_2_ONLY_SECRET")).toBeTruthy();

    const release = releaseFirstDirectory;
    if (release === null)
      throw new Error("the first directory read was not held");
    const secretPathsBeforeRelease = authnSecretPaths();
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(
        queryClient
          .getQueryCache()
          .findAll({
            predicate: (query) =>
              query.meta?.hostRpcMethod === "environment.list",
          })
          .every((query) => query.state.fetchStatus === "idle"),
      ).toBe(true);
    });
    expect(screen.queryByText("USER_2_ONLY_SECRET")).toBeTruthy();
    expect(
      authnSecretPaths().slice(secretPathsBeforeRelease.length),
    ).not.toContain(
      "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets",
    );
    expect(hostSecretCalls).toEqual([]);
  });

  it("does not send a row write after the sign-in it was pressed on ends", async () => {
    mountSecretsPage();
    const row = await screen.findByTestId("secret-row");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const controls = await screen.findByTestId("secret-details-controls");
    const beforePress = authnTransport.requests.length;

    await endSignInAfterPress(
      within(controls).getByTestId("secret-row-verify"),
    );

    expect(
      authnTransport.requests
        .slice(beforePress)
        .filter(
          (request) =>
            request.method === "POST" &&
            request.url.pathname.endsWith("/secrets/" + SECRET_ID + "/verify"),
        ),
    ).toEqual([]);
    expect(hostSecretCalls).toEqual([]);
  });

  it("does not send a version write after the sign-in it was pressed on ends", async () => {
    mountSecretsPage();
    const row = await screen.findByTestId("secret-row");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const versions = await screen.findByTestId("secret-versions");
    const versionRows = within(versions).getAllByTestId("secret-version");
    expect(versionRows).toHaveLength(2);
    const oldVersion = versionRows[1];
    const beforePress = authnTransport.requests.length;

    await endSignInAfterPress(
      within(oldVersion).getByTestId("secret-version-undo"),
    );

    expect(
      authnTransport.requests
        .slice(beforePress)
        .filter(
          (request) =>
            request.method === "POST" &&
            request.url.pathname.endsWith(
              "/secrets/" + SECRET_ID + "/versions/" + OLD_VERSION_ID + "/undo",
            ),
        ),
    ).toEqual([]);
    expect(hostSecretCalls).toEqual([]);
  });

  it("does not send a value write after the sign-in it was pressed on ends", async () => {
    mountSecretsPage();
    const row = await screen.findByTestId("secret-row");
    fireEvent.click(within(row).getByTestId("secret-row-replace"));
    const replaceValue = await screen.findByTestId("replace-secret-value");
    fireEvent.change(replaceValue, {
      target: { value: "replacement-secret-value" },
    });
    const beforePress = authnTransport.requests.length;

    await endSignInAfterPress(screen.getByTestId("replace-secret-confirm"));

    expect(
      authnTransport.requests
        .slice(beforePress)
        .filter(
          (request) =>
            request.method === "PATCH" &&
            request.url.pathname.endsWith("/secrets/" + SECRET_ID),
        ),
    ).toEqual([]);
    expect(hostSecretCalls).toEqual([]);
  });

  it("re-reads authn secrets after the window regains focus", async () => {
    mountSecretsPage();
    await screen.findByTestId("secret-row");
    await waitFor(() => {
      expect(
        authnTransport.requests.filter(
          (request) =>
            request.url.pathname ===
              "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
            request.method === "GET",
        ),
      ).toHaveLength(1);
    });

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(
        authnTransport.requests.filter(
          (request) =>
            request.url.pathname ===
              "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
            request.method === "GET",
        ),
      ).toHaveLength(2);
    });
    expect(hostSecretCalls).toEqual([]);
  });

  it("shows the Personal read failure after a cold directory failure and retries only after the press", async () => {
    directoryFails = true;
    mountSecretsPage();

    const error = await screen.findByTestId("secrets-page-error");
    expect(error.textContent).toContain("Couldn't read Personal's secrets.");
    expect(screen.queryByTestId("secret-row")).toBeNull();
    expect(authnSecretPaths()).toEqual([]);
    expect(hostSecretCalls).toEqual([]);
    const directoryReadsBeforeRetry = authnTransport.requests.filter(
      (request) => request.url.pathname === "/api/environments",
    ).length;

    directoryFails = false;
    fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("secret-row")).toBeTruthy();
    await waitFor(() => {
      expect(
        authnTransport.requests.filter(
          (request) => request.url.pathname === "/api/environments",
        ).length,
      ).toBeGreaterThan(directoryReadsBeforeRetry);
    });
    expect(authnSecretPaths()).toContain(
      "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets",
    );
    expect(hostSecretCalls).toEqual([]);
  });
});

async function applicationSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(
        ...(await applicationSourceFiles(join(directory, entry.name))),
      );
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

describe("secrets use the app's own environment client", () => {
  it("has no host query or request call for an environment.secrets method", async () => {
    const files = await applicationSourceFiles(resolve(process.cwd(), "src"));
    const sources = await Promise.all(
      files.map((file) => readFile(file, "utf8")),
    );
    const hostSecretsCall =
      /(?:useHostQuery|useHostMutation|client\.request)[\s\S]{0,600}["']environment\.secrets\.[^"']+["']/;
    const violations = sources.flatMap((source, index) =>
      hostSecretsCall.test(source) ? [files[index]] : [],
    );

    expect(violations).toEqual([]);
  });
});
