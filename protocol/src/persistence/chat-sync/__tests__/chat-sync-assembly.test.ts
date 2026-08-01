import {
  assembleChat,
  type ChatAssemblyResult,
  type ChatPartFetcher,
  type ChatPartRequest,
  type StagedChatPart,
} from "@traycer/protocol/persistence/chat-sync/assembly";
import {
  CHAT_SYNC_READER_VERSION,
  listChatHeadParts,
  type ChatHeadRecord,
} from "@traycer/protocol/persistence/chat-sync/head";
import { describe, expect, it } from "vitest";
import {
  CHAT_ID,
  eventShard,
  messageShard,
  publishChat,
  publishShard,
  stageFromText,
  unknownMessage,
  userMessage,
  type PublishedChat,
} from "./__fixtures__/published-chat";

/**
 * Assembly: gate, fetch in parallel, verify each part, assemble in HEAD order.
 *
 * The two properties this suite exists for are the two the layout actually
 * rests on - the transcript is the head's list, not the network's completion
 * order; and a part that does not hash to the address the head named ends the
 * read rather than being skipped, retried or rendered as a gap.
 */

const READER = CHAT_SYNC_READER_VERSION;

/** Every permutation of `0..n-1`, for a small n. */
function permutations(count: number): number[][] {
  if (count === 0) return [[]];
  const result: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    const rest = [...Array(count).keys()].filter((entry) => entry !== index);
    for (const tail of permutations(count - 1)) {
      result.push([index, ...tail.map((position) => rest[position])]);
    }
  }
  return result;
}

/**
 * Serves the published parts, but settles them in `order` (indices into the
 * head's own part list) rather than in call order.
 *
 * Every fetch is held until all of them have been STARTED - so the caller
 * really is fetching in parallel - and then released one at a time in `order`.
 * `completed` records what actually happened, so a test can assert the harness
 * did reorder anything at all rather than trusting that it did.
 */
function fetchInCompletionOrder(
  published: PublishedChat,
  order: readonly number[],
): { readonly fetch: ChatPartFetcher; readonly completed: number[] } {
  const parts = listChatHeadParts(published.head);
  const completed: number[] = [];

  // One gate per part. Gate `order[0]` opens immediately; each later gate opens
  // when its predecessor has completed, which forces a strict settle order.
  const releases: (() => void)[] = parts.map(() => () => {});
  const gates = parts.map(
    (_part, index) =>
      new Promise<void>((resolve) => {
        releases[index] = resolve;
      }),
  );

  let started = 0;
  const startedReleases: (() => void)[] = [];

  const fetch: ChatPartFetcher = async (
    request: ChatPartRequest,
  ): Promise<StagedChatPart> => {
    const index = parts.findIndex((part) => part.sha256 === request.part.sha256);
    if (index < 0) throw new Error("missing part");

    started += 1;
    const allStarted = new Promise<void>((resolve) => {
      startedReleases.push(resolve);
      if (started === parts.length) {
        for (const release of startedReleases) release();
        releases[order[0]]();
      }
    });
    await allStarted;
    await gates[index];

    completed.push(index);
    const next = order.indexOf(index) + 1;
    if (next < order.length) releases[order[next]]();

    const bytes = published.bytesByPart.get(request.part.sha256);
    if (bytes === undefined) throw new Error("missing part");
    return stageFromText(bytes);
  };

  return { fetch, completed };
}

function assemble(
  published: PublishedChat,
  fetch: ChatPartFetcher,
): Promise<ChatAssemblyResult> {
  return assembleChat({ head: published.head, readerSupports: READER, fetch });
}

describe("chat assembly", () => {
  it("assembles a chat whose sections are inline", async () => {
    const published = publishChat({
      graduate: { events: false, hostPrivate: false },
      parentHeadSha256: null,
    });

    const result = await assemble(published, published.fetch);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.chat.messages.map((message) => message.variant)).toEqual([
      "user",
      "assistant",
      "telemetry",
    ]);
    expect(result.chat.events.map((event) => event.variant)).toEqual([
      "turn.started",
      "warp.engaged",
    ]);
    expect(result.chat.hostPrivate.revision).toBe(3);
    expect(result.chat.core.chatId).toBe(CHAT_ID);
    expect(result.chat.throughRecordSeq).toBe(42);
  });

  it("assembles a chat whose sections have graduated to parts, identically", async () => {
    const inline = publishChat({
      graduate: { events: false, hostPrivate: false },
      parentHeadSha256: null,
    });
    const graduated = publishChat({
      graduate: { events: true, hostPrivate: true },
      parentHeadSha256: null,
    });

    const [a, b] = await Promise.all([
      assemble(inline, inline.fetch),
      assemble(graduated, graduated.fetch),
    ]);
    if (a.status !== "ok" || b.status !== "ok") {
      throw new Error("expected both layouts to assemble");
    }

    // Nothing downstream of assembly can tell the layouts apart, which is the
    // point of letting a section graduate at all.
    expect(b.chat.messages).toEqual(a.chat.messages);
    expect(b.chat.events).toEqual(a.chat.events);
    expect(b.chat.hostPrivate).toEqual(a.chat.hostPrivate);
  });

  it("carries the head's lineage onto the assembled chat", async () => {
    const parent = "e".repeat(64);
    const published = publishChat({
      graduate: { events: false, hostPrivate: false },
      parentHeadSha256: parent,
    });

    const result = await assemble(published, published.fetch);
    if (result.status !== "ok") throw new Error("expected an assembled chat");
    expect(result.chat.parentHeadSha256).toBe(parent);
  });
});

