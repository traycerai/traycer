import { describe, expect, it } from "vitest";
import {
  createCommandQueue,
  type CommandRecord,
  type CommandResolution,
  type RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  classifyEpicWriteCommandFailure,
  type EpicWriteCommandIntent,
} from "@/stores/epics/open-epic/runtime/epic-write-command";
import {
  describeEpicWriteCommandIntent,
  presentEpicWriteCommand,
} from "../epic-write-command-copy";

function makeEnvironment(now: () => number): RuntimeEnvironment {
  return {
    clock: { now },
    scheduler: {
      schedule: () => ({ cancel: () => undefined }),
      scheduleMicrotask: (callback) => callback(),
    },
    logger: {
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function makeQueue(
  send: (
    command: CommandRecord<EpicWriteCommandIntent>,
  ) => Promise<CommandResolution>,
) {
  let nextId = 0;
  return createCommandQueue<EpicWriteCommandIntent>({
    environment: makeEnvironment(() => 1000),
    idFactory: { next: () => `command-${++nextId}` },
    send,
    classifyFailure: classifyEpicWriteCommandFailure,
    accept: () => true,
    onEnqueued: () => true,
    onUnknownOutcome: () => undefined,
    onResolved: () => undefined,
  });
}

async function settleQueueMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function renameIntent(
  artifactId: string,
  title: string,
): EpicWriteCommandIntent {
  return { kind: "rename-artifact", artifactId, title };
}

function neverSettles(): Promise<CommandResolution> {
  return new Promise(() => undefined);
}

/** A generic authority refusal, distinct from the read-only verdict. */
function ordinaryRejection(message: string): HostRpcError {
  return HostRpcError.fromWireEnvelope(
    { code: "WORKTREE_BUSY", message },
    "req-1",
    "epic.writeCommand",
  );
}

function readOnlyRejection(message: string): HostRpcError {
  return HostRpcError.fromWireEnvelope(
    { code: "E_EPIC_READ_ONLY", message },
    "req-1",
    "epic.writeCommand",
  );
}

function ambiguousTransportFailure(message: string): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message,
    requestId: "req-1",
    method: "epic.writeCommand",
    fatalDetails: null,
  });
}

function findRecord(
  records: readonly CommandRecord<EpicWriteCommandIntent>[],
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  const record = records.find((candidate) => candidate.commandId === commandId);
  if (record === undefined) throw new Error(`expected record ${commandId}`);
  return record;
}

