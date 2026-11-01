import { describe, expect, it } from "vitest";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  resolveChatSandbox,
  type ChatSandboxState,
  type ChatSandboxViewer,
  type SandboxMovingState,
} from "@/lib/sandboxes/chat-sandbox-state";

const SANDBOX = sandboxSummaryFixture({
  id: "sbx-p1",
  displayName: "e2e-sbx-p1",
});

/** An owner, a team member, a collaborator and a viewer of the same chat. */
const ROLES: ReadonlyArray<readonly [string, ChatSandboxViewer]> = [
  [
    "owner",
    {
      reachable: false,
      canEdit: true,
      ownedByViewer: true,
      environmentOwned: false,
      staysReadable: true,
    },
  ],
  [
    "team member",
    {
      reachable: false,
      canEdit: true,
      ownedByViewer: false,
      environmentOwned: true,
      staysReadable: true,
    },
  ],
  [
    "collaborator",
    {
      reachable: false,
      canEdit: true,
      ownedByViewer: false,
      environmentOwned: false,
      staysReadable: true,
    },
  ],
  [
    "viewer",
    {
      reachable: false,
      canEdit: false,
      ownedByViewer: true,
      environmentOwned: false,
      staysReadable: true,
    },
  ],
];

function resting(
  configuration: Extract<
    ChatSandboxState,
    { readonly kind: "resting" }
  >["configuration"],
): ChatSandboxState {
  return {
    kind: "resting",
    sandbox: { ...SANDBOX, state: "stopped" },
    configuration,
    wakeChangesPayer: false,
  };
}

describe("resolveChatSandbox", () => {
  it("says the final failed-start sentence in the chat slot", () => {
    const sandbox = sandboxSummaryFixture({
      displayName: "build-box",
      state: "failed",
      failureCode: "boot-timeout",
      lastTransitionAt: new Date(2026, 9, 25, 11, 1).getTime(),
    });
    const view = resolveChatSandbox({ kind: "failed", sandbox }, ROLES[0][1]);

    expect(view.line).toMatchObject({
      place: "slot",
      text: "Couldn't start build-box at 11:01 · SBX-0414",
    });
    expect(view.composer).toEqual({ kind: "line" });
  });

  it.each([
    ["creating", "Starting e2e-sbx-p1 · pending"],
    ["starting", "Starting e2e-sbx-p1 · pending"],
    ["resuming", "Resuming e2e-sbx-p1 · pending"],
    ["suspending", "Suspending e2e-sbx-p1 · pending"],
    ["stopping", "Stopping e2e-sbx-p1 · pending"],
    ["destroying", "Destroying e2e-sbx-p1 · pending"],
  ] as const satisfies ReadonlyArray<readonly [SandboxMovingState, string]>)(
    "says a %s sandbox as its row does, in the composer's place",
    (state, text) => {
      const view = resolveChatSandbox(
        { kind: "moving", sandbox: { ...SANDBOX, state }, state },
        ROLES[0][1],
      );

      expect(view.line).toMatchObject({ place: "slot", text });
      expect(view.composer).toEqual({ kind: "line" });
    },
  );

  it.each(ROLES)(
    "gives the %s the same unknown line while the host does not answer",
    (_role, viewer) => {
      const view = resolveChatSandbox(
        { kind: "pending", name: "e2e-sbx-p1" },
        viewer,
      );

      expect(view.line).toMatchObject({
        place: "slot",
        text: "e2e-sbx-p1 isn't available — this chat stays readable.",
      });
      expect(view.composer).toEqual({ kind: "line" });
    },
  );

  it("drops the promise from the unknown line where no read shows a copy", () => {
    const view = resolveChatSandbox(
      { kind: "pending", name: "e2e-sbx-p1" },
      { ...ROLES[0][1], staysReadable: false },
    );

    expect(view.line).toMatchObject({
      place: "slot",
      text: "e2e-sbx-p1 isn't available.",
    });
  });

  it("leaves an unknown state whose host answers, and a person's host, to the surface's own path", () => {
    const answered = { ...ROLES[0][1], reachable: true };

    expect(
      resolveChatSandbox({ kind: "pending", name: "e2e-sbx-p1" }, answered),
    ).toEqual({ line: null, composer: { kind: "ordinary" } });
    expect(resolveChatSandbox({ kind: "none" }, ROLES[0][1])).toEqual({
      line: null,
      composer: { kind: "ordinary" },
    });
  });

  it.each(ROLES)(
    "says a resting sandbox's state alone, with nobody sending, to the %s before its configuration resolves",
    (_role, viewer) => {
      const view = resolveChatSandbox(resting(null), viewer);

      expect(view.line).toMatchObject({
        place: "slot",
        text: "e2e-sbx-p1 is stopped",
      });
      expect(view.composer).toEqual({ kind: "line" });
    },
  );

  it.each([
    ["owner", "wake"],
    ["team member", "wake"],
    ["collaborator", "ordinary"],
    ["viewer", "ordinary"],
  ] as const)(
    "puts a resting sandbox with its configuration in the footer, and gives the %s the %s composer",
    (role, composer) => {
      const viewer = ROLES.find(([name]) => name === role)?.[1];
      if (viewer === undefined) throw new Error(`no role ${role}`);

      const view = resolveChatSandbox(resting({ kind: "personal" }), viewer);

      expect(view.line).toMatchObject({
        place: "footer",
        text: "e2e-sbx-p1 is stopped",
      });
      expect(view.composer.kind).toBe(composer);
    },
  );
});
