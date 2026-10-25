// The form's links are not opened here; the mock only keeps the real opener
// (which needs the app shell) out of the render.
const openLinkMock = vi.hoisted(() => vi.fn<OpenLink>());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));
// The computers holding a copy are covered by `secret-remove-preview-computers`;
// a team page names none.
vi.mock("@/components/settings/personal/use-personal-computers", () => ({
  usePersonalComputers: () => ({
    computers: [],
    statuses: new Map(),
    versions: new Map(),
    participants: [],
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

import type { QueryClient } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  EnvironmentSecret,
  EnvironmentSecretsCreateResponse,
  EnvironmentSecretsReplaceValueResponse,
  SecretVerifyResult,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import {
  mountTeamPage,
  mountTeamPageNegotiating,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import type { HostRpcRegistry } from "@/lib/host";
import type { OpenLink } from "@/lib/links/open-link";
import { settingsDetailsMutationKeys } from "@/lib/query-keys/settings-details-query-keys";
import { SECRETS_NEED_UPDATED_HOST } from "@/lib/sandboxes/secrets-page-copy";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * A team's Add a secret (Verify and Save) and Replace value go through the
 * host mutation hooks: each request carries the team's environment and the
 * @1.1 floor, the mutation's variables never carry the typed value, the
 * button stays disabled while the request is in flight, a host below the
 * floor reads as needing an update, and a save re-reads the team's secrets.
 */

const AT = Date.UTC(2026, 9, 20, 9, 30);
const TYPED_VALUE = 'team"s\\ecret-UNIQUE-4410';
const FLOOR = { major: 1, minor: 1 } as const;

function secretFixture(): EnvironmentSecret {
  return {
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: null,
    destinations: [],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-2",
    revoked: false,
    updatedAt: AT,
  };
}

function versionsFixture(): SecretVersion[] {
  return [
    {
      versionId: "ver-2",
      ordinal: 2,
      createdAt: AT,
      supersededAt: null,
      destroyedAt: null,
      current: true,
      rotationState: null,
    },
  ];
}

/** A host answer the test releases by hand, so the in-flight state is seen. */
interface Held<Response> {
  readonly promise: Promise<Response>;
  readonly release: (response: Response) => void;
}

function held<Response>(): Held<Response> {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface TeamSecretsHost {
  readonly create: Held<EnvironmentSecretsCreateResponse>;
  readonly verify: Held<SecretVerifyResult>;
  readonly replace: Held<EnvironmentSecretsReplaceValueResponse>;
}

function teamSecretsHost(): TeamSecretsHost {
  return { create: held(), verify: held(), replace: held() };
}

function handlersFor(host: TeamSecretsHost): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.list": () => ({ environments: [] }),
    "environment.secrets.list": () => ({
      secrets: [secretFixture()],
      removed: [],
    }),
    "environment.secrets.versions": () => ({
      versions: versionsFixture(),
      removal: null,
    }),
    "environment.secrets.rotation": () => ({
      rotation: null,
      lastVerify: null,
    }),
    "environment.secrets.create": () => host.create.promise,
    "environment.secrets.verify": () => host.verify.promise,
    "environment.secrets.replaceValue": () => host.replace.promise,
  };
}

function renderPage(harness: TeamPageHarness): void {
  const client = requireTeamHostClient();
  render(
    <SecretsPage
      client={client}
      hostId={client.getActiveHostId()}
      hostName={(hostId) => hostId}
    />,
    { wrapper: harness.Wrapper },
  );
}

function mountTeam(host: TeamSecretsHost): TeamPageHarness {
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPage(poolSource("editor"), handlersFor(host));
  renderPage(harness);
  return harness;
}

/** The team's host negotiated `method` at @1.0, below the floor. */
function mountTeamBelowFloor(method: string): TeamPageHarness {
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPageNegotiating(
    poolSource("editor"),
    handlersFor(teamSecretsHost()),
    { [method]: { major: 1, minor: 0 } },
  );
  renderPage(harness);
  return harness;
}

function buttonOf(testId: string): HTMLButtonElement {
  const element = screen.getByTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`${testId} is not a button`);
  }
  return element;
}

async function openFilledApiKeyForm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("secrets-add"));
  fireEvent.click(await screen.findByTestId("secret-kind-option-api_key"));
  fireEvent.change(await screen.findByTestId("secret-form-name"), {
    target: { value: "STRIPE_KEY" },
  });
  fireEvent.change(screen.getByTestId("secret-form-hosts"), {
    target: { value: "api.stripe.com" },
  });
  fireEvent.change(screen.getByTestId("secret-form-value"), {
    target: { value: TYPED_VALUE },
  });
}

async function openReplaceWithValue(): Promise<void> {
  fireEvent.click(await screen.findByTestId("secret-row-replace"));
  fireEvent.change(await screen.findByTestId("replace-secret-value"), {
    target: { value: TYPED_VALUE },
  });
}

function callsOf(harness: TeamPageHarness, method: string) {
  return harness.messenger.calls.filter((call) => call.method === method);
}

/** The one mutation under `mutationKey`, with nothing of the typed value. */
function onlyMutation(
  queryClient: QueryClient,
  mutationKey: readonly string[],
) {
  const mutations = queryClient
    .getMutationCache()
    .findAll({ mutationKey, exact: true });
  expect(mutations).toHaveLength(1);
  const [mutation] = mutations;
  const serialized = JSON.stringify(mutation.state);
  expect(serialized).not.toContain(TYPED_VALUE);
  expect(serialized).not.toContain(JSON.stringify(TYPED_VALUE).slice(1, -1));
  return mutation;
}

function listReads(harness: TeamPageHarness): number {
  return harness.paramsOf("environment.secrets.list").length;
}

beforeEach(() => {
  openLinkMock.mockResolvedValue(undefined);
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  openLinkMock.mockReset();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("a team secret's writes go through the host mutations", () => {
  it("saves through the create mutation, disabled while in flight, then re-reads the team's secrets", async () => {
    const host = teamSecretsHost();
    const harness = mountTeam(host);
    await openFilledApiKeyForm();
    fireEvent.click(buttonOf("secret-form-continue"));
    fireEvent.click(await screen.findByTestId("secret-save"));

    await waitFor(() => {
      expect(callsOf(harness, "environment.secrets.create")).toHaveLength(1);
    });
    const [call] = callsOf(harness, "environment.secrets.create");
    expect(call.params).toMatchObject({
      environmentId: "env-a",
      name: "STRIPE_KEY",
      value: TYPED_VALUE,
    });
    expect(call.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.create",
      version: FLOOR,
    });
    const mutation = onlyMutation(
      harness.queryClient,
      settingsDetailsMutationKeys.secretCreate(),
    );
    expect(mutation.state.status).toBe("pending");
    expect(buttonOf("secret-save").disabled).toBe(true);
    const readsBefore = listReads(harness);

    host.create.release({ outcome: "created", secret: secretFixture() });

    await waitFor(() => {
      expect(screen.queryByTestId("add-secret-dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(listReads(harness)).toBe(readsBefore + 1);
    });
    expect(
      onlyMutation(
        harness.queryClient,
        settingsDetailsMutationKeys.secretCreate(),
      ).state.status,
    ).toBe("success");
  });

  it("verifies the typed value through the candidate verify mutation, disabled while in flight", async () => {
    const host = teamSecretsHost();
    const harness = mountTeam(host);
    await openFilledApiKeyForm();
    fireEvent.click(buttonOf("secret-form-verify"));

    await waitFor(() => {
      expect(callsOf(harness, "environment.secrets.verify")).toHaveLength(1);
    });
    const [call] = callsOf(harness, "environment.secrets.verify");
    expect(call.params).toMatchObject({
      target: "candidate",
      environmentId: "env-a",
      value: TYPED_VALUE,
    });
    expect(call.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.verify",
      version: FLOOR,
    });
    const mutation = onlyMutation(
      harness.queryClient,
      settingsDetailsMutationKeys.secretVerifyCandidate(),
    );
    expect(mutation.state.status).toBe("pending");
    expect(buttonOf("secret-form-verify").disabled).toBe(true);
    expect(buttonOf("secret-form-continue").disabled).toBe(true);

    host.verify.release({ evidence: "probe_accepted" });

    expect(
      (await screen.findByTestId("secret-form-verify-line")).textContent,
    ).toBe(
      "Reached the destination. The key is checked the first time an agent uses it.",
    );
    expect(buttonOf("secret-form-verify").disabled).toBe(false);
  });

  it("replaces through the replace mutation, disabled while in flight, then re-reads the team's secrets", async () => {
    const host = teamSecretsHost();
    const harness = mountTeam(host);
    await openReplaceWithValue();
    fireEvent.click(buttonOf("replace-secret-confirm"));

    await waitFor(() => {
      expect(callsOf(harness, "environment.secrets.replaceValue")).toHaveLength(
        1,
      );
    });
    const [call] = callsOf(harness, "environment.secrets.replaceValue");
    expect(call.params).toEqual({
      secretId: "sec-1",
      value: TYPED_VALUE,
      expectedVersionId: "ver-2",
      environmentId: "env-a",
    });
    expect(call.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.replaceValue",
      version: FLOOR,
    });
    const mutation = onlyMutation(
      harness.queryClient,
      settingsDetailsMutationKeys.secretReplaceValue(),
    );
    expect(mutation.state.status).toBe("pending");
    expect(mutation.state.variables).toEqual({
      secretId: "sec-1",
      expectedVersionId: "ver-2",
    });
    expect(buttonOf("replace-secret-confirm").disabled).toBe(true);
    const readsBefore = listReads(harness);

    host.replace.release({
      outcome: "accepted",
      rotationId: "rot-1",
      versionId: "ver-3",
    });

    await waitFor(() => {
      expect(screen.queryByTestId("replace-secret-dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(listReads(harness)).toBe(readsBefore + 1);
    });
  });
});

describe("a team's host below a secret write's floor", () => {
  it("says the secrets need an updated host when Save is refused, and sends nothing", async () => {
    const harness = mountTeamBelowFloor("environment.secrets.create");
    await openFilledApiKeyForm();
    fireEvent.click(buttonOf("secret-form-continue"));
    fireEvent.click(await screen.findByTestId("secret-save"));

    expect((await screen.findByTestId("secret-save-note")).textContent).toBe(
      SECRETS_NEED_UPDATED_HOST,
    );
    expect(harness.paramsOf("environment.secrets.create")).toEqual([]);
  });

  it("says the secrets need an updated host when Verify is refused, and sends nothing", async () => {
    const harness = mountTeamBelowFloor("environment.secrets.verify");
    await openFilledApiKeyForm();
    fireEvent.click(buttonOf("secret-form-verify"));

    expect(
      (await screen.findByTestId("secret-form-verify-line")).textContent,
    ).toBe(SECRETS_NEED_UPDATED_HOST);
    expect(harness.paramsOf("environment.secrets.verify")).toEqual([]);
  });

  it("says the secrets need an updated host when Replace is refused, and sends nothing", async () => {
    const harness = mountTeamBelowFloor("environment.secrets.replaceValue");
    await openReplaceWithValue();
    fireEvent.click(buttonOf("replace-secret-confirm"));

    expect((await screen.findByTestId("replace-secret-note")).textContent).toBe(
      SECRETS_NEED_UPDATED_HOST,
    );
    expect(harness.paramsOf("environment.secrets.replaceValue")).toEqual([]);
  });
});
