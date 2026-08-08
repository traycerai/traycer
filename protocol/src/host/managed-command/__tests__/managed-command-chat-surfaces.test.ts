import { describe, expect, it } from "vitest";
import { chatQueuedManagedCommandItemSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { autonomousResumeTriggerSchema } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * The chat-side doors into the managed-command UI: the queue chip and the
 * resume divider. Both name ONE entity - a shell - and carry `notifying` as the
 * state that decides its glyph, never as a second sort of thing.
 *
 * On BOTH shapes the name `kind` is taken by a discriminant (the queue item's
 * union tag, the trigger's persisted source enum), which is why the shell's own
 * state rides beside it rather than on it.
 */

describe("managed-command queue chip", () => {
  it("carries whether the shell is notifying", () => {
    const parsed = chatQueuedManagedCommandItemSchema.parse({
      kind: "managed-command",
      queueItemId: "q-1",
      commandId: "cmd-1",
      notifying: true,
      description: "db migration",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed.notifying).toBe(true);
  });

  it("reads an item persisted before the field existed as unrecorded", () => {
    // The queue is durable: an item rehydrated after a host restart must still
    // parse. Absent means "not recorded", which the chip renders generically -
    // never a flag guessed on its behalf.
    const parsed = chatQueuedManagedCommandItemSchema.parse({
      kind: "managed-command",
      queueItemId: "q-1",
      commandId: "cmd-1",
      description: "db migration",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed.notifying).toBeNull();
  });
});

describe("resume divider trigger", () => {
  it("carries the shell's identity, so the divider is a door", () => {
    const parsed = autonomousResumeTriggerSchema.parse({
      // The source enum still reads `monitor` for every shell - see the last
      // test in this block for why it cannot grow.
      kind: "monitor",
      title: "db migration",
      status: "completed",
      summary: "exited with code 0",
      managedCommand: { commandId: "cmd-1", notifying: true },
    });
    // `commandId` is what a divider click opens the output window on.
    expect(parsed.managedCommand).toEqual({
      commandId: "cmd-1",
      notifying: true,
    });
  });

  it("reads a divider persisted before `notifying` existed as not watching", () => {
    // Chats written while this key still carried a monitor/shell `kind` lose
    // that value on parse. The trigger must survive it: a shell whose watching
    // state is unrecorded renders as a plain one rather than failing the chat.
    const parsed = autonomousResumeTriggerSchema.parse({
      kind: "monitor",
      title: "db migration",
      status: "completed",
      summary: "exited with code 0",
      managedCommand: { commandId: "cmd-1", kind: "shell" },
    });
    expect(parsed.managedCommand).toEqual({
      commandId: "cmd-1",
      notifying: false,
    });
  });

  it("defaults to absent for every trigger that is not a managed command", () => {
    // A subagent or wakeup trigger has no command to open, and every trigger
    // persisted before this key existed has none recorded. Both read as null,
    // which renders the generic card exactly as it always did - that equivalence
    // is what the compat exception for this path rests on.
    const parsed = autonomousResumeTriggerSchema.parse({
      kind: "subagent",
      title: "reviewer",
      status: "completed",
      summary: "done",
    });
    expect(parsed.managedCommand).toBeNull();
  });

  it("keeps the persisted source enum closed", () => {
    // This is the constraint that forced the shell's identity into a keyed
    // property rather than a `kind: "shell"` variant: an unknown value in a
    // PERSISTED enum fails the WHOLE chat's safeParse on an older host, while an
    // unknown defaulted key is silently stripped. Same rule that forced
    // `wakeTriggers` out of `triggers`, and the reason `mcp` and `live` are keys.
    expect(() =>
      autonomousResumeTriggerSchema.parse({
        kind: "shell",
        title: "db migration",
        status: "completed",
        summary: "done",
      }),
    ).toThrow();
  });
});
