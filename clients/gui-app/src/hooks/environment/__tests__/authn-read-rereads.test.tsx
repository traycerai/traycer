import "../../../../__tests__/test-browser-apis";

// The Personal pages read through the window's own host. Mocked at the scope
// boundary, as the other settings page suites do; the page frame, its status
// read, the app's own reads of authn and the query cache stay real.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return {
    useHostScope,
    useHostScopeFor: useHostScope,
    usePersonalHostScope: useHostScope,
    WINDOW_HOST_SELECTION: {
      scopedHostId: null,
      setScopedHostId: () => undefined,
    },
  };
});

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { useEnvironmentCloudQuery } from "@/hooks/environment/use-environment-cloud";
import { useSecretsRead } from "@/hooks/environment/use-environment-secrets-calls";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  mountTeamPage,
  personalPoolSource,
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const LOCAL_HOST_ID = mockLocalHostEntry.hostId;
const ENVIRONMENT_ID = "env-personal";
const SECRET_ID = "sec-1";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => requireTeamEnvironmentAuthnBinding(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

/** A secret's rotation, as the secrets page reads it: authn's, for a named environment. */
function RotationReader(): ReactNode {
  useSecretsRead({
    method: "environment.secrets.rotation",
    params: { environmentId: ENVIRONMENT_ID, secretId: SECRET_ID },
    enabled: true,
    poll: false,
  });
  return null;
}

function SecretsListReader(): ReactNode {
  useSecretsRead({
    method: "environment.secrets.list",
    params: { environmentId: ENVIRONMENT_ID },
    enabled: true,
    poll: false,
  });
  return null;
}

/** One subject's history, read from authn and never polled. */
function HistoryReader(props: { readonly subjectKey: string }): ReactNode {
  useEnvironmentCloudQuery({
    method: "environment.history",
    params: {
      environmentId: ENVIRONMENT_ID,
      subject: { kind: "variable", key: props.subjectKey },
    },
    cacheKeyIdentity: [],
    mapResponse: (response) => response,
    enabled: true,
    poll: false,
  });
  return null;
}

function mountWindowHost(revision: { current: number }): TeamPageHarness {
  const harness = mountTeamPage(personalPoolSource(), {
    "environment.status": () =>
      environmentStatusFixture({
        principal: { kind: "personal" },
        receivedRevision: revision.current,
        appliedRevision: revision.current,
      }),
    "environment.localOverrides": () => ({ overrides: [] }),
    "environment.list": () => ({
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          ownerKind: "user",
          ownerId: "user-me",
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner",
          kind: "personal",
          hostCount: 1,
          providerHandle: null,
        },
      ],
    }),
    "environment.secrets.list": () => ({ secrets: [], removed: [] }),
    "environment.secrets.rotation": () => ({
      rotation: null,
      lastVerify: null,
    }),
    "environment.history": () => ({
      entries: [],
      readerScope: "full",
      hostStates: [],
    }),
  });
  recordNegotiatedHostManifest(LOCAL_HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
    "environment.localOverrides": { major: 1, minor: 0 },
  });
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: LOCAL_HOST_ID }),
    hostId: LOCAL_HOST_ID,
    status: "ready",
    client: requireTeamHostClient(),
  };
  return harness;
}

function readsOf(harness: TeamPageHarness, method: string): number {
  return harness.paramsOf(method).length;
}

function historyReadsOf(harness: TeamPageHarness, key: string): number {
  return harness
    .paramsOf("environment.history")
    .filter(
      (params) =>
        typeof params === "object" &&
        params !== null &&
        "subject" in params &&
        typeof params.subject === "object" &&
        params.subject !== null &&
        "key" in params.subject &&
        params.subject.key === key,
    ).length;
}

describe("a Personal page on a computer that runs Personal", () => {
  it("reads a secret's rotation from authn again when the host status's revision moves", async () => {
    const revision = { current: 1 };
    const harness = mountWindowHost(revision);
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
    render(
      <PersonalPageFrame section="shell">
        <RotationReader />
      </PersonalPageFrame>,
      { wrapper: harness.Wrapper },
    );
    await waitFor(() => {
      expect(readsOf(harness, "environment.secrets.rotation")).toBe(1);
      expect(readsOf(harness, "environment.list")).toBeGreaterThan(0);
    });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    const before = readsOf(harness, "environment.secrets.rotation");

    revision.current = 2;
    await harness.queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(LOCAL_HOST_ID, "environment.status"),
    });

    await waitFor(() => {
      expect(readsOf(harness, "environment.secrets.rotation")).toBeGreaterThan(
        before,
      );
    });
  });
});

describe("a Local row's page", () => {
  it("reads authn's secrets and the history its page shows again on focus, and not a history nobody observes", async () => {
    const harness = mountWindowHost({ current: 1 });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: LOCAL_HOST_ID, hostName: "Studio" },
    });
    const page = (shown: boolean): ReactNode => (
      <PersonalPageFrame section="secrets">
        <SecretsListReader />
        <HistoryReader subjectKey="SHOWN" />
        {shown ? <HistoryReader subjectKey="UNOBSERVED" /> : null}
      </PersonalPageFrame>
    );
    const view = render(page(true), { wrapper: harness.Wrapper });
    await waitFor(() => {
      expect(readsOf(harness, "environment.secrets.list")).toBe(1);
      expect(historyReadsOf(harness, "SHOWN")).toBe(1);
      expect(historyReadsOf(harness, "UNOBSERVED")).toBe(1);
    });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    // The page stops showing one history; its answer stays cached.
    view.rerender(page(false));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(readsOf(harness, "environment.secrets.list")).toBe(2);
      expect(historyReadsOf(harness, "SHOWN")).toBe(2);
    });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(historyReadsOf(harness, "UNOBSERVED")).toBe(1);
  });
});
