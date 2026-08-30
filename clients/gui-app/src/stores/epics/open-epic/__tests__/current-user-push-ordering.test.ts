/**
 * The worker learns WHO IS SIGNED IN before it is asked to re-derive for them.
 *
 * The worker's projector folds on `getCurrentUserId()`, which is fed by the
 * `current-user` event and by nothing else. Two properties follow, and this
 * file pins both because each fails silently and in the FAIL-OPEN direction -
 * a null or stale user does not hide another account's chats and terminal
 * agents, it shows them.
 *
 *  1. The push happens at CONSTRUCTION. A session built before the auth
 *     profile hydrates would otherwise project its first frames for nobody.
 *  2. On a user change the push happens BEFORE the re-derive commands.
 *     `republish-records-for-current-user` rebuilds the record slices for
 *     "the current user", and the worker's answer to that question is
 *     whatever this last pushed - so an emitter ordered after it rebuilds
 *     them for the identity being replaced, which is the exact staleness the
 *     command exists to clear.
 *
 * Pinned at the BINDING rather than through the worker: the ordering is this
 * store's, the binding is the seam it acts through, and a recording binding
 * states the property directly instead of inferring it from a projection two
 * hops away.
 */
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
    //
    // `options.userId` and the auth profile carry the SAME VALUE in production
    // and are not the same FACT: the option is the identity persisted state is
    // namespaced under, while the projector's question is who is signed in
    // right now. This pushed the option once, so every caller that namespaces
    // by nothing started its worker with no viewer - and a null viewer hides
    // nothing, which is the fail-OPEN direction.
    //
    // The two are deliberately DIFFERENT here. A refactor that reads the
    // option again - reasonable-looking, since they match in production - goes
    // red on this line rather than in a projection nobody is watching.
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
    // `null` is a REPRESENTED answer - "no viewer" - and the worker's fold
    // needs it stated. Silence is indistinguishable from a push that was
    // never wired, which is exactly the defect this event had.
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
    // ...and the identity landed FIRST. Ablate by moving the push below the
    // commands in `store.ts` and this goes red while every other assertion
    // in this file still passes - which is the point: the ordering is the
    // property, not the presence.
    expect(pushIndex).toBeLessThan(republishIndex);
    expect(pushIndex).toBeLessThan(reprojectIndex);

    opened.dispose();
  });
});
