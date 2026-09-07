import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  ALL_HOST_NOTIFICATION_KINDS,
  visibleHostNotificationKinds,
  type HostNotificationKind,
  type HostNotificationsSurface,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * Cross-surface conformance: for EVERY registered serving path and EVERY installed version of it, every notification kind is either representable by that version's wire schema or excluded by the central.
 */

// ---- representative entries, one per kind ------------------------------- //

const ENTRY_BASE = {
  id: "conformance-entry-1",
  updatedAt: 1_700_000_000_000,
  readAt: null,
  sourceRef: "conformance-source",
  epicId: "epic-1",
  chatId: "chat-1",
};

/** Minimal VALID entry per kind on the widest union. */
const REPRESENTATIVE_ENTRIES: Readonly<
  Record<HostNotificationKind, Record<string, unknown>>
> = {
  "agent.stopped": {
    ...ENTRY_BASE,
    kind: "agent.stopped",
    severity: "done",
    outcome: "completed",
    payload: { outcome: "completed" },
  },
  "agent.stalled": {
    ...ENTRY_BASE,
    kind: "agent.stalled",
    severity: "failure",
    outcome: "errored",
    payload: {},
  },
  "workspace.operation.failed": {
    ...ENTRY_BASE,
    kind: "workspace.operation.failed",
    severity: "failure",
    outcome: "errored",
    payload: {},
  },
  "approval.requested": {
    ...ENTRY_BASE,
    kind: "approval.requested",
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    payload: {},
  },
  "interview.requested": {
    ...ENTRY_BASE,
    kind: "interview.requested",
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    payload: {},
  },
  "browser.human.needed": {
    ...ENTRY_BASE,
    kind: "browser.human.needed",
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    payload: { sessionId: "session-1", tabId: "tab-1", reason: "Sign in" },
  },
  "host.operation.finished": {
    ...ENTRY_BASE,
    kind: "host.operation.finished",
    epicId: null,
    chatId: null,
    severity: "done",
    outcome: "completed",
    payload: { title: "Deleted a worktree", message: "Removed cleanly." },
  },
};

// ---- per-method wire embedding ------------------------------------------ //

/**
 * How one representative entry rides each method's wire, and which schema of the registered contract validates that shape.
 */
type ServingPath = {
  readonly registry: "rpc" | "stream";
  readonly embed: (entry: Record<string, unknown>) => unknown;
};

const SERVING_PATHS: Readonly<Record<string, ServingPath>> = {
  "host.notifications.list": {
    registry: "rpc",
    embed: (entry) => ({ entries: [entry], nextCursor: null }),
  },
  "host.notifications.subscribe": {
    registry: "stream",
    embed: (entry) => ({
      kind: "upserted",
      hasBinaryPayload: false,
      entry,
    }),
  },
  "host.notifications.feed.subscribe": {
    registry: "stream",
    embed: (entry) => ({
      kind: "upserted",
      hasBinaryPayload: false,
      entry,
      removedIds: [],
      summary: { unreadCount: 0, attentionCount: 0 },
    }),
  },
  "host.notifications.cloudFeed.subscribe": {
    registry: "stream",
    embed: (entry) => ({
      kind: "snapshot",
      hasBinaryPayload: false,
      connectionState: "connected",
      version: 1,
      rows: [
        {
          entryId: "0195a1f0-0001-7000-8000-00000000000a",
          originHostId: "host-a",
          coalesceKey: "conformance:key",
          entry,
          presentation: { epicTitle: null, chatTitle: null },
        },
      ],
      summary: { totalCount: 1, unreadCount: 0, attentionCount: 0 },
    }),
  },
};

// ---- registry introspection --------------------------------------------- //

type InstalledVersion = {
  readonly major: number;
  readonly minor: number;
  readonly wireSchema: z.ZodType;
};