/**
 * The property the layout rests on: parts are fetched concurrently, and the
 * transcript is the HEAD's list. Completion order is a network accident.
 */
describe("chat assembly is ordered by the head, not by the fetch", () => {
  const published = publishChat({
    graduate: { events: true, hostPrivate: true },
    parentHeadSha256: null,
  });

  it("produces the same chat for every completion order", async () => {
    const parts = listChatHeadParts(published.head);
    // 5 parts: 2 message cohorts, 2 event cohorts, 1 host-private.
    expect(parts).toHaveLength(5);

    const expected = await assemble(published, published.fetch);
    if (expected.status !== "ok") throw new Error("expected a baseline chat");

    for (const order of permutations(parts.length)) {
      const harness = fetchInCompletionOrder(published, order);
      const result = await assemble(published, harness.fetch);
      if (result.status !== "ok") {
        throw new Error(`order ${order.join(",")} failed to assemble`);
      }
      // Non-vacuity: assert the harness really did settle the parts out of head
      // order, so a permutation that quietly degraded to "in order" cannot pass
      // this test while guarding nothing.
      expect(harness.completed).toEqual([...order]);
      expect(result.chat).toEqual(expected.chat);
      // Stated absolutely as well as relatively: "every order agrees" is also
      // satisfiable by a reader that assembles the same WRONG transcript every
      // time, so pin what the head actually says.
      expect(result.chat.messages.map((message) => message.variant)).toEqual([
        "user",
        "assistant",
        "telemetry",
      ]);
      expect(result.chat.events.map((event) => event.variant)).toEqual([
        "turn.started",
        "warp.engaged",
      ]);
    }
  });

  it("fetches every part concurrently rather than one at a time", async () => {
    let inFlight = 0;
    let peak = 0;

    const result = await assemble(published, async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      const bytes = published.bytesByPart.get(request.part.sha256);
      if (bytes === undefined) throw new Error("missing part");
      inFlight -= 1;
      return stageFromText(bytes);
    });

    expect(result.status).toBe("ok");
    expect(peak).toBe(listChatHeadParts(published.head).length);
  });

  it("concatenates message cohorts in head order even when the head reorders them", async () => {
    // The head is the only thing that says what the transcript IS, so swapping
    // the cohort order in the head must swap the transcript - not the fetch
    // order, and not the cohorts' own content.
    const [first, second] = published.head.messageShards;
    const swapped: ChatHeadRecord = {
      ...published.head,
      messageShards: [second, first],
    };

    const result = await assembleChat({
      head: swapped,
      readerSupports: READER,
      fetch: published.fetch,
    });
    if (result.status !== "ok") throw new Error("expected an assembled chat");

    expect(result.chat.messages.map((message) => message.variant)).toEqual([
      "telemetry",
      "user",
      "assistant",
    ]);
  });
});

