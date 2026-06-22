/**
 * B6 scoped root/artifact-room protocol-boundary characterization
 * (ticket:e86b8372-ad33-45d7-9672-2e1851d777e8/900a0484).
 *
 * `epic.subscribe@1.0` is now scope-aware. These tests pin the
 * post-cutover contract:
 *
 *   - Root snapshot/update/awareness frames continue to identify only
 *     `epicId` - no `artifactRoomId` on root-scoped frames.
 *   - Artifact-room-scoped frames MUST carry `artifactRoomId`.
 *   - The artifact-room frame kinds (`artifactRoomSnapshot`, `artifactRoomUpdate`,
 *     `artifactRoomAwareness`, `artifactRoomState`, plus client `artifactRoomApplyUpdate` /
 *     `artifactRoomAwareness`) are recognized; other invented kinds still fail.
 */
import { describe, expect, it } from "vitest";
import {
  epicSubscribeClientFrameSchema,
  epicSubscribeServerFrameSchema,
} from "@traycer/protocol/host/epic/subscribe";

describe("epic.subscribe@1.0 scoped root/artifact-room contract (B6)", () => {
  it("server snapshot frame has no artifact-room scope discriminator", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "snapshot",
      epicId: "epic-1",
      meta: {
        schemaVersion: "1.0.0",
        epicLight: null,
        permissionRole: "owner",
        repos: [],
        workspaces: [],
        repoMapping: [],
        workspaceFolders: [],
        unresolvedRepos: [],
        hostStateVectorBase64: "AQ==",
      },
      hasBinaryPayload: true,
    });
    expect(parsed.kind).toBe("snapshot");
    expect(Object.keys(parsed)).not.toContain("artifactRoomId");
    expect(Object.keys(parsed)).not.toContain("scope");
  });

  it("server update frame has no artifact-room scope discriminator", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "update",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    expect(parsed.kind).toBe("update");
    expect(Object.keys(parsed)).not.toContain("artifactRoomId");
    expect(Object.keys(parsed)).not.toContain("scope");
  });

  it("server awareness frame has no artifact-room scope discriminator", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "awareness",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    expect(parsed.kind).toBe("awareness");
    expect(Object.keys(parsed)).not.toContain("artifactRoomId");
    expect(Object.keys(parsed)).not.toContain("scope");
  });

  it("client applyUpdate frame has no artifact-room scope discriminator", () => {
    const parsed = epicSubscribeClientFrameSchema.parse({
      kind: "applyUpdate",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    expect(parsed.kind).toBe("applyUpdate");
    expect(Object.keys(parsed)).not.toContain("artifactRoomId");
    expect(Object.keys(parsed)).not.toContain("scope");
  });

  it("server frame schema recognizes the artifact-room frame kinds added by B6", () => {
    const artifactRoomSnapshot = epicSubscribeServerFrameSchema.safeParse({
      kind: "artifactRoomSnapshot",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hostArtifactRoomStateVectorBase64: "AQ==",
      hasBinaryPayload: true,
    });
    expect(artifactRoomSnapshot.success).toBe(true);

    const artifactRoomState = epicSubscribeServerFrameSchema.safeParse({
      kind: "artifactRoomState",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      state: "unavailable",
      hasBinaryPayload: false,
    });
    expect(artifactRoomState.success).toBe(true);

    // A made-up kind not present in the discriminated union must still
    // fail closed so an out-of-version host cannot smuggle frames in.
    const invented = epicSubscribeServerFrameSchema.safeParse({
      kind: "artifactRoomSomething",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hasBinaryPayload: false,
    });
    expect(invented.success).toBe(false);
  });
});
