import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentCloud,
  EnvironmentCloudSource,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ProvidersNativeMutateResponseV15 } from "@traycer/protocol/host/provider-schemas";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersPromoteToPersonal } from "@/hooks/providers/use-providers-promote-to-personal-mutation";
import {
  negotiateMethods,
  WINDOW_HOST_ID,
} from "@/components/settings/environment/__tests__/mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

const cloudHarness = vi.hoisted(() => ({
  source: null as EnvironmentCloudSource | null,
}));
const toastHarness = vi.hoisted(() => ({ messages: [] as string[] }));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/environment/use-environment-cloud", () => ({
  useEnvironmentCloud: () => cloudHarness.source,
}));
vi.mock("@/hooks/environment/use-executable-write-grant", () => ({
  useExecutableWriteGrant: () => async (request: unknown) => request,
}));
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (_error: unknown, fallback: string) => {
    toastHarness.messages.push(fallback);
  },
}));

const PROMOTED: ProvidersNativeMutateResponseV15 = {
  result: { ok: true, kind: "mcp", servers: [] },
};
const SERVER_ID = "00000000-0000-4000-8000-000000000002";

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve: (value: Value) => void = () => {
    throw new Error("Deferred promise was not initialized.");
  };
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function binding(sharingGeneration: number | null) {
  return {
    hostId: WINDOW_HOST_ID,
    environment: {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
    },
    explicit: true,
    enrolledByUserId: "u-1",
    canUnbind: false,
    sharingGeneration,
  };
}

function makeCloud(
  transport: EnvironmentCloud["transport"],
  onOriginSignIn: () => boolean = () => true,
): EnvironmentCloud {
  return {
    authnBaseUrl: "https://authn.example.test/",
    bearer: {
      kind: "cloud",
      getBearerToken: () => "synthetic-test-bearer",
    },
    transport,
    onOriginSignIn,
  };
}

function stateCloud(
  state: "consumed" | "pending" | "ended" | "read-failed",
  requests: EnvironmentTransportRequest[],
  recordStatus = 200,
): EnvironmentCloud {
  return makeCloud(async (request) => {
    requests.push(request);
    if (request.method === "POST") {
      return {
        status: recordStatus,
        text: JSON.stringify({
          operationId: "00000000-0000-4000-8000-000000000001",
          endsAt: 2_000_000_000,
        }),
      };
    }
    if (state === "read-failed") return { status: 503, text: "" };
    return {
      status: 200,
      text: JSON.stringify(
        state === "consumed"
          ? { state, mcpServerId: SERVER_ID }
          : state === "pending"
            ? { state, endsAt: 2_000_000_000 }
            : { state },
      ),
    };
  });
}

function installListRead(queryClient: QueryClient): () => boolean {
  const key = hostQueryKeys.method<
    HostRpcRegistry,
    "environment.configuration.mcpServers.list"
  >(WINDOW_HOST_ID, "environment.configuration.mcpServers.list", {
    environmentId: "env-a",
  });
  queryClient.setQueryData(key, { servers: [] });
  return () =>
    queryClient.getQueryCache().find({ queryKey: key })?.state.isInvalidated ??
    false;
}

async function runPromote(args: {
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
  readonly cloud: EnvironmentCloudSource | null;
  readonly entryKind?: "mcp" | "skills";
}) {
  cloudHarness.source = args.cloud;
  negotiateMethods({
    "environment.host.read": { major: 1, minor: 1 },
    "providers.nativeMutate": { major: 1, minor: 5 },
  });
  const host = mountTeamPage(poolSource("editor"), args.handlers);
  const rendered = renderHook(() => useProvidersPromoteToPersonal("Acme"), {
    wrapper: host.Wrapper,
  });
  const input = {
    providerId: "claude-code" as const,
    entryKind: args.entryKind ?? "mcp",
    scope: "global" as const,
    workspaceRoot: null,
    name: "scratch",
    expectedEnvironmentId: "env-a",
  };
  return { host, rendered, input };
}

