/**
 * Protocol-boundary contract for the B3 metadata-only artifact schema.
 *
 * Root artifact metadata no longer carries inline body content. Each
 * spec/ticket/story/review entry instead carries a `artifactRoomId` pointing
 * to the artifact-room that hosts the artifact's
 * `artifact-body:{artifactId}` fragment.
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import { describe, expect, it } from "vitest";
import {
  buildDeletedEpicArtifact,
  deletedEpicArtifactSchema,
  epicArtifactSchema,
  reviewArtifactSchema,
  specArtifactSchema,
  storyArtifactSchema,
  ticketArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";

const BASE_ARTIFACT_FIELDS = {
  id: "art-1",
  folderName: "art-1",
  title: "Title",
  artifactRoomId: "artifact-room-0",
  createdAt: 1000,
  updatedAt: 1000,
  createdManually: false,
  parentId: null as string | null,
};

describe("epic artifact schema metadata-only contract", () => {
  it("specArtifactSchema accepts metadata-only entries with artifactRoomId", () => {
    const valid = specArtifactSchema.safeParse({
      kind: "spec",
      ...BASE_ARTIFACT_FIELDS,
    });
    expect(valid.success).toBe(true);
  });

  it("specArtifactSchema rejects entries missing artifactRoomId", () => {
    const missingArtifactRoom = specArtifactSchema.safeParse({
      kind: "spec",
      id: "art-1",
      folderName: "art-1",
      title: "Title",
      createdAt: 1000,
      updatedAt: 1000,
      createdManually: false,
      parentId: null,
    });
    expect(missingArtifactRoom.success).toBe(false);
  });

  it("ticketArtifactSchema requires artifactRoomId + assignee + status", () => {
    const valid = ticketArtifactSchema.safeParse({
      kind: "ticket",
      ...BASE_ARTIFACT_FIELDS,
      assignee: "user-1",
      status: 0,
    });
    expect(valid.success).toBe(true);

    const missingArtifactRoom = ticketArtifactSchema.safeParse({
      kind: "ticket",
      id: "art-1",
      folderName: "art-1",
      title: "Title",
      createdAt: 1000,
      updatedAt: 1000,
      createdManually: false,
      parentId: null,
      assignee: "user-1",
      status: 0,
    });
    expect(missingArtifactRoom.success).toBe(false);
  });

  it("storyArtifactSchema accepts metadata-only entries with artifactRoomId", () => {
    const valid = storyArtifactSchema.safeParse({
      kind: "story",
      ...BASE_ARTIFACT_FIELDS,
      assignee: "user-1",
      status: 0,
    });
    expect(valid.success).toBe(true);
  });

  it("reviewArtifactSchema accepts metadata-only entries with artifactRoomId", () => {
    const valid = reviewArtifactSchema.safeParse({
      kind: "review",
      ...BASE_ARTIFACT_FIELDS,
    });
    expect(valid.success).toBe(true);

    const missingArtifactRoom = reviewArtifactSchema.safeParse({
      kind: "review",
      id: "art-1",
      folderName: "art-1",
      title: "Title",
      createdAt: 1000,
      updatedAt: 1000,
      createdManually: false,
      parentId: null,
    });
    expect(missingArtifactRoom.success).toBe(false);
  });

  it("epicArtifactSchema accepts metadata-only entries (content omitted)", () => {
    // Post-cutover: `content` is no longer part of the artifact metadata
    // contract - body lives in the artifact-room indexed by `artifactRoomId`.
    const metadataOnly = epicArtifactSchema.safeParse({
      kind: "spec",
      ...BASE_ARTIFACT_FIELDS,
    });
    expect(metadataOnly.success).toBe(true);
  });

  it("epicArtifactSchema strips a stray content field if present", () => {
    // Inline body fields written by pre-cutover writers are not part of the
    // target shape; Zod's `.object()` strips unknown keys by default, so
    // parsing succeeds but `content` is dropped from the parsed value.
    const withStrayContent = epicArtifactSchema.safeParse({
      kind: "spec",
      ...BASE_ARTIFACT_FIELDS,
      content: { type: "doc", content: [] },
    });
    expect(withStrayContent.success).toBe(true);
    if (withStrayContent.success) {
      expect("content" in withStrayContent.data).toBe(false);
    }
  });

  it("accepts every legacy slim tombstone and strips future unknown keys", () => {
    for (const kind of ["spec", "ticket", "story", "review"] as const) {
      const parsed = deletedEpicArtifactSchema.parse({
        id: `deleted-${kind}`,
        kind,
        title: `Deleted ${kind}`,
        artifactRoomId: null,
        deletedAt: "2026-08-14T00:00:00.000Z",
        futureScalar: "ignored-by-current-reader",
      });
      expect(parsed).not.toHaveProperty("futureScalar");
      expect(parsed).not.toHaveProperty("folderName");
    }
  });

  it("builds one total enriched tombstone shape for every artifact kind", () => {
    const ticket = ticketArtifactSchema.parse({
      kind: "ticket",
      ...BASE_ARTIFACT_FIELDS,
      assignee: "user-1",
      status: 2,
    });
    expect(
      buildDeletedEpicArtifact(ticket, "2026-08-14T00:00:00.000Z"),
    ).toEqual({
      id: "art-1",
      kind: "ticket",
      title: "Title",
      artifactRoomId: "artifact-room-0",
      deletedAt: "2026-08-14T00:00:00.000Z",
      folderName: "art-1",
      parentId: null,
      createdAt: 1000,
      createdManually: false,
      assignee: "user-1",
      status: 2,
    });

    const spec = specArtifactSchema.parse({
      kind: "spec",
      ...BASE_ARTIFACT_FIELDS,
      artifactRoomId: "",
    });
    expect(
      buildDeletedEpicArtifact(spec, "2026-08-14T00:00:00.000Z"),
    ).toMatchObject({
      artifactRoomId: null,
      assignee: null,
      status: null,
    });

    const story = storyArtifactSchema.parse({
      kind: "story",
      ...BASE_ARTIFACT_FIELDS,
      assignee: "user-2",
      status: 1,
    });
    expect(
      buildDeletedEpicArtifact(story, "2026-08-14T00:00:00.000Z"),
    ).toMatchObject({
      kind: "story",
      assignee: "user-2",
      status: 1,
    });
  });
});
