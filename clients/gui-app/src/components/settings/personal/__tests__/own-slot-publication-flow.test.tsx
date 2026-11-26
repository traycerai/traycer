import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { useOwnSlotRowNote } from "@/components/settings/personal/use-own-slot-row-note";
import { fakeEnvironmentCloud } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import * as addressedEnvironment from "@/hooks/environment/use-addressed-environment";
import * as environmentCloud from "@/hooks/environment/use-environment-cloud";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { authnItemWriteResponseSchema } from "@traycer-clients/shared/environment/authn-environment-schemas";
import {
  environmentOwnSlotPublishResponseSchema,
  type EnvironmentOwnSlotChangeResponse,
  type EnvironmentOwnSlotPublishKind,
  type EnvironmentOwnSlotPublishResponse,
} from "@traycer/protocol/host/environment-schemas";
import { createDefaultFallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import { queryReadSignal } from "./query-read-signal";

const HOST = "owned-host";
const PERSONAL = "personal-env";
const TICKET = "fb150a2b-da20-4497-9582-c905076141b9";

type PublishValue = Extract<
  EnvironmentOwnSlotPublishResponse,
  { outcome: "ready" }
>["write"]["value"];

interface SlotCase {
  readonly kind: EnvironmentOwnSlotPublishKind;
  readonly key: string;
  readonly value: PublishValue;
}

const shells: SlotCase = {
  kind: "shell",
  key: "shell",
  value: { path: "/bin/sh", args: ["-l"] },
};
const cases: readonly SlotCase[] = [
  shells,
  { kind: "browser_agent_access", key: "browser", value: { enabled: false } },
  {
    kind: "agent_definition",
    key: "reviewer.md",
    value: { text: "Review the change." },
  },
  {
    kind: "fallback_policy",
    key: "fallback",
    value: { document: createDefaultFallbackPolicy() },
  },
  {
    kind: "pack_policy",
    key: "codex",
    value: { pinnedVersion: "1.2.3", autoDownload: false },
  },
  {
    kind: "managed_profile",
    key: "codex:bb150a2b-da20-4497-9582-c905076141b9",
    value: {
      name: "Personal",
      color: null,
      harnessId: "codex",
      accountIdentity: null,
      needsLink: false,
      enabled: true,
    },
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetNegotiatedManifests();
});

async function openRow(
  slot: SlotCase,
  advertisesPublish: boolean,
  answer: "saved" | "held" | "lost",
) {
  const calls: string[] = [];
  const os = slot.kind === "shell" ? "macos" : "any";
  const cloud = fakeEnvironmentCloud(() => {
    calls.push("PUT");
    if (answer === "lost") throw new Error("test transport lost its response");
    if (answer === "held") {
      return { status: 202, body: { held: { heldId: TICKET, revision: 2 } } };
    }
    return {
      status: 200,
      body: authnItemWriteResponseSchema.parse({
        item: {
          kind: slot.kind,
          key: slot.key,
          os,
          value: slot.value,
          updatedAt: 10,
          revision: 12,
          writtenBy: { source: "live", hostId: null, hostName: null },
        },
        revision: 12,
        replayed: false,
      }),
    };
  });
  vi.spyOn(environmentCloud, "useEnvironmentCloud").mockReturnValue(
    () => cloud.cloud,
  );
  vi.spyOn(addressedEnvironment, "usePersonalEnvironment").mockReturnValue({
    environmentId: PERSONAL,
    resolved: true,
    retry: () => {},
  });
  let owned = true;
  const host = buildEnvironmentClient({
    hostId: HOST,
    handlers: {
      "environment.ownSlots": () => ({
        entries: owned
          ? [
              {
                kind: slot.kind,
                key: slot.key,
                os: "any",
                state: "value",
                publishable: true,
              },
            ]
          : [],
      }),
      "environment.ownSlots.change": () => {
        calls.push("legacy");
        return { outcome: "saved" };
      },
      "environment.ownSlots.publish": (request) => {
        calls.push(request.phase);
        expect(request).toMatchObject({
          kind: slot.kind,
          key: slot.key,
          os: "any",
          environmentId: PERSONAL,
        });
        if (request.phase === "settle") {
          expect(request).toMatchObject({ changeToken: TICKET, revision: 12 });
          owned = false;
          return { outcome: "saved" };
        }
        return environmentOwnSlotPublishResponseSchema.parse({
          outcome: "ready",
          changeToken: TICKET,
          write: {
            environmentId: PERSONAL,
            key: slot.key,
            os,
            value: slot.value,
            revision: 11,
          },
        });
      },
    },
  });
  recordNegotiatedHostMethods(HOST, [
    "environment.ownSlots",
    "environment.ownSlots.change",
    ...(advertisesPublish ? ["environment.ownSlots.publish"] : []),
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { result } = renderHook(
    () =>
      useOwnSlotRowNote(
        { kind: slot.kind, key: slot.key, os: "any" },
        {
          client: host.client,
          hostId: HOST,
          hostName: "Test host",
          enabled: true,
        },
      ),
    {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    await queryReadSignal(
      queryClient,
      { method: "environment.ownSlots", hostId: HOST },
      false,
    );
  });
  return {
    calls,
    cloud,
    result,
    async press(): Promise<EnvironmentOwnSlotChangeResponse | undefined> {
      let outcome: EnvironmentOwnSlotChangeResponse | undefined;
      await act(async () => {
        outcome = await result.current.change(
          { kind: slot.kind, key: slot.key, os: "any" },
          "publish",
        );
      });
      return outcome;
    },
  };
}

it.each(cases)(
  "$kind publishes the kept item through the person's checked PUT",
  async (slot) => {
    const row = await openRow(slot, true, "saved");
    expect(row.result.current.entry?.publishable).toBe(true);
    expect(await row.press()).toEqual({ outcome: "saved" });
    expect(row.calls).toEqual(["begin", "PUT", "settle"]);
    expect(row.cloud.requests).toMatchObject([
      {
        method: "PUT",
        url: `https://authn.test/api/v3/environments/${PERSONAL}/items/${slot.kind}`,
        body: { key: slot.key, value: slot.value, revision: 11, upload: null },
      },
    ]);
  },
);

it.each(["held", "lost"] satisfies readonly ("held" | "lost")[])(
  "keeps Own and reports the existing failure when the Personal PUT is %s",
  async (answer) => {
    const failure = vi.spyOn(toast, "error");
    const row = await openRow(shells, true, answer);
    expect(await row.press()).toEqual({ outcome: "conflict" });
    expect(row.calls).toEqual(["begin", "PUT"]);
    expect(row.result.current.entry).toMatchObject({ state: "value" });
    expect(failure).toHaveBeenCalledWith("Couldn't save these settings.");
  },
);

it("shows the kept setting without offering Publish when the host lacks the method", async () => {
  const row = await openRow(shells, false, "saved");
  expect(row.result.current.entry).toMatchObject({
    kind: "shell",
    state: "value",
    publishable: false,
  });
  expect(row.calls).toEqual([]);
});