afterEach(() => {
  cleanup();
  cloudHarness.source = null;
  toastHarness.messages = [];
  resetTeamPageHarness();
});

describe("useProvidersPromoteToPersonal", () => {
  it("records the bound MCP server, sends the same operation id, and refreshes lists when consumed", async () => {
    const requests: EnvironmentTransportRequest[] = [];
    const nativeRequests: unknown[] = [];
    const cloud = stateCloud("consumed", requests);
    const result = await runPromote({
      cloud: () => cloud,
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": (request) => {
          nativeRequests.push(request);
          return PROMOTED;
        },
      },
    });
    const invalidated = installListRead(result.host.queryClient);
    let outcome: Awaited<
      ReturnType<typeof result.rendered.result.current.mutateAsync>
    >;

    await act(async () => {
      outcome = await result.rendered.result.current.mutateAsync(result.input);
    });

    expect(outcome!).toEqual({ kind: "added" });
    const operationId = bodyOperationId(requests[0]);
    expect(requests[0]?.body).toEqual({
      operationId,
      kind: "mcp_promote",
      sourceHostId: WINDOW_HOST_ID,
      sourceSharingGeneration: 7,
      serverName: "scratch",
    });
    expect(nativeRequests).toMatchObject([
      { mutation: { intentOperationId: operationId } },
    ]);
    expect(requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    await waitFor(() => expect(invalidated()).toBe(true));
  });

  it("shows the failure line and refreshes lists while the intent is pending", async () => {
    const requests: EnvironmentTransportRequest[] = [];
    const cloud = stateCloud("pending", requests);
    const result = await runPromote({
      cloud: () => cloud,
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": () => PROMOTED,
      },
    });
    const invalidated = installListRead(result.host.queryClient);
    let outcome: Awaited<
      ReturnType<typeof result.rendered.result.current.mutateAsync>
    >;

    await act(async () => {
      outcome = await result.rendered.result.current.mutateAsync(result.input);
    });

    expect(outcome!).toEqual({
      kind: "refused",
      text: "Couldn't add it to Acme.",
      refreshLists: true,
    });
    await waitFor(() => expect(invalidated()).toBe(true));
  });

  it.each(["ended", "read-failed"] as const)(
    "shows the failure line without refreshing lists when the intent is %s",
    async (state) => {
      const requests: EnvironmentTransportRequest[] = [];
      const cloud = stateCloud(state, requests);
      const result = await runPromote({
        cloud: () => cloud,
        handlers: {
          "environment.host.read": () => binding(7),
          "providers.nativeMutate": () => PROMOTED,
        },
      });
      const invalidated = installListRead(result.host.queryClient);
      let outcome: Awaited<
        ReturnType<typeof result.rendered.result.current.mutateAsync>
      >;

      await act(async () => {
        outcome = await result.rendered.result.current.mutateAsync(
          result.input,
        );
      });

      expect(outcome).toEqual({
        kind: "refused",
        text: "Couldn't add it to Acme.",
        refreshLists: false,
      });
      expect(invalidated()).toBe(false);
    },
  );

  it("does not send the host promote when recording the intent fails", async () => {
    const requests: EnvironmentTransportRequest[] = [];
    const cloud = stateCloud("consumed", requests, 503);
    const nativeRequests: unknown[] = [];
    const result = await runPromote({
      cloud: () => cloud,
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": (request) => {
          nativeRequests.push(request);
          return PROMOTED;
        },
      },
    });

    await act(async () => {
      await result.rendered.result.current.mutateAsync(result.input);
    });

    expect(requests.map(({ method }) => method)).toEqual(["POST"]);
    expect(nativeRequests).toEqual([]);
  });

  it("does not record on B or upload after the binding read switches sign-ins", async () => {
    const account = { current: "A" };
    const aRequests: EnvironmentTransportRequest[] = [];
    const bRequests: EnvironmentTransportRequest[] = [];
    const cloudA = makeCloud(
      async (request) => {
        aRequests.push(request);
        return { status: 200, text: "{}" };
      },
      () => account.current === "A",
    );
    const cloudB = makeCloud(
      async (request) => {
        bRequests.push(request);
        return { status: 200, text: "{}" };
      },
      () => account.current === "B",
    );
    const bindingRead = deferred<ReturnType<typeof binding>>();
    const bindingStarted = deferred<void>();
    const nativeRequests: unknown[] = [];
    const result = await runPromote({
      cloud: () => (account.current === "A" ? cloudA : cloudB),
      handlers: {
        "environment.host.read": () => {
          bindingStarted.resolve();
          return bindingRead.promise;
        },
        "providers.nativeMutate": (request) => {
          nativeRequests.push(request);
          return PROMOTED;
        },
      },
    });
    let mutation: Promise<unknown> | undefined;
    await act(async () => {
      mutation = result.rendered.result.current.mutateAsync(result.input);
      await Promise.resolve();
    });
    await bindingStarted.promise;
    account.current = "B";
    bindingRead.resolve(binding(7));
    let outcome: unknown;
    await act(async () => {
      outcome = await mutation;
    });

    expect(outcome).toMatchObject({
      kind: "refused",
      text: "Couldn't add it to Acme.",
    });
    expect(aRequests).toEqual([]);
    expect(bRequests).toEqual([]);
    expect(nativeRequests).toEqual([]);
  });

  it("does not read a recorded intent on B after the host upload started on A", async () => {
    const account = { current: "A" };
    const aRequests: EnvironmentTransportRequest[] = [];
    const bRequests: EnvironmentTransportRequest[] = [];
    const recordResponse = deferred<{
      readonly status: number;
      readonly text: string;
    }>();
    const recordStarted = deferred<void>();
    const hostUpload = deferred<ProvidersNativeMutateResponseV15>();
    const hostUploadStarted = deferred<void>();
    const accountCloud = (
      name: "A" | "B",
      requests: EnvironmentTransportRequest[],
    ): EnvironmentCloud =>
      makeCloud(
        async (request) => {
          requests.push(request);
          if (request.method === "POST") {
            recordStarted.resolve();
            return recordResponse.promise;
          }
          return {
            status: 200,
            text: JSON.stringify({
              state: "consumed",
              mcpServerId: SERVER_ID,
            }),
          };
        },
        () => account.current === name,
      );
    const cloudA = accountCloud("A", aRequests);
    const cloudB = accountCloud("B", bRequests);
    const result = await runPromote({
      cloud: () => (account.current === "A" ? cloudA : cloudB),
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": () => {
          hostUploadStarted.resolve();
          return hostUpload.promise;
        },
      },
    });
    let mutation: Promise<unknown> | undefined;
    await act(async () => {
      mutation = result.rendered.result.current.mutateAsync(result.input);
      await Promise.resolve();
    });
    await recordStarted.promise;
    recordResponse.resolve({
      status: 200,
      text: JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000001",
        endsAt: 2_000_000_000,
      }),
    });
    await hostUploadStarted.promise;
    account.current = "B";
    hostUpload.resolve(PROMOTED);
    let outcome: unknown;
    await act(async () => {
      outcome = await mutation;
    });

    expect(outcome).toMatchObject({
      kind: "refused",
      text: "Couldn't add it to Acme.",
    });
    expect(aRequests.map(({ method }) => method)).toEqual(["POST"]);
    expect(bRequests).toEqual([]);
  });

  it("does not record or promote when sharing generation is null or cloud is absent", async () => {
    const requests: EnvironmentTransportRequest[] = [];
    const nativeRequests: unknown[] = [];
    const cloud = stateCloud("consumed", requests);
    for (const sharingGeneration of [null, 7] as const) {
      const result = await runPromote({
        cloud: sharingGeneration === null ? () => cloud : null,
        handlers: {
          "environment.host.read": () => binding(sharingGeneration),
          "providers.nativeMutate": (request) => {
            nativeRequests.push(request);
            return PROMOTED;
          },
        },
      });

      await act(async () => {
        await result.rendered.result.current.mutateAsync(result.input);
      });
      expect(nativeRequests).toEqual([]);
    }
    expect(requests).toEqual([]);
  });

  it("uses the old 1.4 promote arm with a null intent id", async () => {
    const nativeRequests: unknown[] = [];
    const result = await runPromote({
      cloud: null,
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": (request) => {
          nativeRequests.push(request);
          return PROMOTED;
        },
      },
    });
    negotiateMethods({ "providers.nativeMutate": { major: 1, minor: 4 } });

    await act(async () => {
      await result.rendered.result.current.mutateAsync(result.input);
    });

    expect(result.host.paramsOf("environment.host.read")).toEqual([]);
    expect(nativeRequests).toMatchObject([
      { mutation: { intentOperationId: null } },
    ]);
  });

  it("does not record an MCP intent for a skill on 1.5", async () => {
    const requests: EnvironmentTransportRequest[] = [];
    const nativeRequests: unknown[] = [];
    const cloud = stateCloud("consumed", requests);
    const result = await runPromote({
      cloud: () => cloud,
      entryKind: "skills",
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": (request) => {
          nativeRequests.push(request);
          return PROMOTED;
        },
      },
    });

    await act(async () => {
      await result.rendered.result.current.mutateAsync(result.input);
    });

    expect(result.host.paramsOf("environment.host.read")).toEqual([]);
    expect(requests).toEqual([]);
    expect(nativeRequests).toMatchObject([
      { mutation: { intentOperationId: null } },
    ]);
  });

  it.each([
    "needs_connection",
    "upload_refused",
    "needs_grant",
    "environment_not_served",
    "not_global_scope",
    "bound_to_this_computer",
    "invalid_entry",
  ] as const)(
    "keeps the coded refusal for %s distinct from the failure line",
    async (code) => {
      const result = await runPromote({
        cloud: null,
        entryKind: "skills",
        handlers: {
          "environment.host.read": () => binding(7),
          "providers.nativeMutate": () => ({
            result: { ok: false, code, detail: null },
          }),
        },
      });

      let outcome: Awaited<
        ReturnType<typeof result.rendered.result.current.mutateAsync>
      >;
      await act(async () => {
        outcome = await result.rendered.result.current.mutateAsync(
          result.input,
        );
      });

      expect(outcome).toMatchObject({
        kind: "refused",
        refreshLists: false,
      });
      if (outcome?.kind !== "refused") throw new Error("Expected a refusal.");
      if (code === "upload_refused") {
        expect(outcome.text).toBe("Couldn't add it to Acme.");
      } else {
        expect(outcome.text).not.toBe("Couldn't add it to Acme.");
      }
    },
  );

  it("keeps an uncoded refusal's host text", async () => {
    const result = await runPromote({
      cloud: null,
      entryKind: "skills",
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": () => ({
          result: {
            ok: false,
            code: "environment_mismatch",
            detail: "The host's refusal text.",
          },
        }),
      },
    });

    let outcome: Awaited<
      ReturnType<typeof result.rendered.result.current.mutateAsync>
    >;
    await act(async () => {
      outcome = await result.rendered.result.current.mutateAsync(result.input);
    });

    expect(outcome).toMatchObject({
      kind: "refused",
      text: "The host's refusal text.",
      refreshLists: false,
    });
  });

  it("toasts the environment-named failure line when the host request fails", async () => {
    const result = await runPromote({
      cloud: null,
      entryKind: "skills",
      handlers: {
        "environment.host.read": () => binding(7),
        "providers.nativeMutate": () => {
          throw new Error("host unavailable");
        },
      },
    });

    await act(async () => {
      await expect(
        result.rendered.result.current.mutateAsync(result.input),
      ).rejects.toThrow();
    });

    expect(toastHarness.messages).toEqual(["Couldn't add it to Acme."]);
  });
});

function bodyOperationId(
  request: EnvironmentTransportRequest | undefined,
): string {
  const body = request?.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("operationId" in body) ||
    typeof body.operationId !== "string"
  ) {
    throw new Error("Expected the recorded intent operation id.");
  }
  return body.operationId;
}