describe("chat assembly fails closed", () => {
  const published = publishChat({
    graduate: { events: false, hostPrivate: false },
    parentHeadSha256: null,
  });

  /** Serves `replacement` for the part at `index`, and the truth otherwise. */
  function fetchWithTamperedPart(
    index: number,
    replacement: StagedChatPart,
  ): ChatPartFetcher {
    const parts = listChatHeadParts(published.head);
    return (request) => {
      if (request.part.sha256 === parts[index].sha256) {
        return Promise.resolve(replacement);
      }
      const bytes = published.bytesByPart.get(request.part.sha256);
      if (bytes === undefined) throw new Error("missing part");
      return Promise.resolve(stageFromText(bytes));
    };
  }

  it("refuses a part whose bytes hash to something else", async () => {
    // A chat assembled from a substituted part is not a degraded chat, it is a
    // different one - so it is not skipped, not rendered as a gap, not retried.
    const substituted = publishShard(messageShard([userMessage])).bytes;
    const staged = stageFromText(substituted);

    const result = await assemble(
      published,
      fetchWithTamperedPart(0, {
        ...staged,
        // Same length the head promised, wrong content: the length check must
        // not be what catches this.
        byteLength: published.head.messageShards[0].byteLength,
      }),
    );

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("digest-mismatch");
    // Renderer-safe: no object coordinates in the user-visible message.
    expect(result.message).not.toContain(staged.sha256);
    expect(result.diagnostic).toContain(staged.sha256);
  });

  it("refuses a truncated part", async () => {
    const bytes = published.bytesByPart.get(
      published.head.messageShards[0].sha256,
    );
    if (bytes === undefined) throw new Error("missing part");

    const result = await assemble(
      published,
      fetchWithTamperedPart(0, { ...stageFromText(bytes), byteLength: 3 }),
    );

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("byte-length-mismatch");
  });

  it("refuses a part that verifies but is not JSON", async () => {
    const junk = "not json at all";
    const staged = stageFromText(junk);
    const tampered: ChatHeadRecord = {
      ...published.head,
      messageShards: [
        { sha256: staged.sha256, byteLength: staged.byteLength },
        published.head.messageShards[1],
      ],
    };

    const result = await assembleChat({
      head: tampered,
      readerSupports: READER,
      fetch: (request) =>
        Promise.resolve(
          request.part.sha256 === staged.sha256
            ? staged
            : stageFromText(
                published.bytesByPart.get(request.part.sha256) ?? "",
              ),
        ),
    });

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("malformed-json");
  });

  it("refuses a part that belongs to another chat", async () => {
    // Content addressing proves the bytes are the ones the head named; this
    // proves they MEAN what the head assumed.
    const foreign = publishShard({
      schemaVersion: { major: 1, minor: 0 },
      chatId: "chat-somewhere-else",
      section: "messages",
      messages: [unknownMessage],
      events: [],
      hostPrivate: null,
    });
    const tampered: ChatHeadRecord = {
      ...published.head,
      messageShards: [foreign.part, published.head.messageShards[1]],
    };

    const result = await assembleChat({
      head: tampered,
      readerSupports: READER,
      fetch: () => Promise.resolve(stageFromText(foreign.bytes)),
    });

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("head-mismatch");
    expect(result.diagnostic).toContain("chat-somewhere-else");
  });

  it("refuses a part filed under the wrong section", async () => {
    const events = publishShard(eventShard([]));
    const tampered: ChatHeadRecord = {
      ...published.head,
      messageShards: [events.part],
    };

    const result = await assembleChat({
      head: tampered,
      readerSupports: READER,
      fetch: () => Promise.resolve(stageFromText(events.bytes)),
    });

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("head-mismatch");
  });

  it("reports the first failure in HEAD order, whichever part lost the race", async () => {
    // Two bad parts, settling in the opposite order: the caller must still see
    // one deterministic error.
    const tampered: ChatHeadRecord = {
      ...published.head,
      messageShards: published.head.messageShards.map((part) => ({
        ...part,
        byteLength: part.byteLength + 1,
      })),
    };

    const result = await assembleChat({
      head: tampered,
      readerSupports: READER,
      fetch: async (request) => {
        const bytes = published.bytesByPart.get(request.part.sha256);
        if (bytes === undefined) throw new Error("missing part");
        if (request.index === 0) await Promise.resolve();
        return stageFromText(bytes);
      },
    });

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.diagnostic).toContain("messages part 0");
  });

  it("propagates a transport error rather than flattening it into a corruption", async () => {
    // "The cloud is unreachable" and "the cloud handed us the wrong bytes" are
    // different conditions, and a caller retries only one of them.
    const transport = new Error("socket hang up");

    await expect(
      assemble(published, () => Promise.reject(transport)),
    ).rejects.toBe(transport);
  });
});

describe("chat assembly gates before it fetches", () => {
  const published = publishChat({
    graduate: { events: true, hostPrivate: true },
    parentHeadSha256: null,
  });

  it("spends no part egress on a publication it may not read", async () => {
    // Structural, not by discipline: the fetch port is a callback this module
    // invokes, so on a refusal there is no call to forget to skip.
    let fetches = 0;
    const counting: ChatPartFetcher = (request) => {
      fetches += 1;
      return published.fetch(request);
    };

    const result = await assembleChat({
      head: published.head,
      readerSupports: { major: 2, minor: 0 },
      fetch: counting,
    });

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toBe("unsupported-major");
    expect(fetches).toBe(0);
  });

  it("refuses a reader below the head's stated minimum, before fetching", async () => {
    let fetches = 0;
    const head: ChatHeadRecord = {
      ...published.head,
      schemaVersion: { major: 1, minor: 4 },
      minReaderVersion: { major: 1, minor: 3 },
    };

    const result = await assembleChat({
      head,
      readerSupports: { major: 1, minor: 0 },
      fetch: (request) => {
        fetches += 1;
        return published.fetch(request);
      },
    });

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toBe("reader-below-minimum");
    expect(fetches).toBe(0);
  });
});
