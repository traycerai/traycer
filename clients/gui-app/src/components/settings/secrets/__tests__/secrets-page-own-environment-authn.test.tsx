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
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  OwnEnvironmentAuthProvider,
  createOwnEnvironmentAuthRuntime,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironment,
  signInOwnEnvironmentAs,
  WINDOW_HOST,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentTransport,
} from "@/hooks/environment/__tests__/own-environment-authn-test-support";
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

let authRuntime: OwnEnvironmentAuthRuntime;
let authnTransport: OwnEnvironmentTransport;
let directoryFails: boolean;
let holdFirstDirectory: boolean;
let releaseFirstDirectory: (() => void) | null;
let hostSecretCalls: string[];

function PageWithRevisionRead(props: { readonly client: EnvironmentClient }) {
  useEnvironmentStatusRead(props.client, WINDOW_HOST, true);
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

beforeEach(async () => {
  directoryFails = false;
  holdFirstDirectory = false;
  releaseFirstDirectory = null;
  reportedRevision = 1;
  hostSecretCalls = [];
  authRuntime = createOwnEnvironmentAuthRuntime();
  authnTransport = installOwnEnvironmentTransport((request) => {
    if (
      request.url.pathname === "/api/environments" &&
      request.method === "GET" &&
      holdFirstDirectory
    ) {
      holdFirstDirectory = false;
      return new Promise<Response>((resolveResponse) => {
        releaseFirstDirectory = () => {
          resolveResponse(jsonResponse(200, PERSONAL_DIRECTORY));
        };
      });
    }
    if (
      request.url.pathname === "/api/environments" &&
      request.method === "GET" &&
      directoryFails
    ) {
      return jsonResponse(503, {});
    }
    if (
      request.url.pathname ===
        "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets" &&
      request.method === "GET"
    ) {
      return jsonResponse(200, { removed: [], secrets: [SECRET] });
    }
    if (
      request.url.pathname ===
        "/api/v3/environments/" +
          PERSONAL_ENVIRONMENT +
          "/secrets/" +
          SECRET_ID +
          "/versions" &&
      request.method === "GET"
    ) {
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
        removal: null,
      });
    }
    if (
      request.url.pathname ===
        "/api/v3/environments/" +
          PERSONAL_ENVIRONMENT +
          "/secrets/" +
          SECRET_ID +
          "/rotation" &&
      request.method === "GET"
    ) {
      return jsonResponse(200, { rotation: null, lastVerify: null });
    }
    if (
      request.method === "POST" &&
      request.url.pathname.endsWith("/secrets/verify")
    ) {
      return jsonResponse(200, { evidence: "probe_accepted" });
    }
    if (
      request.method === "POST" &&
      (request.url.pathname.endsWith("/verify") ||
        request.url.pathname.endsWith("/destroy") ||
        request.url.pathname.endsWith("/undo") ||
        request.url.pathname.endsWith("/secrets"))
    ) {
      return jsonResponse(500, {});
    }
    if (
      request.method === "PATCH" &&
      request.url.pathname.endsWith("/" + SECRET_ID)
    ) {
      return jsonResponse(500, {});
    }
    return undefined;
  }, PERSONAL_DIRECTORY);
  await signInOwnEnvironment(authRuntime);
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
    const oldVersion = within(versionList).getAllByTestId("secret-version")[1]!;
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

    const refreshedOldVersion = within(
      screen.getByTestId("secret-versions"),
    ).getAllByTestId("secret-version")[1]!;
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

    fireEvent.click(await screen.findByTestId("secrets-add"));
    await screen.findByTestId("secret-kind-picker");
    fireEvent.click(screen.getByTestId("secret-kind-option-api_key"));
    const name = await screen.findByTestId("secret-form-name");
    fireEvent.change(name, { target: { value: "NEW_API_KEY" } });
    fireEvent.change(screen.getByTestId("secret-form-hosts"), {
      target: { value: "api.example.test" },
    });
    fireEvent.change(screen.getByTestId("secret-form-value"), {
      target: { value: "test-secret-value" },
    });
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
    mountSecretsPage();

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

    await act(async () => {
      await authRuntime.auth.signOut();
      useAuthStore.setState({ status: "signed-out" });
    });
    await signInOwnEnvironmentAs(authRuntime, "user-2", "user-2-token");

    await screen.findByTestId("secret-row");
    await waitFor(() => {
      expect(
        authnTransport.requests.filter(
          (request) =>
            request.url.pathname === "/api/environments" &&
            request.method === "GET",
        ),
      ).toHaveLength(2);
      expect(authnSecretPaths()).toContain(
        "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/secrets",
      );
    });

    const release = releaseFirstDirectory;
    if (release === null)
      throw new Error("the first directory read was not held");
    release();
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
    const oldVersion = within(versions).getAllByTestId("secret-version")[1]!;
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

    document.dispatchEvent(new Event("visibilitychange"));
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
    expect(
      authnTransport.requests.filter(
        (request) => request.url.pathname === "/api/environments",
      ),
    ).toHaveLength(1);

    directoryFails = false;
    fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("secret-row")).toBeTruthy();
    expect(
      authnTransport.requests.filter(
        (request) => request.url.pathname === "/api/environments",
      ),
    ).toHaveLength(2);
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
