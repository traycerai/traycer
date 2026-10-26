import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  EnvironmentSecretV12,
  EnvironmentSecretsReplaceValueRequest,
  EnvironmentSecretsReplaceValueResponse,
  EnvironmentSecretsUndoResponse,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { ReplaceSecretValueDialog } from "@/components/settings/secrets/replace-secret-value-dialog";
import { SecretVersionsList } from "@/components/settings/secrets/secret-versions-list";
import {
  buildEnvironmentClient,
  type EnvironmentClientFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  SECRET_REPLACE_STALE,
  SECRET_SAVED_OFFLINE,
} from "@/lib/sandboxes/secrets-page-copy";

// The writes name their environment through the surface's client.
const hostBoundary = vi.hoisted((): { client: unknown } => ({ client: null }));
// These cases are about the preview features' on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

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

// The edges of Replace value and of the versions
// list that `secret-row-rotation.test.tsx` reaches only through the whole
// Secrets page. Each case here is a claim a mutation of the dialog or the
// list survived: the disabled gate, a queued save leaving the list alone, the
// note clearing while a retry is in flight, an unknown refusal's fallback and
// a destroyed version winning over `current`.

const HOST_ID = "host-edges";
const TYPED = "sk_live_EDGE_VALUE_77aa";

function secretFixture(
  overrides: Partial<EnvironmentSecretV12>,
): EnvironmentSecretV12 {
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
    variables: [],
    providerVariables: [],
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

beforeEach(() => {
  // A Local pick names the host's own environment: these cases are about the
  // dialog and the list, not about which environment a call names.
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: "host-local", hostName: "dev-box" },
  });
});

afterEach(() => {
  cleanup();
  hostBoundary.client = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** The dialog's writes are host mutations, so it renders under a cache. */
function underCache(queryClient: QueryClient, node: ReactNode): ReactNode {
  return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
}

function buttonOf(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("the element is not a button");
  }
  return element;
}

interface DialogMount {
  readonly requests: EnvironmentSecretsReplaceValueRequest[];
  readonly onReplaced: Mock<() => void>;
  readonly queryClient: QueryClient;
}

function mountDialog(
  secret: EnvironmentSecretV12,
  answer: () => Promise<EnvironmentSecretsReplaceValueResponse>,
): DialogMount {
  const requests: EnvironmentSecretsReplaceValueRequest[] = [];
  const { client } = buildBoundClient({
    hostId: HOST_ID,
    handlers: {
      "environment.secrets.replaceValue": (request) => {
        requests.push(request);
        return answer();
      },
    },
  });
  const onReplaced = vi.fn<() => void>();
  const queryClient = testQueryClient();
  render(
    underCache(
      queryClient,
      <ReplaceSecretValueDialog
        open
        secret={secret}
        client={client}
        onOpenChange={() => undefined}
        onReplaced={onReplaced}
      />,
    ),
  );
  return { requests, onReplaced, queryClient };
}

function typeValue(value: string): void {
  fireEvent.change(screen.getByTestId("replace-secret-value"), {
    target: { value },
  });
}

function replaceButton(): HTMLButtonElement {
  return buttonOf(screen.getByTestId("replace-secret-confirm"));
}

describe("the Replace value dialog's gate", () => {
  it("is disabled while the field is empty and sends nothing", () => {
    const mounted = mountDialog(secretFixture({}), () =>
      Promise.reject(new Error("must not be asked")),
    );

    expect(replaceButton().disabled).toBe(true);
    fireEvent.click(replaceButton());
    expect(mounted.requests).toEqual([]);

    typeValue(TYPED);
    expect(replaceButton().disabled).toBe(false);
    typeValue("");
    expect(replaceButton().disabled).toBe(true);
  });

  it("is disabled with a typed value when the list showed no current version, and sends nothing", () => {
    const mounted = mountDialog(secretFixture({ currentVersionId: null }), () =>
      Promise.reject(new Error("must not be asked")),
    );

    typeValue(TYPED);

    expect(replaceButton().disabled).toBe(true);
    fireEvent.click(replaceButton());
    expect(mounted.requests).toEqual([]);
  });
});

describe("the Replace value dialog's answers", () => {
  it("leaves the list alone and the dialog open when the host only queued the save", async () => {
    const mounted = mountDialog(secretFixture({}), () =>
      Promise.resolve({ outcome: "pending", uploadId: "u1" }),
    );
    const listKey = hostQueryKeys.methodScope(
      HOST_ID,
      "environment.secrets.list",
    );
    mounted.queryClient.setQueryData(listKey, { secrets: [], removed: [] });

    typeValue(TYPED);
    fireEvent.click(replaceButton());

    expect((await screen.findByTestId("replace-secret-note")).textContent).toBe(
      SECRET_SAVED_OFFLINE,
    );
    expect(mounted.queryClient.getQueryState(listKey)?.isInvalidated).toBe(
      false,
    );
    expect(mounted.onReplaced).not.toHaveBeenCalled();
    expect(screen.getByTestId("replace-secret-dialog")).toBeTruthy();
  });

  it("clears the previous note while a retry is in flight", async () => {
    let release: (
      answer: EnvironmentSecretsReplaceValueResponse,
    ) => void = () => undefined;
    let calls = 0;
    const mounted = mountDialog(secretFixture({}), () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "stale",
          currentVersionId: "ver-9",
          changedBy: { kind: "dashboard" },
        });
      }
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    typeValue(TYPED);
    fireEvent.click(replaceButton());
    expect((await screen.findByTestId("replace-secret-note")).textContent).toBe(
      SECRET_REPLACE_STALE,
    );

    fireEvent.click(replaceButton());

    await waitFor(() => {
      expect(mounted.requests).toHaveLength(2);
    });
    expect(screen.queryByTestId("replace-secret-note")).toBeNull();
    release({ outcome: "pending", uploadId: "u2" });
    expect((await screen.findByTestId("replace-secret-note")).textContent).toBe(
      SECRET_SAVED_OFFLINE,
    );
  });
});

