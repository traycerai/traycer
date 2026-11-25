import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authnItemWriteResponseSchema,
  authnOperationReviewResponseSchema,
} from "@traycer-clients/shared/environment/authn-environment-schemas";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  environmentReviewHeldKeepRequestSchema,
  environmentReviewHeldKeepResponseSchema,
  environmentReviewRecordResponseSchema,
} from "@traycer/protocol/host/environment-schemas";
import {
  environmentHostListResponseSchemaV12,
  environmentListResponseSchemaV11,
} from "@traycer/protocol/host/environment/contracts";
import { createDefaultFallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import type { SettingValue } from "@traycer/protocol/host/environment/settings-proposals";
import { fakeEnvironmentCloud } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import {
  environmentCloudQueryKey,
  ENVIRONMENT_CLOUD_QUERY_SCOPE,
} from "@/hooks/environment/use-environment-cloud";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const HOST_ID = "7b5c3a2f-b924-4c6f-a910-34d7a9488bf7";
const OTHER_HOST_ID = "297e9472-6e0b-476a-9ce5-0145d512b952";
const ENVIRONMENT_ID = "env_01JA000000000000000000000A";
const VIEWER_ID = "user-me";
const HOST_NAME = "Work desktop";
const HELD_ID = "6b08e785-0464-465e-bd82-ecfe3f98cd19";
const HELD_REVISION = 8;
const LIVE_REVISION = 11;
const HELD_ROW = `retrospective-held-${HELD_ID}`;
const KEEP_LABEL = "Keep on Work desktop only";

interface ReviewItem {
  readonly kind: string;
  readonly key: string;
  readonly os: "any" | null;
  readonly proposed: SettingValue;
  readonly current: SettingValue;
}

const VARIABLE_EDIT: ReviewItem = {
  kind: "variable",
  key: "PROJECT_MODE",
  os: "any",
  proposed: { value: "outside" },
  current: { value: "shared" },
};
const DEFAULT_POLICY = createDefaultFallbackPolicy();
const PROFILE = {
  harnessId: "claude",
  name: "Personal profile",
  color: "#3b82f6",
  enabled: true,
  accountIdentity: null,
  needsLink: false,
};
const GUIDE_REMOVAL: ReviewItem = {
  kind: "agent_selection_guide",
  key: "guide",
  os: null,
  proposed: null,
  current: { text: "# Personal guide\n" },
};
const AGENT_DEFINITION_EDIT: ReviewItem = {
  kind: "agent_definition",
  key: "reviewer.md",
  os: null,
  proposed: { text: "---\nname: reviewer\n---\nReview local changes.\n" },
  current: { text: "---\nname: reviewer\n---\nReview Personal changes.\n" },
};
const NATIVE_EDITS: readonly ReviewItem[] = [
  AGENT_DEFINITION_EDIT,
  {
    kind: "fallback_policy",
    key: "fallback",
    os: null,
    proposed: { document: { ...DEFAULT_POLICY, graceWindowSeconds: 30 } },
    current: { document: { ...DEFAULT_POLICY, graceWindowSeconds: 90 } },
  },
  {
    kind: "managed_profile",
    key: "claude:2845ced2-ad1f-48af-9328-fe7060b58afb",
    os: null,
    proposed: { ...PROFILE, name: "Work desktop profile" },
    current: PROFILE,
  },
];

const EXECUTABLE_HOLDS: readonly {
  readonly item: ReviewItem;
  readonly op: "put" | "delete";
  readonly supportsKeep: boolean;
}[] = [
  {
    item: {
      kind: "setup_script",
      key: "setup",
      os: "any",
      proposed: { text: "printf 'local setup\n'" },
      current: { text: "printf 'personal setup\n'" },
    },
    op: "put",
    supportsKeep: true,
  },
  {
    item: {
      kind: "shell",
      key: "shell",
      os: "any",
      proposed: { path: "/bin/zsh", args: ["-l"] },
      current: { path: "/bin/sh", args: [] },
    },
    op: "put",
    supportsKeep: false,
  },
  {
    item: {
      kind: "mcp_server",
      key: "review-server",
      os: null,
      proposed: {
        definition: { transport: "stdio", command: "review-server", args: [] },
        toolToggles: {},
      },
      current: {
        mcpServerId: "20860ab5-ab49-468f-be1c-50511bac8758",
        toolToggles: {},
      },
    },
    op: "put",
    supportsKeep: false,
  },
  {
    item: AGENT_DEFINITION_EDIT,
    op: "put",
    supportsKeep: false,
  },
  {
    item: {
      kind: "skill",
      key: "review-skill",
      os: null,
      proposed: null,
      current: {
        source: "https://example.invalid/review-skills",
        ref: null,
        subpath: "review-skill",
        installedCommit: "cabc123",
        contentRef: null,
      },
    },
    op: "delete",
    supportsKeep: true,
  },
];

const fixture = vi.hoisted((): { binding: { auth: unknown } | null } => ({
  binding: null,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => fixture.binding,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

const observers = new Set<MutationObserver>();

afterEach(() => {
  for (const observer of observers) observer.disconnect();
  observers.clear();
  cleanup();
  resetNegotiatedManifests();
  fixture.binding = null;
  useAuthStore.getState().setSignedOut();
});

function observeHeldRow(present: boolean): Promise<void> {
  const ready = Promise.withResolvers<void>();
  const check = (): void => {
    if ((screen.queryByTestId(HELD_ROW) !== null) !== present) return;
    observer.disconnect();
    observers.delete(observer);
    ready.resolve();
  };
  const observer = new MutationObserver(check);
  observers.add(observer);
  observer.observe(document.body, { childList: true, subtree: true });
  check();
  return ready.promise;
}

function mountReview(options: {
  readonly supportsKeep: boolean;
  readonly proposingHostId: string;
  readonly generation: number | null;
  readonly item: ReviewItem;
  readonly op: "put" | "delete";
}) {
  let pendingHold = true;
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.review.record": () =>
        environmentReviewRecordResponseSchema.parse({ outcome: "recorded" }),
      "environment.review.heldKeep": (request) => {
        expect(environmentReviewHeldKeepRequestSchema.parse(request)).toEqual({
          heldId: HELD_ID,
          revision: HELD_REVISION,
        });
        pendingHold = false;
        return environmentReviewHeldKeepResponseSchema.parse({
          outcome: "kept",
        });
      },
    },
  });
  const { kind, key, os, proposed, current } = options.item;
  const address = { kind, key, os };
  const reviewPath = `/api/v3/environments/${ENVIRONMENT_ID}/review`;
  const transport = fakeEnvironmentCloud((request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === reviewPath) {
      expect(url.searchParams.get("include")).toBe("operation");
      const body = {
        review: {
          hosts: [],
          applied: [],
          staysOnOneHost: [],
          unrecognisedUploaded: false,
          needsYou: pendingHold
            ? [
                {
                  ...address,
                  type: "held",
                  heldId: HELD_ID,
                  revision: HELD_REVISION,
                  hostId: options.proposingHostId,
                  hostName: HOST_NAME,
                  sharingGeneration: options.generation,
                  heldAt: 1,
                  op: options.op,
                  value: options.op === "put" ? proposed : null,
                  live: { revision: LIVE_REVISION, value: current },
                },
              ]
            : [],
        },
      };
      authnOperationReviewResponseSchema.parse(body);
      return { status: 200, body };
    }
    if (
      request.method === "POST" &&
      path === `${reviewPath}/held/${HELD_ID}/discard`
    ) {
      pendingHold = false;
      return { status: 200, body: { outcome: "discarded" } };
    }
    if (
      request.method === "POST" &&
      path === `${reviewPath}/held/${HELD_ID}/apply`
    ) {
      pendingHold = false;
      const body = authnItemWriteResponseSchema.parse({
        item: {
          ...address,
          value: proposed,
          revision: LIVE_REVISION + 1,
          updatedAt: 2,
          writtenBy: { source: "live", hostId: null, hostName: null },
        },
        revision: LIVE_REVISION + 1,
        replayed: false,
      });
      return { status: 200, body };
    }
    throw new Error(`Unexpected Review request: ${request.method} ${path}`);
  });
  fixture.binding = { auth: { environmentCloud: () => transport.cloud } };
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER_ID, username: "user" },
    shareableTeams: [],
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.review.record": { major: 1, minor: 0 },
    ...(options.supportsKeep
      ? { "environment.review.heldKeep": { major: 1, minor: 0 } }
      : {}),
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: { gcTime: 0, retry: false },
    },
  });
  const directoryQuery = queryOptions({
    queryKey: [
      ...hostQueryKeys.method<HostRpcRegistry, "environment.list">(
        ENVIRONMENT_CLOUD_QUERY_SCOPE,
        "environment.list",
        {},
      ),
      VIEWER_ID,
      [],
    ],
  });
  queryClient.setQueryData(
    directoryQuery.queryKey,
    environmentListResponseSchemaV11.parse({
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          ownerKind: "user",
          ownerId: VIEWER_ID,
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner",
          kind: "personal",
          hostCount: 1,
          providerHandle: null,
        },
      ],
    }),
  );
  queryClient.setQueryData(
    environmentCloudQueryKey(
      "environment.host.list",
      { environmentId: ENVIRONMENT_ID },
      VIEWER_ID,
      [],
    ),
    environmentHostListResponseSchemaV12.parse({ hosts: [] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RetrospectiveSession
        client={client}
        reviewHostId={HOST_ID}
        stopClient={client}
        stopHostId={HOST_ID}
        hostName={HOST_NAME}
        open
        held={null}
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { messenger, http: transport.requests, reviewPath };
}

describe("Review choices for a held outside edit", () => {
  it.each([
    { item: VARIABLE_EDIT, op: "put", label: KEEP_LABEL, route: "host" },
    { item: VARIABLE_EDIT, op: "delete", label: KEEP_LABEL, route: "host" },
    { item: VARIABLE_EDIT, op: "put", label: "Use everywhere", route: "apply" },
    { item: VARIABLE_EDIT, op: "put", label: "Discard", route: "discard" },
    { item: GUIDE_REMOVAL, op: "delete", label: KEEP_LABEL, route: "host" },
    ...NATIVE_EDITS.map(
      (item) =>
        ({ item, op: "put", label: KEEP_LABEL, route: "host" }) as const,
    ),
  ] as const)(
    "offers all three choices for $item.kind and sends $op via $label",
    async ({ item, op, label, route }) => {
      const { messenger, http, reviewPath } = mountReview({
        supportsKeep: true,
        proposingHostId: HOST_ID,
        generation: 3,
        item,
        op,
      });
      await observeHeldRow(true);
      const row = within(screen.getByTestId(HELD_ROW));
      expect(
        row.getAllByRole("button").map((button) => button.textContent),
      ).toEqual(["Discard", "Keep on Work desktop only", "Use everywhere"]);

      const removed = observeHeldRow(false);
      fireEvent.click(row.getByRole("button", { name: label }));
      await removed;
      const keepCalls = messenger.calls.filter(
        (call) => call.method === "environment.review.heldKeep",
      );
      const posts = http.filter((request) => request.method === "POST");
      if (route === "host") {
        expect(keepCalls).toHaveLength(1);
        expect(posts).toEqual([]);
      } else {
        expect(keepCalls).toEqual([]);
        expect(
          posts.map((request) => ({
            path: new URL(request.url).pathname,
            body: request.body,
          })),
        ).toEqual([
          {
            path: `${reviewPath}/held/${HELD_ID}/${route}`,
            body:
              route === "apply"
                ? {
                    revision: HELD_REVISION,
                    expectedLiveRevision: LIVE_REVISION,
                  }
                : { revision: HELD_REVISION },
          },
        ]);
      }
    },
  );

  it.each(EXECUTABLE_HOLDS)(
    "keeps Approve and Discard for a current $item.kind hold without Keep",
    async ({ item, op, supportsKeep }) => {
      mountReview({
        item,
        op,
        supportsKeep,
        proposingHostId: HOST_ID,
        generation: 3,
      });
      await observeHeldRow(true);
      const row = within(screen.getByTestId(HELD_ROW));
      expect(
        row.getAllByRole("button").map((button) => button.textContent),
      ).toEqual(["Approve", "Discard"]);
    },
  );

  it.each([
    {
      title: "the computer did not advertise Keep",
      item: VARIABLE_EDIT,
      supportsKeep: false,
      proposingHostId: HOST_ID,
      generation: 3,
      labels: ["Discard", "Use everywhere"],
    },
    {
      title: "another computer proposed the edit",
      item: VARIABLE_EDIT,
      supportsKeep: true,
      proposingHostId: OTHER_HOST_ID,
      generation: 3,
      labels: ["Discard", "Use everywhere"],
    },
    {
      title: "the value has no native Keep resolver",
      item: {
        kind: "agent_memory",
        key: "memory",
        os: null,
        proposed: { enabled: false },
        current: { enabled: true },
      },
      supportsKeep: true,
      proposingHostId: HOST_ID,
      generation: 3,
      labels: ["Discard", "Use everywhere"],
    },
    {
      title: "the hold comes from an earlier Move",
      item: VARIABLE_EDIT,
      supportsKeep: true,
      proposingHostId: HOST_ID,
      generation: null,
      labels: ["Approve", "Discard"],
    },
  ])(
    "shows the two applicable choices when $title",
    async ({ labels, ...options }) => {
      mountReview({ ...options, op: "put" });
      await observeHeldRow(true);
      const row = within(screen.getByTestId(HELD_ROW));
      expect(
        row.getAllByRole("button").map((button) => button.textContent),
      ).toEqual(labels);
    },
  );
});
