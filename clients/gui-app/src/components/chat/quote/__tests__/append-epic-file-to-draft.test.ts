/**
 * What "Attach to chat" puts in the new-conversation draft.
 *
 * The seed used to be markdown - `![name](files/screenshots/...)` - on the
 * reading that the host resolves such a target at message time. It does not for
 * a USER message: user messages are never markdown-rendered and
 * `fileResolutions` are computed for assistant messages only, so the user was
 * shown the raw string. An image now rides as an ordinary composer image
 * attachment (D28 keeps chat images on the chat plane), with the path kept as
 * one line of text so the agent can still read the original off `files/`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  appendEpicFileImageToNewConversationDraft,
  appendEpicFileToNewConversationDraft,
} from "../append-epic-file-to-draft";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

const EPIC_ID = "epic-1";
const PATH = "files/screenshots/2026-09-10T14-35-51-619Z-9cb544e8.png";

function draftNodes(): ReadonlyArray<JsonContent> {
  return (
    useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
      ?.content?.content ?? []
  );
}

function flatText(nodes: ReadonlyArray<JsonContent>): string {
  return nodes
    .flatMap((node) => node.content ?? [])
    .map((child) => child.text ?? "")
    .join("");
}

beforeEach(() => {
  useNewConversationModalStore.getState().clearDraft(EPIC_ID);
});

describe("appendEpicFileToNewConversationDraft", () => {
  it("seeds the bare path, with no markdown around it", () => {
    appendEpicFileToNewConversationDraft({ epicId: EPIC_ID, path: PATH });

    const nodes = draftNodes();
    expect(flatText(nodes)).toBe(PATH);
    // The two shapes the old seeder produced, both of which a user message
    // renders verbatim.
    expect(flatText(nodes)).not.toContain("![");
    expect(flatText(nodes)).not.toContain("](");
  });
});

describe("appendEpicFileImageToNewConversationDraft", () => {
  beforeEach(() => {
    appendEpicFileImageToNewConversationDraft({
      epicId: EPIC_ID,
      path: PATH,
      mediaType: "image/png",
      b64content: "aGVsbG8=",
      byteLength: 5,
    });
  });

  it("adds the composer's own image node, carrying the bytes inline", () => {
    const image = draftNodes()
      .flatMap((node) => node.content ?? [])
      .find((child) => child.type === "imageAttachment");
    expect(image).toBeDefined();
    // `b64content` is the paste path's payload shape - the host ingests and
    // hashes it at send time - so this is indistinguishable downstream from an
    // image the user dropped in.
    expect(image?.attrs).toMatchObject({
      mimeType: "image/png",
      b64content: "aGVsbG8=",
      size: 5,
    });
  });

  it("keeps the path as text as well, so the agent can read the original", () => {
    expect(flatText(draftNodes())).toContain(PATH);
  });
});