/** The parent that owns `open`, as the secret row does, with a way to reopen. */
function ReopenableReplaceDialog(props: {
  readonly secret: EnvironmentSecretV12;
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="reopen-replace"
      >
        Reopen
      </button>
      <ReplaceSecretValueDialog
        open={open}
        secret={props.secret}
        client={props.client}
        onOpenChange={setOpen}
        onReplaced={() => undefined}
      />
    </>
  );
}

describe("the Replace value dialog across a close and a reopen", () => {
  it("a stale accepted completion of a cancelled replace does not close the reopened dialog", async () => {
    let release: (
      answer: EnvironmentSecretsReplaceValueResponse,
    ) => void = () => undefined;
    const requests: EnvironmentSecretsReplaceValueRequest[] = [];
    const { client } = buildBoundClient({
      hostId: HOST_ID,
      handlers: {
        "environment.secrets.replaceValue": (request) => {
          requests.push(request);
          return new Promise<EnvironmentSecretsReplaceValueResponse>(
            (resolve) => {
              release = resolve;
            },
          );
        },
      },
    });
    render(
      underCache(
        testQueryClient(),
        <ReopenableReplaceDialog secret={secretFixture({})} client={client} />,
      ),
    );
    typeValue(TYPED);
    fireEvent.click(replaceButton());
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("replace-secret-dialog")).toBeNull();
    });
    fireEvent.click(screen.getByTestId("reopen-replace"));
    await screen.findByTestId("replace-secret-dialog");

    release({ outcome: "accepted", rotationId: "rot-1", versionId: "ver-4" });
    // Let the held request's continuation run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByTestId("replace-secret-dialog")).toBeTruthy();
  });
});

interface RerenderableDialog {
  readonly requests: EnvironmentSecretsReplaceValueRequest[];
  /** What a re-read of the list does: the same open dialog gets a new secret. */
  readonly showSecret: (secret: EnvironmentSecretV12) => void;
}

function mountRerenderableDialog(
  secret: EnvironmentSecretV12,
  answer: () => Promise<EnvironmentSecretsReplaceValueResponse>,
): RerenderableDialog {
  const requests: EnvironmentSecretsReplaceValueRequest[] = [];
  const { client } = buildBoundClient({
    hostId: HOST_ID,
    handlers: {
      "environment.secrets.replaceValue": (request) => {
        requests.push(request);
        return answer();
      },
    },
  });
  const queryClient = testQueryClient();
  const dialogFor = (shown: EnvironmentSecretV12): ReactNode =>
    underCache(
      queryClient,
      <ReplaceSecretValueDialog
        open
        secret={shown}
        client={client}
        onOpenChange={() => undefined}
        onReplaced={() => undefined}
      />,
    );
  const mounted = render(dialogFor(secret));
  return {
    requests,
    showSecret: (shown) => mounted.rerender(dialogFor(shown)),
  };
}

