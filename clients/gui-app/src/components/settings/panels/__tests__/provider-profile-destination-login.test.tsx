import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderLoginProfileOutcome,
  ProviderLoginTarget,
  ProviderLoginTargetRefusal,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AddProviderProfileDialog,
  type ProviderTargetLoginControls,
} from "@/components/settings/panels/add-provider-profile-dialog";
import type { ProviderTargetLoginResult } from "@/components/settings/panels/use-provider-profile-login-flow";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

vi.mock("@/lib/links/open-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/open-link")>();
  return { ...actual, useOpenLink: () => () => Promise.resolve() };
});

const HOST_ID = "destination-login";
type AwaitAnswer = ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">;
const TARGET: ProviderLoginTarget = {
  kind: "leave-to-local",
  profileId: "personal-folder",
};
const ENVIRONMENT_TARGET: ProviderLoginTarget = {
  kind: "environment",
  environmentId: "team-environment",
  profileId: null,
};
const LIST_KEY = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
  HOST_ID,
  "providers.list",
  { native: null },
);

interface DestinationHarness {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly results: Mock<
    (
      result: ProviderTargetLoginResult,
      controls: ProviderTargetLoginControls,
    ) => ReactNode
  >;
  readonly listReads: () => number;
}

function providerProfile(): ProviderProfile {
  return { ...profile("work", "managed"), label: "Work" };
}

function loginStartAnswer(refusal: ProviderLoginTargetRefusal | null): {
  readonly started: boolean;
  readonly profileId: string | null;
  readonly url: string | null;
  readonly userCode: string | null;
  readonly failure: null;
  readonly pending: null;
  readonly pack: null;
  readonly targetRefusal: ProviderLoginTargetRefusal | null;
} {
  return refusal === null
    ? {
        started: true,
        profileId: "leave-admission",
        url: "https://example.test/sign-in",
        userCode: null,
        failure: null,
        pending: null,
        pack: null,
        targetRefusal: null,
      }
    : {
        started: false,
        profileId: null,
        url: null,
        userCode: null,
        failure: null,
        pending: null,
        pack: null,
        targetRefusal: refusal,
      };
}

function loginAwaitAnswer(
  outcome: ProviderLoginProfileOutcome | null,
): AwaitAnswer {
  return {
    state: null,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: outcome,
  };
}

function renderDestinationDialog(input: {
  readonly target: ProviderLoginTarget;
  readonly refusal: ProviderLoginTargetRefusal | null;
  readonly awaitAnswer: AwaitAnswer;
  readonly startVersion: { readonly major: number; readonly minor: number };
  readonly awaitVersion: { readonly major: number; readonly minor: number };
}): DestinationHarness {
  const providerState = provider("claude-code", [providerProfile()]);
  let listReads = 0;
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        listReads += 1;
        return { providers: [providerState], native: null };
      },
      "providers.startLogin": () => loginStartAnswer(input.refusal),
      "providers.awaitLogin": () => input.awaitAnswer,
      "providers.cancelLogin": () => ({ cancelled: true }),
    },
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.startLogin": input.startVersion,
    "providers.awaitLogin": input.awaitVersion,
    "providers.cancelLogin": { major: 1, minor: 2 },
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const results = vi.fn<
    (
      result: ProviderTargetLoginResult,
      controls: ProviderTargetLoginControls,
    ) => ReactNode
  >((_result, controls) => (
    <>
      <output data-testid="target-accent-color">{controls.accentColor}</output>
      <button type="button" onClick={controls.onSignInWithAnother}>
        Sign in with another account
      </button>
    </>
  ));
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AddProviderProfileDialog
          state={providerState}
          client={client}
          isLocalHost
          open
          target={input.target}
          targetResult={results}
          onOpenChange={vi.fn()}
          onFailedAttempt={vi.fn()}
          onProfileCreated={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { messenger, queryClient, results, listReads: () => listReads };
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  vi.clearAllMocks();
});

