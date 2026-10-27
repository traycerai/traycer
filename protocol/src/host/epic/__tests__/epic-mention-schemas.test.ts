import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  epicMentionArtifactsRequestSchema,
  epicMentionArtifactsResponseSchema,
  epicMentionEpicsRequestSchema,
  epicMentionEpicsResponseSchema,
  epicMentionSpecsResponseSchema,
} from "@traycer/protocol/host/index";

describe("epic mention host schemas", () => {
  it("accepts separate epic and artifact mention shapes", () => {
    expect(
      epicMentionEpicsRequestSchema.safeParse({
        query: "login",
        limit: 8,
      }).success,
    ).toBe(true);

    expect(
      epicMentionArtifactsRequestSchema.safeParse({
        query: "auth",
        limit: 8,
      }).success,
    ).toBe(true);

    expect(
      epicMentionEpicsResponseSchema.safeParse({
        entries: [
          {
            kind: "epic",
            id: "epic:epic-1",
            token: "epic:epic-1",
            epicId: "epic-1",
            label: "Login flow",
            description: "1 spec, 2 tickets",
            status: "active",
            updatedAt: 123,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      epicMentionSpecsResponseSchema.safeParse({
        entries: [
          {
            kind: "epic-artifact",
            id: "spec:epic-1:spec-1",
            token: "spec:epic-1/spec-1",
            epicId: "epic-1",
            epicTitle: "Login flow",
            artifactId: "spec-1",
            artifactType: "spec",
            label: "Auth spec",
            description: "Login flow",
            status: null,
            updatedAt: 123,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("registers single-purpose epic mention methods at v1.0", () => {
    expect(
      hostRpcRegistry["epic.mentionEpics"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["epic.mentionSpecs"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["epic.mentionTickets"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["epic.mentionStories"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["epic.mentionReviews"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
  });

  it("lists artifacts of any kind through one optional method", () => {
    expect(hostRpcRegistry["epic.mentionArtifacts"].degrade).toEqual({
      kind: "unsupported",
    });
    expect(
      hostRpcRegistry["epic.mentionArtifacts"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });

    const canvasRow = {
      kind: "epic-artifact",
      id: "canvas:epic-1:canvas-1",
      token: "canvas:epic-1/canvas-1",
      epicId: "epic-1",
      epicTitle: "Login flow",
      artifactId: "canvas-1",
      artifactType: "canvas",
      label: "Checkout screens",
      description: "Login flow",
      status: null,
      updatedAt: 123,
    };
    const fileRow = {
      ...canvasRow,
      id: "file-artifact:epic-1:file-1",
      token: "file-artifact:epic-1/file-1",
      artifactId: "file-1",
      artifactType: "file",
      label: "logo.png",
    };

    expect(
      epicMentionArtifactsResponseSchema.safeParse({
        entries: [canvasRow, fileRow],
      }).success,
    ).toBe(true);
    expect(
      epicMentionArtifactsResponseSchema.safeParse({
        entries: [{ ...canvasRow, artifactType: "unknown-kind" }],
      }).success,
    ).toBe(false);
  });
});
