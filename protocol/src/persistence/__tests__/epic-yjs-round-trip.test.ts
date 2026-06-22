/**
 * Pre-flight round-trip test for the V200 epic on-disk record.
 *
 * Seeds a representative live V200 epic Yjs root map in its post-artifact-room
 * cutover shape - a single `artifacts` map (plus matching
 * `deletedArtifacts`) where every entry is metadata-only and references
 * its body artifactRoom via `artifactRoomId`. Body content lives in separate artifact-rooms
 * keyed off `artifact-body:{artifactId}` and is intentionally not part of
 * this round-trip.
 *
 * Materializes the seeded root via the same plain-JS walk that cloud sync
 * uses (`toObject(rootMap)`) and asserts the result parses against
 * `epicSchema`.
 *
 * Its job is structural: if the protocol Zod surface drifts from what the
 * materialized Yjs storage actually produces, this test stops passing. The
 * seed is intentionally self-contained (no cross-workspace fixture import)
 * so the protocol boundary remains clean.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { persistenceRecordRegistry } from "@traycer/protocol/persistence/registry";

const epicSchema = getRecordSchema(persistenceRecordRegistry, "epic", "latest");

// ---- inline `toObject` (mirrors the shared Yjs `toObject` helper) --- //
// Kept inline so protocol tests do not reach across workspaces. Y.XmlFragment
// and Y.Text pass through as live instances - same contract the real
// `toObject` honors.
function fromYjsValue(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Y.XmlFragment || value instanceof Y.Text) return value;
  if (value instanceof Y.Map) {
    const obj: Record<string, unknown> = {};
    value.forEach((v, k) => {
      obj[k] = fromYjsValue(v);
    });
    return obj;
  }
  if (value instanceof Y.Array) {
    return value.toArray().map(fromYjsValue);
  }
  return value;
}

function toPlainObject(map: Y.Map<unknown>): Record<string, unknown> {
  return fromYjsValue(map) as Record<string, unknown>;
}

// ---- Fixture builder -------------------------------------------------- //
// Seeds the unified V200 shape: one `artifacts` Y.Map keyed by id, with
// every entry carrying a `kind` discriminator and a `artifactRoomId` pointing
// at the body artifactRoom (the body fragment itself lives outside the root doc).

function makeSeededEpicDoc(): { doc: Y.Doc; rootMap: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const rootMap = doc.getMap("epic");
  doc.transact(() => {
    rootMap.set("id", "epic-1");
    rootMap.set("title", "Round-trip fixture epic");
    rootMap.set("isTitleEditedByUser", false);
    rootMap.set("createdAt", 1000);
    rootMap.set("updatedAt", 2000);
    rootMap.set("chats", new Y.Map());
    rootMap.set("artifacts", new Y.Map());
    rootMap.set("deletedArtifacts", new Y.Map());
  });
  return { doc, rootMap };
}

function artifactsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("epic").get("artifacts") as Y.Map<unknown>;
}

function deletedArtifactsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("epic").get("deletedArtifacts") as Y.Map<unknown>;
}

function seedSpec(doc: Y.Doc, id: string, artifactRoomId: string): void {
  const spec = new Y.Map<unknown>();
  doc.transact(() => {
    spec.set("kind", "spec");
    spec.set("id", id);
    spec.set("folderName", id);
    spec.set("title", `Spec ${id}`);
    spec.set("artifactRoomId", artifactRoomId);
    spec.set("createdAt", 1000);
    spec.set("updatedAt", 1000);
    spec.set("createdManually", false);
    spec.set("parentId", null);
    artifactsMap(doc).set(id, spec);
  });
}

function seedTicket(
  doc: Y.Doc,
  id: string,
  parentId: string,
  artifactRoomId: string,
): void {
  const ticket = new Y.Map<unknown>();
  doc.transact(() => {
    ticket.set("kind", "ticket");
    ticket.set("id", id);
    ticket.set("folderName", id);
    ticket.set("title", `Ticket ${id}`);
    ticket.set("artifactRoomId", artifactRoomId);
    ticket.set("assignee", "user-1");
    ticket.set("status", 0);
    ticket.set("createdAt", 1000);
    ticket.set("updatedAt", 1000);
    ticket.set("createdManually", false);
    ticket.set("parentId", parentId);
    artifactsMap(doc).set(id, ticket);
  });
}

function seedStory(doc: Y.Doc, id: string, artifactRoomId: string): void {
  const story = new Y.Map<unknown>();
  doc.transact(() => {
    story.set("kind", "story");
    story.set("id", id);
    story.set("folderName", id);
    story.set("title", `Story ${id}`);
    story.set("artifactRoomId", artifactRoomId);
    story.set("assignee", "user-1");
    story.set("status", 1);
    story.set("createdAt", 1000);
    story.set("updatedAt", 1000);
    story.set("createdManually", false);
    story.set("parentId", null);
    artifactsMap(doc).set(id, story);
  });
}

function seedReview(doc: Y.Doc, id: string, artifactRoomId: string): void {
  const review = new Y.Map<unknown>();
  doc.transact(() => {
    review.set("kind", "review");
    review.set("id", id);
    review.set("folderName", id);
    review.set("title", `Review ${id}`);
    review.set("artifactRoomId", artifactRoomId);
    review.set("createdAt", 1000);
    review.set("updatedAt", 1000);
    review.set("createdManually", false);
    review.set("parentId", null);
    artifactsMap(doc).set(id, review);
  });
}

function seedDeletedSpec(doc: Y.Doc, id: string): void {
  const entry = new Y.Map<unknown>();
  doc.transact(() => {
    entry.set("kind", "spec");
    entry.set("id", id);
    entry.set("title", `Deleted Spec ${id}`);
    entry.set("artifactRoomId", null);
    entry.set("deletedAt", "2024-01-01T00:00:00Z");
    deletedArtifactsMap(doc).set(id, entry);
  });
}

function seedDeletedTicket(doc: Y.Doc, id: string): void {
  const entry = new Y.Map<unknown>();
  doc.transact(() => {
    entry.set("kind", "ticket");
    entry.set("id", id);
    entry.set("title", `Deleted Ticket ${id}`);
    entry.set("artifactRoomId", null);
    entry.set("deletedAt", "2024-01-01T00:00:00Z");
    entry.set("status", 2);
    deletedArtifactsMap(doc).set(id, entry);
  });
}

function seedGuiChat(doc: Y.Doc, id: string): void {
  const chats = doc.getMap("epic").get("chats") as Y.Map<unknown>;
  const chat = new Y.Map<unknown>();
  doc.transact(() => {
    chat.set("id", id);
    chat.set("userId", "user-1");
    chat.set("hostId", "host-1");
    chat.set("title", `Chat ${id}`);
    chat.set("isTitleEditedByUser", false);
    chat.set("parentId", null);
    chat.set("createdAt", 1000);
    chat.set("updatedAt", 1000);
    chat.set("messages", []);
    chats.set(id, chat);
  });
}

// ---- The round-trip test ---------------------------------------------- //

describe("epic V200 Yjs → JSON → protocol round-trip (metadata-only artifacts)", () => {
  it("empty epic parses against epicSchema", () => {
    const { rootMap } = makeSeededEpicDoc();
    const materialized = toPlainObject(rootMap);

    const parsed = epicSchema.safeParse(materialized);
    if (!parsed.success) {
      // Surface the Zod error in the test output for quick diagnosis.
      throw new Error(
        `epicSchema rejected materialized empty epic: ${parsed.error.message}`,
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("epic with all four artifact kinds + deleted mirrors parses against epicSchema", () => {
    const { doc, rootMap } = makeSeededEpicDoc();
    seedSpec(doc, "spec-1", "artifact-room-0");
    seedTicket(doc, "ticket-1", "spec-1", "artifact-room-0");
    seedStory(doc, "story-1", "artifact-room-0");
    seedReview(doc, "review-1", "artifact-room-1");
    seedDeletedSpec(doc, "spec-2");
    seedDeletedTicket(doc, "ticket-2");
    seedGuiChat(doc, "chat-1");

    const materialized = toPlainObject(rootMap);

    const parsed = epicSchema.safeParse(materialized);
    if (!parsed.success) {
      throw new Error(
        `epicSchema rejected materialized epic: ${parsed.error.message}`,
      );
    }
    expect(parsed.success).toBe(true);

    // Pin the unified shape: every seeded artifact lives in the single
    // `artifacts` map with the right discriminator, parent wiring, and
    // artifact-room reference.
    const epic = parsed.data;
    expect(epic.artifacts["spec-1"].kind).toBe("spec");
    expect(epic.artifacts["spec-1"].artifactRoomId).toBe("artifact-room-0");
    expect(epic.artifacts["ticket-1"].kind).toBe("ticket");
    expect(epic.artifacts["ticket-1"].parentId).toBe("spec-1");
    expect(epic.artifacts["ticket-1"].artifactRoomId).toBe("artifact-room-0");
    expect(epic.artifacts["story-1"].kind).toBe("story");
    expect(epic.artifacts["story-1"].artifactRoomId).toBe("artifact-room-0");
    expect(epic.artifacts["review-1"].kind).toBe("review");
    expect(epic.artifacts["review-1"].artifactRoomId).toBe("artifact-room-1");
    expect(epic.deletedArtifacts["spec-2"].kind).toBe("spec");
    expect(epic.deletedArtifacts["ticket-2"].kind).toBe("ticket");
    expect(Object.keys(epic.chats)).toEqual(["chat-1"]);

    // Body content stays out of the root materialization - assert it.
    for (const entry of Object.values(epic.artifacts)) {
      expect("content" in entry).toBe(false);
    }
  });
});