describe("targeted sign-in in the Add dialog", () => {
  it("forwards the leave folder and staged handle without reading or writing Personal profiles", async () => {
    const outcome: ProviderLoginProfileOutcome = {
      kind: "staged-for-leave",
      profileId: "personal-folder",
    };
    const harness = renderDestinationDialog({
      target: TARGET,
      refusal: null,
      awaitAnswer: loginAwaitAnswer(outcome),
      startVersion: { major: 1, minor: 5 },
      awaitVersion: { major: 2, minor: 4 },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(harness.results).toHaveBeenCalledWith(
        {
          ...loginAwaitAnswer(outcome),
          kind: "target-outcome",
          profileOutcome: outcome,
          admissionId: "leave-admission",
        },
        expect.objectContaining({ accentColor: "#ef4444" }),
      ),
    );
    const starts = harness.messenger.calls.filter(
      (call) => call.method === "providers.startLogin",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params).toMatchObject({ target: TARGET });
    expect(starts[0]?.requiredHostMethodVersion).toEqual({
      method: "providers.startLogin",
      version: { major: 1, minor: 5 },
    });
    const awaits = harness.messenger.calls.filter(
      (call) => call.method === "providers.awaitLogin",
    );
    expect(awaits).toHaveLength(1);
    expect(awaits[0]?.requiredHostMethodVersion).toEqual({
      method: "providers.awaitLogin",
      version: { major: 2, minor: 4 },
    });
    expect(awaits[0]?.params).toMatchObject({
      providerId: "claude-code",
      profileId: "leave-admission",
    });
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.list",
      ),
    ).toEqual([]);
    expect(harness.listReads()).toBe(0);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toBeUndefined();
    expect(screen.getByTestId("target-accent-color").textContent).toBe(
      "#ef4444",
    );
  });

  it("forwards an argument-specific start refusal without an untargeted retry", async () => {
    const harness = renderDestinationDialog({
      target: TARGET,
      refusal: "invalid-leave-profile",
      awaitAnswer: loginAwaitAnswer(null),
      startVersion: { major: 1, minor: 5 },
      awaitVersion: { major: 2, minor: 4 },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(harness.results).toHaveBeenCalledWith(
        {
          kind: "target-refused",
          targetRefusal: "invalid-leave-profile",
        },
        expect.any(Object),
      ),
    );
    const starts = harness.messenger.calls.filter(
      (call) => call.method === "providers.startLogin",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params).toMatchObject({ target: TARGET });
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.awaitLogin",
      ),
    ).toEqual([]);
  });

  it("returns unsupported-computer when the start floor is not negotiated and sends no start", async () => {
    const harness = renderDestinationDialog({
      target: TARGET,
      refusal: null,
      awaitAnswer: loginAwaitAnswer(null),
      startVersion: { major: 1, minor: 4 },
      awaitVersion: { major: 2, minor: 4 },
    });

    await waitFor(() =>
      expect(harness.results).toHaveBeenCalledWith(
        {
          kind: "target-refused",
          targetRefusal: "unsupported-computer",
        },
        expect.any(Object),
      ),
    );
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.startLogin",
      ),
    ).toEqual([]);
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.awaitLogin",
      ),
    ).toEqual([]);
  });

  it("returns unsupported-computer when the await floor is not negotiated and sends no start", async () => {
    const harness = renderDestinationDialog({
      target: TARGET,
      refusal: null,
      awaitAnswer: loginAwaitAnswer(null),
      startVersion: { major: 1, minor: 5 },
      awaitVersion: { major: 2, minor: 3 },
    });

    await waitFor(() =>
      expect(harness.results).toHaveBeenCalledWith(
        {
          kind: "target-refused",
          targetRefusal: "unsupported-computer",
        },
        expect.any(Object),
      ),
    );
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.startLogin",
      ),
    ).toEqual([]);
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.awaitLogin",
      ),
    ).toEqual([]);
  });

  it("forwards the old await keys when a targeted answer has no profile outcome", async () => {
    const awaitAnswer: AwaitAnswer = {
      state: provider("claude-code", [providerProfile()]),
      existingProfileId: "existing-row",
      codeRejected: true,
      refusal: {
        reason: "The provider refused this sign-in.",
        actionUrl: null,
      },
      installation: {
        kind: "waiting-for-readers",
        admissionId: "install-admission",
        count: 2,
      },
      profileOutcome: null,
    };
    const harness = renderDestinationDialog({
      target: TARGET,
      refusal: null,
      awaitAnswer,
      startVersion: { major: 1, minor: 5 },
      awaitVersion: { major: 2, minor: 4 },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(harness.results).toHaveBeenCalledWith(
        {
          ...awaitAnswer,
          kind: "target-outcome",
          profileOutcome: null,
          admissionId: "leave-admission",
        },
        expect.objectContaining({ accentColor: "#ef4444" }),
      ),
    );
    expect(harness.listReads()).toBe(0);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toBeUndefined();
  });

  it.each([
    { kind: "account-mismatch" },
    { kind: "account-unproven" },
  ] as const)(
    "forwards the raw $kind outcome to its caller",
    async ({ kind }) => {
      const outcome: ProviderLoginProfileOutcome = { kind };
      const harness = renderDestinationDialog({
        target: TARGET,
        refusal: null,
        awaitAnswer: loginAwaitAnswer(outcome),
        startVersion: { major: 1, minor: 5 },
        awaitVersion: { major: 2, minor: 4 },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

      await waitFor(() =>
        expect(harness.results).toHaveBeenCalledWith(
          {
            ...loginAwaitAnswer(outcome),
            kind: "target-outcome",
            profileOutcome: outcome,
            admissionId: "leave-admission",
          },
          expect.objectContaining({ accentColor: "#ef4444" }),
        ),
      );
    },
  );

  it("restarts an environment sign-in with its current name and exposes its selected color", async () => {
    const outcome: ProviderLoginProfileOutcome = { kind: "account-mismatch" };
    const harness = renderDestinationDialog({
      target: ENVIRONMENT_TARGET,
      refusal: null,
      awaitAnswer: loginAwaitAnswer(outcome),
      startVersion: { major: 1, minor: 5 },
      awaitVersion: { major: 2, minor: 4 },
    });

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Chosen work" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByRole("button", { name: "Sign in with another account" });

    expect(screen.getByTestId("target-accent-color").textContent).toBe(
      "#ef4444",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with another account" }),
    );
    await waitFor(() =>
      expect(
        harness.messenger.calls.filter(
          (call) => call.method === "providers.startLogin",
        ),
      ).toHaveLength(2),
    );
    const starts = harness.messenger.calls.filter(
      (call) => call.method === "providers.startLogin",
    );
    expect(starts[1]?.params).toMatchObject({
      target: ENVIRONMENT_TARGET,
      createProfile: { label: "Chosen work" },
    });
  });
});