describe("presentEpicWriteCommand", () => {
  it("presents a queued (not yet sent) command with no retry or discard, and never claims it is saved", async () => {
    // The queue serializes sends: the first command occupies the in-flight
    // slot forever, which is what keeps the second one genuinely "queued"
    // rather than "sending".
    const queue = makeQueue(neverSettles);
    const first = queue.enqueue({
      intent: renameIntent("a1", "First"),
      expectedEntityVersion: null,
    });
    const second = queue.enqueue({
      intent: renameIntent("a2", "Second"),
      expectedEntityVersion: null,
    });
    if (first === null || second === null) throw new Error("expected commands");
    await settleQueueMicrotasks();

    const record = findRecord(queue.list(), second.commandId);
    expect(record.state).toBe("pending");
    expect(record.delivery).toBe("queued");

    const presentation = presentEpicWriteCommand(record);
    expect(presentation).toMatchObject({
      stage: "queued",
      canRetry: false,
      canDiscard: false,
    });
    // Nothing durable holds a queued command yet - the copy must not imply
    // otherwise.
    expect(presentation.detail).not.toMatch(/saved/i);
  });

  it("presents a sending command as in flight, with no retry or discard", () => {
    const queue = makeQueue(neverSettles);
    const command = queue.enqueue({
      intent: renameIntent("a1", "First"),
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");

    // `pump()` flips delivery to "sending" synchronously inside `enqueue`,
    // before the unresolved `send` promise ever settles.
    const record = findRecord(queue.list(), command.commandId);
    expect(record.delivery).toBe("sending");

    const presentation = presentEpicWriteCommand(record);
    expect(presentation).toMatchObject({
      stage: "sending",
      canRetry: false,
      canDiscard: false,
    });
  });

  it("presents unknown-outcome as retryable, and names that it is not itself in flight", async () => {
    const queue = makeQueue(() =>
      Promise.reject(ambiguousTransportFailure("the result never came back")),
    );
    const command = queue.enqueue({
      intent: renameIntent("a1", "First"),
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    const record = findRecord(queue.list(), command.commandId);
    // Still `pending` at the queue level - the point of this stage is that
    // the queue does NOT auto-retry it, so it must not read as "sending".
    expect(record.state).toBe("pending");
    expect(record.delivery).toBe("unknown-outcome");

    const presentation = presentEpicWriteCommand(record);
    expect(presentation).toMatchObject({
      stage: "unknown-outcome",
      canRetry: true,
      canDiscard: false,
    });
  });

  it("presents committed as host-committed, naming the committing host, without an unqualified 'saved' claim", async () => {
    const queue = makeQueue(() =>
      Promise.resolve({
        kind: "committed",
        hostId: "host-42",
        entityVersion: 7,
      }),
    );
    const command = queue.enqueue({
      intent: renameIntent("a1", "First"),
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    const record = findRecord(queue.list(), command.commandId);
    expect(record.state).toBe("committed");

    const presentation = presentEpicWriteCommand(record);
    expect(presentation.stage).toBe("committed");
    expect(presentation.canDiscard).toBe(true);
    expect(presentation.canRetry).toBe(false);
    expect(presentation.detail).toContain("host-42");
    // "saved" is exactly the epic-global durability claim this record must
    // not make.
    expect(presentation.detail).not.toMatch(/\bsaved\b/i);
  });

  it("presents an ordinary rejection with the host's own reason string, verbatim", async () => {
    const queue = makeQueue(() =>
      Promise.reject(ordinaryRejection("Another agent is using this worktree")),
    );
    const command = queue.enqueue({
      intent: renameIntent("a1", "First"),
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    const record = findRecord(queue.list(), command.commandId);
    expect(record.state).toBe("rejected");

    const presentation = presentEpicWriteCommand(record);
    expect(presentation.stage).toBe("rejected");
    expect(presentation.canDiscard).toBe(true);
    // Never synthesised client-side - the exact reason the authority sent.
    expect(presentation.detail).toBe("Another agent is using this worktree");
  });

  it("pulls E_EPIC_READ_ONLY out of rejected into its own non-retryable stage", async () => {
    const queue = makeQueue(() =>
      Promise.reject(
        readOnlyRejection("This epic cannot be written to right now"),
      ),
    );
    const command = queue.enqueue({
      intent: renameIntent("a1", "First"),
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();

    const record = findRecord(queue.list(), command.commandId);
    // The wire code is still a rejection at the queue's own state level -
    // "read-only" is a presentation-layer distinction, not a new
    // `CommandState`.
    expect(record.state).toBe("rejected");

    const presentation = presentEpicWriteCommand(record);
    expect(presentation.stage).toBe("read-only");
    expect(presentation.canRetry).toBe(false);
    expect(presentation.detail).toBe(
      "This epic cannot be written to right now",
    );
  });

  it("presents a committed-then-superseded record as superseded, not as the committed state it passed through", async () => {
    const queue = makeQueue(() =>
      Promise.resolve({
        kind: "committed",
        hostId: "host-1",
        entityVersion: 3,
      }),
    );
    const command = queue.enqueue({
      intent: renameIntent("a1", "First"),
      expectedEntityVersion: null,
    });
    if (command === null) throw new Error("expected command");
    await settleQueueMicrotasks();
    expect(findRecord(queue.list(), command.commandId).state).toBe("committed");

    queue.resolve(command.commandId, {
      kind: "superseded",
      observedAtMs: 5000,
      via: "record-lane",
    });

    const record = findRecord(queue.list(), command.commandId);
    expect(record.state).toBe("superseded");

    const presentation = presentEpicWriteCommand(record);
    expect(presentation.stage).toBe("superseded");
    expect(presentation.stage).not.toBe("committed");
    expect(presentation.canDiscard).toBe(true);
    expect(presentation.canRetry).toBe(false);
  });
});

describe("describeEpicWriteCommandIntent", () => {
  it("describes a rename-artifact intent by its target title", () => {
    const intent: EpicWriteCommandIntent = {
      kind: "rename-artifact",
      artifactId: "a1",
      title: "New title",
    };
    expect(describeEpicWriteCommandIntent(intent)).toBe(
      "Rename to “New title”",
    );
  });

  it("describes a delete-artifact intent", () => {
    const intent: EpicWriteCommandIntent = {
      kind: "delete-artifact",
      artifactId: "a1",
    };
    expect(describeEpicWriteCommandIntent(intent)).toBe("Delete");
  });

  it("describes a reparent-artifact intent to the top level (null parentId) distinctly from a move", () => {
    const intent: EpicWriteCommandIntent = {
      kind: "reparent-artifact",
      artifactId: "a1",
      parentId: null,
    };
    expect(describeEpicWriteCommandIntent(intent)).toBe("Move to top level");
  });

  it("describes a reparent-artifact intent under a non-null parentId as a plain move", () => {
    const intent: EpicWriteCommandIntent = {
      kind: "reparent-artifact",
      artifactId: "a1",
      parentId: "a2",
    };
    expect(describeEpicWriteCommandIntent(intent)).toBe("Move");
  });

  it("describes an update-artifact-status intent", () => {
    const intent: EpicWriteCommandIntent = {
      kind: "update-artifact-status",
      artifactId: "a1",
      artifactType: "ticket",
      status: 1,
    };
    expect(describeEpicWriteCommandIntent(intent)).toBe("Change status");
  });

  it("describes an update-epic-title intent by its target title", () => {
    const intent: EpicWriteCommandIntent = {
      kind: "update-epic-title",
      title: "New epic title",
      updatedAt: 1000,
    };
    expect(describeEpicWriteCommandIntent(intent)).toBe(
      "Rename epic to “New epic title”",
    );
  });
});