describe("the Replace value dialog's expected version", () => {
  it("sends the version the list showed when the dialog opened, not one a re-read brought in underneath it", async () => {
    // Another admin rotated the secret while the dialog was open and the list
    // re-read: the person typed against ver-1, so a replace sent against
    // ver-2 would overwrite the other admin's rotation unseen.
    const mounted = mountRerenderableDialog(
      secretFixture({ currentVersionId: "ver-1" }),
      () => Promise.resolve({ outcome: "pending", uploadId: "u1" }),
    );
    mounted.showSecret(secretFixture({ currentVersionId: "ver-2" }));

    typeValue(TYPED);
    fireEvent.click(replaceButton());

    await waitFor(() => {
      expect(mounted.requests).toHaveLength(1);
    });
    expect(mounted.requests[0].expectedVersionId).toBe("ver-1");
  });

  it("sends the version the list shows now once the dialog is closed and opened again", async () => {
    const requests: EnvironmentSecretsReplaceValueRequest[] = [];
    const { client } = buildBoundClient({
      hostId: HOST_ID,
      handlers: {
        "environment.secrets.replaceValue": (request) => {
          requests.push(request);
          return Promise.resolve({ outcome: "pending", uploadId: "u1" });
        },
      },
    });
    const queryClient = testQueryClient();
    const view = render(
      underCache(
        queryClient,
        <ReopenableReplaceDialog
          secret={secretFixture({ currentVersionId: "ver-1" })}
          client={client}
        />,
      ),
    );
    view.rerender(
      underCache(
        queryClient,
        <ReopenableReplaceDialog
          secret={secretFixture({ currentVersionId: "ver-2" })}
          client={client}
        />,
      ),
    );
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("replace-secret-dialog")).toBeNull();
    });
    fireEvent.click(screen.getByTestId("reopen-replace"));
    await screen.findByTestId("replace-secret-dialog");

    typeValue(TYPED);
    fireEvent.click(replaceButton());

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0].expectedVersionId).toBe("ver-2");
  });

  it("retries against the version the re-read list shows after a stale refusal", async () => {
    const mounted = mountRerenderableDialog(
      secretFixture({ currentVersionId: "ver-1" }),
      () =>
        Promise.resolve({
          outcome: "stale",
          currentVersionId: "ver-9",
          changedBy: { kind: "dashboard" },
        }),
    );
    typeValue(TYPED);
    fireEvent.click(replaceButton());
    expect((await screen.findByTestId("replace-secret-note")).textContent).toBe(
      SECRET_REPLACE_STALE,
    );
    mounted.showSecret(secretFixture({ currentVersionId: "ver-9" }));

    fireEvent.click(replaceButton());

    await waitFor(() => {
      expect(mounted.requests).toHaveLength(2);
    });
    expect(
      mounted.requests.map((request) => request.expectedVersionId),
    ).toEqual(["ver-1", "ver-9"]);
  });
});

function mountVersions(
  secret: EnvironmentSecretV12,
  versions: SecretVersion[],
  undoAnswer: EnvironmentSecretsUndoResponse,
): void {
  const { client } = buildBoundClient({
    hostId: HOST_ID,
    handlers: {
      "environment.secrets.versions": () => ({ versions, removal: null }),
      "environment.secrets.undo": () => undoAnswer,
    },
  });
  const queryClient = testQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SecretVersionsList
        secret={secret}
        client={client}
        hostId={HOST_ID}
        onChanged={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("a secret's versions, at their edges", () => {
  it("says only that it didn't go through for an undo refusal code this build has no line for", async () => {
    mountVersions(
      secretFixture({}),
      [
        versionFixture({ versionId: "ver-3", ordinal: 3, current: true }),
        versionFixture({ versionId: "ver-2", ordinal: 2 }),
      ],
      { outcome: "refused", code: "a_code_newer_than_this_build" },
    );

    const rows = await screen.findAllByTestId("secret-version");
    fireEvent.click(within(rows[1]).getByTestId("secret-version-undo"));

    expect((await screen.findByTestId("secret-version-note")).textContent).toBe(
      "That didn't go through.",
    );
  });

  it("reads a destroyed version as destroyed even when the host still marks it current, and offers it nothing", async () => {
    mountVersions(
      secretFixture({}),
      [
        versionFixture({
          versionId: "ver-3",
          ordinal: 3,
          current: true,
          destroyedAt: Date.UTC(2026, 9, 4, 12),
        }),
      ],
      { outcome: "refused", code: "version_destroyed" },
    );

    const rows = await screen.findAllByTestId("secret-version");

    expect(rows[0].getAttribute("data-version-state")).toBe("destroyed");
    expect(within(rows[0]).queryByTestId("secret-version-undo")).toBeNull();
    expect(within(rows[0]).queryByTestId("secret-version-destroy")).toBeNull();
  });
});
