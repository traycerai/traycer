import { describe, expect, it } from "vitest";
import {
  checkCompatibility,
  mergeConnectionManifests,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import {
  artifactVersionProvenanceSchema,
  artifactVersionsRestoreResponseSchema,
  deletedArtifactsReviveRequestSchema,
} from "@traycer/protocol/host/epic/artifact-versions";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

const ARTIFACT_VERSION_METHODS = [
  "epic.artifactVersions.list",
  "epic.artifactVersions.getBlob",
  "epic.artifactVersions.restore",
  "epic.deletedArtifacts.list",
  "epic.deletedArtifacts.revive",
  "epic.artifactVersionSettings.get",
  "epic.artifactVersionSettings.setEnabled",
  "epic.artifactVersionSettings.setRetentionPolicy",
  "epic.artifactVersionSettings.clearHistory",
] as const;

const HASH = "a".repeat(64);

describe("artifact-versioning handshake compatibility", () => {
  const current = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );

  it.each(ARTIFACT_VERSION_METHODS)(
    "%s negotiates only on the optional 1.0 channel",
    (method) => {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      expect(releasedMethodNames).not.toContain(method);
      expect(current.manifest[method]).toBeUndefined();
      expect(current.optionalManifest[method]).toEqual({ major: 1, minor: 0 });
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
    },
  );

  it("keeps the floor manifest compatible with itself from the host role, with the artifact-version family absent from both sides", () => {
    const floorManifest = current.manifest;
    expect(
      checkCompatibility(
        hostRpcRegistry,
        floorManifest,
        floorManifest,
        "host",
      ),
    ).toEqual({ ok: true });
    for (const method of ARTIFACT_VERSION_METHODS) {
      expect(floorManifest[method]).toBeUndefined();
    }
  });

  it("keeps the floor manifest compatible with itself from the client role and degrades history per call", () => {
    const floorManifest = current.manifest;
    expect(
      checkCompatibility(
        hostRpcRegistry,
        floorManifest,
        floorManifest,
        "client",
      ),
    ).toEqual({ ok: true });
    for (const method of ARTIFACT_VERSION_METHODS) {
      expect(floorManifest[method]).toBeUndefined();
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
    }
  });

  it("keeps two peers that both advertise the optional artifact-versioning family compatible", () => {
    const negotiatedManifest = mergeConnectionManifests(
      current.manifest,
      current.optionalManifest,
    );
    expect(
      checkCompatibility(
        hostRpcRegistry,
        negotiatedManifest,
        negotiatedManifest,
        "host",
      ),
    ).toEqual({ ok: true });
    for (const method of ARTIFACT_VERSION_METHODS) {
      expect(negotiatedManifest[method]).toEqual({ major: 1, minor: 0 });
    }
  });
});

describe("artifact-versioning protocol shapes", () => {
  it.each([
    {
      kind: "agent",
      chatId: "chat-1",
      turnId: "turn-1",
      harnessId: "claude",
      chatTitle: "Architecture",
    },
    { kind: "user_session", userId: "user-1", hostId: "host-1" },
    {
      kind: "multiple_agents",
      agents: [
        {
          chatId: "chat-1",
          turnId: "turn-1",
          harnessId: "claude",
          chatTitle: null,
        },
      ],
    },
    {
      kind: "external",
      attemptedAgentWrites: [
        {
          chatId: "chat-2",
          turnId: "turn-2",
          harnessId: "codex",
          chatTitle: "Implementation",
        },
      ],
    },
    { kind: "system", trigger: "drift", originalActorHint: null },
    { kind: "remote_merge" },
    {
      kind: "restore",
      restoredFromObservationId: "observation-1",
      targetHash: HASH,
    },
    { kind: "revive", deletionEventId: null, targetHash: HASH },
    { kind: "delete", deleteOpId: "delete-1", actorKind: "agent" },
    { kind: "clobber", source: "quarantine-disk-bytes" },
  ])("accepts the $kind provenance arm", (provenance) => {
    expect(artifactVersionProvenanceSchema.safeParse(provenance).success).toBe(
      true,
    );
  });

  it("rejects the old open-ended ref envelope and extra fields", () => {
    expect(
      artifactVersionProvenanceSchema.safeParse({
        kind: "agent",
        ref: { agentId: "chat-1" },
      }).success,
    ).toBe(false);
    expect(
      artifactVersionProvenanceSchema.safeParse({
        kind: "remote_merge",
        ref: null,
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      kind: "preflight",
      imagesMissing: [HASH],
      threadCount: 2,
      currentHash: HASH,
    },
    {
      kind: "outcome",
      status: "clean",
      orphanedThreads: 0,
      newObservationId: "observation-1",
    },
    { kind: "conflict", currentHash: HASH },
    { kind: "unavailable", reason: "storage_full" },
    { kind: "unavailable", reason: "journal_cap" },
  ])("accepts the $kind restore response arm", (response) => {
    expect(
      artifactVersionsRestoreResponseSchema.safeParse(response).success,
    ).toBe(true);
  });

  it("keeps revive targeted only by epic and artifact identity", () => {
    expect(
      deletedArtifactsReviveRequestSchema.parse({
        epicId: "epic-1",
        artifactId: "artifact-1",
        targetObservationId: "observation-1",
      }),
    ).toEqual({ epicId: "epic-1", artifactId: "artifact-1" });
  });
});
