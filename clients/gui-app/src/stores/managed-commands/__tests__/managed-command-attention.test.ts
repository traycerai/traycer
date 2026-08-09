import { beforeEach, describe, expect, it } from "vitest";
import type {
  ManagedCommand,
  ManagedCommandStatus,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import { managedCommandNeedsAttention } from "@/lib/managed-commands/managed-command-copy";
import {
  unacknowledgedAttentionCommands,
  useManagedCommandAttentionStore,
} from "@/stores/managed-commands/managed-command-attention-store";

/**
 * The chat badge's whole rule, and the acknowledgement that quiets it.
 *
 * Unifying monitors and shells collapsed two rules into one: a failure is the
 * only ending worth a badge, and `monitoring` has NO say in it. The old model
 * badged any exit from a monitor - including a clean one - which is exactly
 * what these cases pin shut, since `monitoring` is now live-mutable and a rule
 * that read it would make the badge depend on when the flag was last flipped.
 */

const BASE: ManagedCommand = {
  id: "cmd-1",
  monitoring: true,
  description: "deploy watcher",
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  createdAtMs: 10,
  updatedAtMs: 10,
};

function withStatus(
  status: ManagedCommandStatus,
  over: Partial<ManagedCommand>,
): ManagedCommand {
  return { ...BASE, status, ...over };
}

const CLEAN_EXIT: ManagedCommandStatus = {
  state: "exited",
  exitCode: 0,
  signal: null,
  exitedAtMs: 20,
};
const FAILED_EXIT: ManagedCommandStatus = {
  state: "exited",
  exitCode: 1,
  signal: null,
  exitedAtMs: 20,
};
// A shell the host could never start: it reaches `exited` having observed
// neither a code nor a signal. Nothing ran, which is the thing to be told.
const SPAWN_FAILURE: ManagedCommandStatus = {
  state: "exited",
  exitCode: null,
  signal: null,
  exitedAtMs: 20,
};

describe("managedCommandNeedsAttention", () => {
  it("badges a non-zero exit", () => {
    expect(
      managedCommandNeedsAttention(
        withStatus(FAILED_EXIT, { monitoring: true }),
      ),
    ).toBe(true);
    expect(
      managedCommandNeedsAttention(
        withStatus(FAILED_EXIT, { monitoring: false }),
      ),
    ).toBe(true);
  });

  it("badges a signal death", () => {
    const killed: ManagedCommandStatus = {
      state: "exited",
      exitCode: null,
      signal: "SIGSEGV",
      exitedAtMs: 20,
    };
    expect(managedCommandNeedsAttention(withStatus(killed, {}))).toBe(true);
  });

  it("badges a spawn failure, which reports neither a code nor a signal", () => {
    expect(managedCommandNeedsAttention(withStatus(SPAWN_FAILURE, {}))).toBe(
      true,
    );
  });

  it("never badges a clean exit, whether or not the shell was monitoring", () => {
    // The rule that this replaces badged ANY exit from a monitoring shell, on
    // the theory that a watcher which stopped watching is news. It is not: the
    // shell's own final digest says so, and with a live-mutable flag the badge
    // would otherwise depend on when it was last flipped.
    expect(
      managedCommandNeedsAttention(
        withStatus(CLEAN_EXIT, { monitoring: true }),
      ),
    ).toBe(false);
    expect(
      managedCommandNeedsAttention(
        withStatus(CLEAN_EXIT, { monitoring: false }),
      ),
    ).toBe(false);
  });

  it("never badges a stop, a host-death interrupt, or a live shell", () => {
    const cases: readonly ManagedCommandStatus[] = [
      { state: "stopped", stoppedAtMs: 20 },
      { state: "interrupted", interruptedAtMs: 20 },
      { state: "running", pid: 4410, startedAtMs: 10 },
    ];
    for (const status of cases) {
      expect(managedCommandNeedsAttention(withStatus(status, {}))).toBe(false);
      expect(
        managedCommandNeedsAttention(withStatus(status, { monitoring: false })),
      ).toBe(false);
    }
  });
});

describe("the attention store", () => {
  beforeEach(() => {
    useManagedCommandAttentionStore.setState(
      { acknowledgedEndingById: {} },
      false,
    );
  });

  const failed = withStatus(FAILED_EXIT, { id: "failed", updatedAtMs: 20 });
  const cleanWatcher = withStatus(CLEAN_EXIT, {
    id: "clean-watcher",
    monitoring: true,
    updatedAtMs: 20,
  });

  it("reports only the endings the rule calls news", () => {
    expect(
      unacknowledgedAttentionCommands([failed, cleanWatcher], {}).map(
        (command) => command.id,
      ),
    ).toEqual(["failed"]);
  });

  it("goes quiet once the ending has been acknowledged", () => {
    useManagedCommandAttentionStore.getState().acknowledge([failed]);
    const acknowledged =
      useManagedCommandAttentionStore.getState().acknowledgedEndingById;

    expect(unacknowledgedAttentionCommands([failed], acknowledged)).toEqual([]);
  });

  it("re-arms when the same shell fails again", () => {
    useManagedCommandAttentionStore.getState().acknowledge([failed]);
    const failedAgain: ManagedCommand = {
      ...failed,
      status: { ...FAILED_EXIT, exitCode: 2, exitedAtMs: 99 },
      updatedAtMs: 99,
    };

    expect(
      unacknowledgedAttentionCommands(
        [failedAgain],
        useManagedCommandAttentionStore.getState().acknowledgedEndingById,
      ).map((command) => command.id),
    ).toEqual(["failed"]);
  });

  it("records nothing for an ending that was never news", () => {
    // Acknowledging a set stamps only its attention-worthy members, so a
    // clean exit cannot occupy the map and silence a later failure that
    // happens to land on the same `updatedAtMs`.
    useManagedCommandAttentionStore.getState().acknowledge([cleanWatcher]);

    expect(
      useManagedCommandAttentionStore.getState().acknowledgedEndingById,
    ).toEqual({});
  });

  it("stays quiet when a dead shell's record changes around an acknowledged failure", () => {
    // The flag is live-mutable: an agent muting a failed shell (or editing its
    // description) bumps `updatedAtMs` without a new ending. That must not
    // re-light a badge the human already read - acknowledgement is keyed to
    // the ending, not the record.
    useManagedCommandAttentionStore.getState().acknowledge([failed]);
    const mutedAfterFailure: ManagedCommand = {
      ...failed,
      monitoring: false,
      updatedAtMs: 99,
    };

    expect(
      unacknowledgedAttentionCommands(
        [mutedAfterFailure],
        useManagedCommandAttentionStore.getState().acknowledgedEndingById,
      ),
    ).toEqual([]);
  });

  it("merges across chats rather than rebuilding from the set in hand", () => {
    // Each chat's menu only ever knows its own shells; rebuilding would re-arm
    // every other chat's already-seen failure.
    const theirs = withStatus(FAILED_EXIT, {
      id: "theirs",
      chatId: "chat-2",
      updatedAtMs: 20,
    });
    useManagedCommandAttentionStore.getState().acknowledge([failed]);
    useManagedCommandAttentionStore.getState().acknowledge([theirs]);

    expect(
      unacknowledgedAttentionCommands(
        [failed, theirs],
        useManagedCommandAttentionStore.getState().acknowledgedEndingById,
      ),
    ).toEqual([]);
  });
});
