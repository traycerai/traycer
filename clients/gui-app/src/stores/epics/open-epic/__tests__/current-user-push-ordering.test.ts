import { afterEach, describe, expect, it } from "vitest";
import { createOpenEpicStore } from "@/stores/epics/open-epic/store";
import type { EpicRuntimeBinding } from "@/stores/epics/open-epic/store";
import { createProcessBackedAccountingPort } from "@/stores/epics/open-epic/runtime/process-backed-accounting-port";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Every call the store makes on its runtime, in order, as one flat log. */
function createRecordingBinding(): {
  readonly binding: EpicRuntimeBinding;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const binding: EpicRuntimeBinding = {
    port: {
      // Never resolves. No test here drives a call, and a resolving stub would
      // invite one to be added that this file cannot actually serve.
      call: () => new Promise(() => {}),
    },
    command: (command) => {
      calls.push(`command:${command.kind}`);
    },
    awarenessOut: () => {},
    currentUser: (userId) => {
      calls.push(`current-user:${userId ?? "null"}`);
    },
    detach: () => {},
    dispose: () => {},
  };
  return { binding, calls };
}

function openWithRecording(userId: string | null): {
  readonly calls: string[];
  readonly dispose: () => void;
} {
  const { binding, calls } = createRecordingBinding();
  const handle = createOpenEpicStore({
    epicId: "epic-current-user",
    userId,
    hostId: "test-host",
    // Unreached: this suite never calls `retryTransport`. Answered anyway
    // rather than defaulted, so it stays a decision the option forces.
    onRetryTransport: () => {},
    runtime: binding,
    accounting: createProcessBackedAccountingPort({
      hostId: "test-host",
      epicId: "epic-current-user",
      environment: createRendererRuntimeEnvironment(),
    }),
  });
  return { calls, dispose: () => handle.dispose() };
}

afterEach(() => {
  useAuthStore.setState({ profile: null });
});

describe("the current-user push", () => {
  it("pushes the AUTH user at construction, not the persistence identity", () => {
    // THE distinguishing case, and the reason this pin exists in this shape.
    useAuthStore.setState({
      profile: {
        userId: "auth-user",
        userName: "Auth User",
        email: "auth@example.com",
      },
    });

    const opened = openWithRecording("persistence-user");

    // FIRST call, not merely present: anything the store does before this
    // would be work the worker does for the wrong viewer.
    expect(opened.calls[0]).toBe("current-user:auth-user");

    opened.dispose();
  });

  it("pushes null when nobody is signed in, rather than staying silent", () => {
    // `null` is a REPRESENTED answer - "no viewer" - and the worker's fold needs it stated. Silence is
    // indistinguishable from a push that was never wired, which is exactly the defect this event had.
    const opened = openWithRecording(null);

    expect(opened.calls[0]).toBe("current-user:null");

    opened.dispose();
  });

  it("pushes the NEW user BEFORE the re-derive commands on a user change", () => {
    const opened = openWithRecording("user-1");
    opened.calls.length = 0;

    useAuthStore.setState({
      profile: {
        userId: "user-2",
        userName: "User Two",
        email: "user-2@example.com",
      },
    });

    const pushIndex = opened.calls.indexOf("current-user:user-2");
    const republishIndex = opened.calls.indexOf(
      "command:republish-records-for-current-user",
    );
    const reprojectIndex = opened.calls.indexOf(
      "command:reproject-for-viewer-change",
    );

    // All three happened...
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(republishIndex).toBeGreaterThanOrEqual(0);
    expect(reprojectIndex).toBeGreaterThanOrEqual(0);
    // ...and the identity landed FIRST.
    expect(pushIndex).toBeLessThan(republishIndex);
    expect(pushIndex).toBeLessThan(reprojectIndex);

    opened.dispose();
  });
});