function installedVersions(
  method: string,
  path: ServingPath,
): InstalledVersion[] {
  const line = (
    path.registry === "rpc" ? hostRpcRegistry : hostStreamRpcRegistry
  )[method as never] as Record<
    string,
    { versions: Record<string, { contract: unknown }> }
  >;
  const versions: InstalledVersion[] = [];
  for (const [majorKey, majorLine] of Object.entries(line)) {
    const major = Number(majorKey);
    if (!Number.isInteger(major)) continue; // skips `degrade`
    for (const [minorKey, entry] of Object.entries(majorLine.versions)) {
      const contract = entry.contract as {
        responseSchema?: z.ZodType;
        serverFrameSchema?: z.ZodType;
      };
      const wireSchema =
        path.registry === "rpc"
          ? contract.responseSchema
          : contract.serverFrameSchema;
      if (wireSchema === undefined) {
        throw new Error(`no wire schema on ${method}@${major}.${minorKey}`);
      }
      versions.push({ major, minor: Number(minorKey), wireSchema });
    }
  }
  return versions;
}

/**
 * A contract carries notification entries iff its wire schemas mention an entry-kind literal.
 * Dump-based on purpose: it inspects what is actually on the wire, so a new method cannot opt out by simply not being hand-listed.
 */
function carriesNotificationEntries(contract: unknown): boolean {
  const schemas = Object.entries(contract as Record<string, unknown>).filter(
    ([, value]) => value instanceof z.ZodType,
  );
  return schemas.some(([, schema]) => {
    const dump = JSON.stringify(
      z.toJSONSchema(schema as z.ZodType, { unrepresentable: "any" }),
    );
    return ALL_HOST_NOTIFICATION_KINDS.some((kind) =>
      dump.includes(`"${kind}"`),
    );
  });
}

function detectedEntryCarryingMethods(): string[] {
  const methods: string[] = [];
  for (const [registryName, registry] of [
    ["rpc", hostRpcRegistry],
    ["stream", hostStreamRpcRegistry],
  ] as const) {
    for (const [method, line] of Object.entries(registry)) {
      if (!method.startsWith("host.notifications.")) continue;
      const carries = Object.entries(
        line as Record<
          string,
          { versions?: Record<string, { contract: unknown }> }
        >,
      ).some(
        ([majorKey, majorLine]) =>
          Number.isInteger(Number(majorKey)) &&
          Object.values(majorLine.versions ?? {}).some((entry) =>
            carriesNotificationEntries(entry.contract),
          ),
      );
      if (carries) methods.push(`${registryName}:${method}`);
    }
  }
  return methods.sort();
}

// ---- the conformance matrix --------------------------------------------- //

describe("notification kind ↔ surface conformance", () => {
  it("has a representative entry for every kind the enum knows", () => {
    expect(Object.keys(REPRESENTATIVE_ENTRIES).sort()).toEqual(
      [...ALL_HOST_NOTIFICATION_KINDS].sort(),
    );
  });

  it("covers exactly the entry-carrying methods the registries actually serve", () => {
    // Detected from the wire schemas, not hand-listed.
    const expected = Object.entries(SERVING_PATHS)
      .map(([method, path]) => `${path.registry}:${method}`)
      .sort();
    expect(detectedEntryCarryingMethods()).toEqual(expected);
  });

  it("every kind is representable exactly where the central projection says it is visible", () => {
    for (const [method, path] of Object.entries(SERVING_PATHS)) {
      const surface = { method } as HostNotificationsSurface;
      for (const { major, minor, wireSchema } of installedVersions(
        method,
        path,
      )) {
        const visible = visibleHostNotificationKinds(surface, {
          major,
          minor,
        });
        for (const kind of ALL_HOST_NOTIFICATION_KINDS) {
          const candidate = path.embed(REPRESENTATIVE_ENTRIES[kind]);
          const representable = wireSchema.safeParse(candidate).success;
          // The one line the cloud-feed bug would have tripped: `cloudFeed.subscribe@1.0` could not represent `host.operation.finished`, but nothing hid the kind from that surface, so it was counted, then silently dropped.
          expect
            .soft(
              representable,
              `${method}@${major}.${minor} kind=${kind}: representable=${representable} but centrally visible=${visible.includes(kind)}`,
            )
            .toBe(visible.includes(kind));
        }
      }
    }
  });
});
