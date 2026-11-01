import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { ChatPrestartRuntimeRequest } from "@traycer/protocol/host/agent/gui/prestart-runtime";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HostRequestAuthority,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  HostRequestCoordinator,
  isHostRequestControlFlowError,
  type HostRequestAuthorityDomain,
} from "@traycer-clients/shared/host-client/host-request-coordinator";
import type { RpcSchedulingPolicy } from "@traycer-clients/shared/host-client/rpc-scheduling-policy";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";

/**
 * `chat.prestartRuntime` through the REAL coordinator, registry and GUI
 * scheduling policy. The host builds the runtime from the request's settings,
 * so an older request that lands after a newer commit could replace a valid
 * warm runtime: the latest request of one chat must be the only one that runs
 * after the active one.
 */

type Prestart = ResponseOfMethod<HostRpcRegistry, "chat.prestartRuntime">;
const WARM: Prestart = { outcome: "reused", reason: "warm" };

interface Deferred {
  readonly promise: Promise<Prestart>;
  resolve(value: Prestart): void;
}

function deferred(): Deferred {
  let resolvePromise: (value: Prestart) => void = () => undefined;
  const promise = new Promise<Prestart>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function settings(model: string): ChatRunSettings {
  return {
    ultracode: false,
    harnessId: "claude",
    model,
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "epic",
    profileId: null,
  };
}

interface RequestScope {
  readonly epicId: string;
  readonly chatId: string;
}

const SCOPE: RequestScope = { epicId: "epic-1", chatId: "chat-1" };

function request(
  model: string,
  scope: RequestScope,
): ChatPrestartRuntimeRequest {
  return {
    epicId: scope.epicId,
    chatId: scope.chatId,
    settings: settings(model),
    accountContext: { type: "PERSONAL" },
  };
}

function authority(hostId: string, userId: string): HostRequestAuthority {
  return {
    endpoint: { hostId, websocketUrl: `ws://${hostId}.invalid/rpc` },
    bearer: { getBearerToken: () => "bearer", identity: { userId } },
    abortSignal: new AbortController().signal,
  };
}

const DOMAIN: HostRequestAuthorityDomain = {
  bindingToken: { label: "binding" },
  requestContext: { label: "context" },
};

interface SubmitContext {
  readonly hostId: string;
  readonly userId: string;
  readonly authorityDomain: HostRequestAuthorityDomain;
}

const CONTEXT: SubmitContext = {
  hostId: "host-1",
  userId: "user-1",
  authorityDomain: DOMAIN,
};

type Outcome =
  | { readonly settled: "resolved"; readonly value: Prestart }
  | { readonly settled: "rejected"; readonly error: unknown };

interface Run {
  readonly label: string;
  readonly gate: Deferred;
}

function harness() {
  const NEWER_DOMAIN: HostRequestAuthorityDomain = {
    bindingToken: { label: "newer-binding" },
    requestContext: { label: "newer-context" },
  };
  const coordinator = new HostRequestCoordinator({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
  });
  const started: Run[] = [];
  function submit(
    label: string,
    params: ChatPrestartRuntimeRequest,
    context: SubmitContext,
  ): Promise<Outcome> {
    const requestAuthority = authority(context.hostId, context.userId);
    return coordinator
      .request({
        hostId: context.hostId,
        userId: context.userId,
        method: "chat.prestartRuntime",
        params,
        authority: requestAuthority,
        authorityDomain: context.authorityDomain,
        signal: undefined,
        execute: () => {
          const gate = deferred();
          started.push({ label, gate });
          return gate.promise;
        },
      })
      .then(
        (value): Outcome => ({ settled: "resolved", value }),
        (error: unknown): Outcome => ({ settled: "rejected", error }),
      );
  }
  return { submit, started, NEWER_DOMAIN };
}

describe("chat.prestartRuntime scheduling", () => {
  it("runs only the active request, supersedes the middle one when a newer one queues, and then runs only the newest", async () => {
    const { submit, started } = harness();

    const a = submit("A", request("model-a", SCOPE), CONTEXT);
    const b = submit("B", request("model-b", SCOPE), CONTEXT);
    const c = submit("C", request("model-c", SCOPE), CONTEXT);
    await flush();

    expect(started.map((run) => run.label)).toEqual(["A"]);
    const bOutcome = await b;
    expect(bOutcome.settled).toBe("rejected");
    if (bOutcome.settled === "rejected") {
      expect(isHostRequestControlFlowError(bOutcome.error)).toBe(true);
      expect(bOutcome.error).toMatchObject({ reason: "request-superseded" });
    }

    started[0].gate.resolve(WARM);
    await flush();
    expect(started.map((run) => run.label)).toEqual(["A", "C"]);
    started[1].gate.resolve(WARM);

    expect(await a).toMatchObject({ settled: "resolved" });
    expect(await c).toMatchObject({ settled: "resolved", value: WARM });
    expect(started.map((run) => run.label)).not.toContain("B");
  });

  it("a newer authority replacing a different-payload queued tail still supersedes the old authority's tail, which never runs", async () => {
    const { submit, started, NEWER_DOMAIN } = harness();

    const active = submit("active", request("model-a", SCOPE), CONTEXT);
    const oldTail = submit("old-tail", request("model-b", SCOPE), CONTEXT);
    const newer = submit("newer", request("model-c", SCOPE), {
      ...CONTEXT,
      authorityDomain: NEWER_DOMAIN,
    });
    await flush();

    const oldOutcome = await oldTail;
    expect(oldOutcome).toMatchObject({ settled: "rejected" });
    if (oldOutcome.settled === "rejected") {
      expect(oldOutcome.error).toMatchObject({
        reason: "authority-superseded",
      });
    }
    expect(started.map((run) => run.label)).toEqual(["active"]);

    started[0].gate.resolve(WARM);
    await flush();
    expect(started.map((run) => run.label)).toEqual(["active", "newer"]);
    started[1].gate.resolve(WARM);
    expect(await active).toMatchObject({ settled: "resolved" });
    expect(await newer).toMatchObject({ settled: "resolved", value: WARM });
    expect(started.map((run) => run.label)).not.toContain("old-tail");
  });

  it("does not let different chats, epics, hosts or users supersede or wait for each other", async () => {
    const { submit, started } = harness();

    const outcomes = [
      submit("same", request("model-a", SCOPE), CONTEXT),
      submit(
        "other-chat",
        request("model-b", { epicId: "epic-1", chatId: "chat-2" }),
        CONTEXT,
      ),
      submit(
        "other-epic",
        request("model-c", { epicId: "epic-2", chatId: "chat-1" }),
        CONTEXT,
      ),
      submit("other-host", request("model-d", SCOPE), {
        ...CONTEXT,
        hostId: "host-2",
      }),
      submit("other-user", request("model-e", SCOPE), {
        ...CONTEXT,
        userId: "user-2",
      }),
    ];
    await flush();

    expect(started.map((run) => run.label)).toEqual([
      "same",
      "other-chat",
      "other-epic",
      "other-host",
      "other-user",
    ]);
    for (const run of started) run.gate.resolve(WARM);
    for (const outcome of outcomes) {
      expect(await outcome).toMatchObject({ settled: "resolved" });
    }
  });

  it("keeps one active request and one shared tail for identical repeated payloads", async () => {
    const { submit, started } = harness();

    const first = submit("first", request("model-a", SCOPE), CONTEXT);
    const second = submit("second", request("model-a", SCOPE), CONTEXT);
    const third = submit("third", request("model-a", SCOPE), CONTEXT);
    await flush();
    expect(started.map((run) => run.label)).toEqual(["first"]);

    started[0].gate.resolve(WARM);
    await flush();
    expect(started.map((run) => run.label)).toEqual(["first", "second"]);
    started[1].gate.resolve(WARM);

    expect(await first).toMatchObject({ settled: "resolved" });
    expect(await second).toMatchObject({ settled: "resolved", value: WARM });
    expect(await third).toMatchObject({ settled: "resolved", value: WARM });
  });
});

describe("other latest methods keep their full-parameter keys", () => {
  const readContract = defineRpcContract({
    method: "other.read",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({ path: z.string() }),
    responseSchema: z.object({ value: z.string() }),
  });
  const otherRegistry = defineVersionedRpcRegistry({
    "other.read": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: readContract, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
  });
  const otherPolicy: RpcSchedulingPolicy<typeof otherRegistry> = {
    modeFor: () => "latest",
    joinResponseTimeoutMs: () => null,
  };

  it("lets different payloads of a method with no scope run side by side", async () => {
    const coordinator = new HostRequestCoordinator({
      registry: otherRegistry,
      schedulingPolicy: otherPolicy,
    });
    const started: string[] = [];
    const run = (path: string) =>
      coordinator.request({
        hostId: "host-1",
        userId: "user-1",
        method: "other.read",
        params: { path },
        authority: authority("host-1", "user-1"),
        authorityDomain: DOMAIN,
        signal: undefined,
        execute: () => {
          started.push(path);
          return new Promise<{ value: string }>(() => undefined);
        },
      });

    void run("/a");
    void run("/b");
    await flush();

    expect(started).toEqual(["/a", "/b"]);
  });
});
