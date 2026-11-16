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
import type { HostRpcRegistry } from "@/lib/host";
import { ReplaceSecretValueDialog } from "@/components/settings/secrets/replace-secret-value-dialog";
import { SecretVersionsList } from "@/components/settings/secrets/secret-versions-list";
import {
  mountTeamPage,
  personalPoolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { SECRET_REPLACE_STALE } from "@/lib/sandboxes/secrets-page-copy";
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
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

// The edges of Replace value and of the versions
// list that `secret-row-rotation.test.tsx` reaches only through the whole
// Secrets page. Each case here is a claim a mutation of the dialog or the
// list survived: the disabled gate, note clearing while a retry is in flight,
// an unknown refusal's fallback and a destroyed version winning over `current`.

const HOST_ID = "host-edges";
const TYPED = "sk_live_EDGE_VALUE_77aa";

function secretFixture(
  overrides: Partial<EnvironmentSecretV12>,
): EnvironmentSecretV12 {
  return {
    ...RETIRED_SECRET_ROW_FIELDS,
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: "https",
    destinations: ["api.stripe.com"],
    currentVersionId: "ver-3",
    revoked: false,
    updatedAt: 1,
    variables: [],
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
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "personal" },
  });
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  hostBoundary.client = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function buttonOf(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("the element is not a button");
  }
  return element;
}

interface DialogMount {
  readonly requests: EnvironmentSecretsReplaceValueRequest[];
  readonly onReplaced: Mock<() => void>;
}

function mountDialog(
  secret: EnvironmentSecretV12,
  answer: () => Promise<EnvironmentSecretsReplaceValueResponse>,
): DialogMount {
  const requests: EnvironmentSecretsReplaceValueRequest[] = [];
  const harness = mountTeamPage(personalPoolSource(), {
    "environment.secrets.replaceValue": (request) => {
      requests.push(request);
      return answer();
    },
  });
  const client = requireTeamHostClient();
  hostBoundary.client = client;
  const onReplaced = vi.fn<() => void>();
  render(
    <ReplaceSecretValueDialog
      open
      secret={secret}
      client={client}
      onOpenChange={() => undefined}
      onReplaced={onReplaced}
    />,
    { wrapper: harness.Wrapper },
  );
  return { requests, onReplaced };
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
    release({ outcome: "accepted", rotationId: "rot-1", versionId: "ver-4" });
    await waitFor(() => {
      expect(mounted.onReplaced).toHaveBeenCalledOnce();
    });
    expect(screen.queryByTestId("replace-secret-note")).toBeNull();
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
    const harness = mountTeamPage(personalPoolSource(), {
      "environment.secrets.replaceValue": (request) => {
        requests.push(request);
        return new Promise<EnvironmentSecretsReplaceValueResponse>(
          (resolve) => {
            release = resolve;
          },
        );
      },
    });
    const client = requireTeamHostClient();
    hostBoundary.client = client;
    render(
      <ReopenableReplaceDialog secret={secretFixture({})} client={client} />,
      { wrapper: harness.Wrapper },
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
  const harness = mountTeamPage(personalPoolSource(), {
    "environment.secrets.replaceValue": (request) => {
      requests.push(request);
      return answer();
    },
  });
  const client = requireTeamHostClient();
  hostBoundary.client = client;
  const dialogFor = (shown: EnvironmentSecretV12): ReactNode => (
    <ReplaceSecretValueDialog
      open
      secret={shown}
      client={client}
      onOpenChange={() => undefined}
      onReplaced={() => undefined}
    />
  );
  const mounted = render(dialogFor(secret), { wrapper: harness.Wrapper });
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
      () =>
        Promise.resolve({
          outcome: "accepted",
          rotationId: "rot-1",
          versionId: "ver-4",
        }),
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
    const harness = mountTeamPage(personalPoolSource(), {
      "environment.secrets.replaceValue": (request) => {
        requests.push(request);
        return Promise.resolve({
          outcome: "accepted",
          rotationId: "rot-1",
          versionId: "ver-4",
        });
      },
    });
    const client = requireTeamHostClient();
    hostBoundary.client = client;
    const view = render(
      <ReopenableReplaceDialog
        secret={secretFixture({ currentVersionId: "ver-1" })}
        client={client}
      />,
      { wrapper: harness.Wrapper },
    );
    view.rerender(
      <ReopenableReplaceDialog
        secret={secretFixture({ currentVersionId: "ver-2" })}
        client={client}
      />,
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
  const harness = mountTeamPage(personalPoolSource(), {
    "environment.secrets.versions": () => ({ versions, removal: null }),
    "environment.secrets.undo": () => undoAnswer,
  });
  const client = requireTeamHostClient();
  hostBoundary.client = client;
  render(
    <SecretVersionsList
      secret={secret}
      client={client}
      hostId={HOST_ID}
      onChanged={() => undefined}
    />,
    { wrapper: harness.Wrapper },
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
