import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  BotAppearance,
  BotReadPictureRequest,
} from "@traycer/protocol/host/bot/schemas";
import {
  pictureHashOf,
  useBotPictureLink,
  useBotPictureLoads,
} from "@/hooks/bots/use-bot-picture";
import {
  botPictureLink,
  clearBotPictures,
  nextWantedBotPicture,
} from "@/lib/bots/bot-picture-cache";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HomeBotsGroup, HomeBotsModel } from "@/lib/home-bots/bots-model";
import { deliveredLook } from "@/components/bots/__tests__/mascot-drawing";
import { tracyRecord } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";

/** The props each loader harness is rendered and re-rendered with. */
type LoaderClient = Parameters<typeof useBotPictureLoads>[0];
interface ModelProps {
  readonly model: HomeBotsModel | null;
}
interface ListingProps {
  readonly listing: HomeBotsModel | null;
}
interface ReadyProps {
  readonly ready: boolean;
}
interface ReadyListingProps {
  readonly ready: boolean;
  readonly listing: HomeBotsModel | null;
}
interface ClientProps {
  readonly client: LoaderClient;
}
interface SupportedProps {
  readonly supported: boolean;
}

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const THIRD = "c".repeat(64);
const PICTURE_BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND_PICTURE_BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const MASCOT_BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";

function pictureLook(sha256: string): BotAppearance {
  return {
    mark: { kind: "picture", sha256, mascotShape: null },
    color: null,
    eyewear: null,
    accessory: null,
  };
}

const MASCOT_LOOK: BotAppearance = {
  mark: { kind: "mascot", shape: "cat" },
  color: null,
  eyewear: null,
  accessory: null,
};

function modelOf(
  ...bots: ReadonlyArray<readonly [string, string, BotAppearance | null]>
): HomeBotsModel {
  const groups: HomeBotsGroup[] = bots.map(([botId, environmentId, look]) => ({
    environmentId,
    label: environmentId,
    ownerKind: "user",
    canCreate: true,
    bots: [
      look === null
        ? tracyRecord(botId, environmentId)
        : { ...tracyRecord(botId, environmentId), appearance: look },
    ],
    mainBotId: null,
  }));
  return { groups, botCount: bots.length };
}

interface HeldRead {
  readonly request: BotReadPictureRequest;
  /** The host answers with the picture. */
  readonly answer: () => void;
  /** The host answers that the bot no longer wears it. */
  readonly answerNone: () => void;
  /** The host fails the read with an error of its own. */
  readonly fail: (error: Error) => void;
}

/** A real HostClient whose host holds every `bot.readPicture` until the test answers or fails it. */
function pictureHost() {
  const reads: HeldRead[] = [];
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "bot.readPicture": (params) =>
          new Promise((resolve, reject) => {
            reads.push({
              request: params,
              answer: () =>
                resolve({
                  picture: { mediaType: "image/png", bytesBase64: "AAAA" },
                }),
              answerNone: () => resolve({ picture: null }),
              fail: reject,
            });
          }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return { reads, client: spine.createRequester(mockLocalHostEntry) };
}

/** A host's own failure of a read, as the messenger reports one. */
function hostFailure(code: "RPC_ERROR" | "FORBIDDEN"): Error {
  return new HostRpcError({
    code,
    message: "the read failed",
    requestId: "req-1",
    method: "bot.readPicture",
    fatalDetails: null,
  });
}

let queryClient = new QueryClient();

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

/** Draws the picture of `look` as `botId`, which is what asks for it to be read. */
function drawn(botId: string, look: BotAppearance) {
  return renderHook(() => useBotPictureLink(botId, look), { wrapper });
}

/** The cached `bot.readPicture` queries, whichever host and request they are keyed by. */
function readQueries() {
  return queryClient.getQueryCache().findAll({
    predicate: (query) => query.queryKey.includes("bot.readPicture"),
  });
}

/** How many `bot.readPicture` requests are in flight right now. */
function readsInFlight(): number {
  return queryClient.isFetching({
    predicate: (query) => query.queryKey.includes("bot.readPicture"),
  });
}

/**
 * Asserts no read is in flight and none is about to be: every read query the
 * hooks made is idle. The hooks' effects have run by the time a render
 * returns, so a read they meant to issue would be fetching by now.
 */
function expectNoRequestInFlight(): void {
  expect(readsInFlight()).toBe(0);
  for (const query of readQueries())
    expect(query.state.fetchStatus).toBe("idle");
}

/** Waits for the loader to have taken in a settled read: nothing is wanted that it still has to read. */
async function settled(): Promise<void> {
  await waitFor(() => {
    expect(nextWantedBotPicture()).toBeNull();
  });
}

let createLink = vi.spyOn(URL, "createObjectURL");
let revokeLink = vi.spyOn(URL, "revokeObjectURL");

beforeEach(() => {
  queryClient = new QueryClient();
  let made = 0;
  createLink = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:picture-${String((made += 1))}`);
  revokeLink = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  clearBotPictures();
  vi.restoreAllMocks();
});

describe("the hash of the picture a look wears", () => {
  it("is the hash of a picture mark, and nothing for any other look", () => {
    expect(pictureHashOf(pictureLook(HASH))).toBe(HASH);
    expect(pictureHashOf(MASCOT_LOOK)).toBeNull();
    expect(pictureHashOf(null)).toBeNull();
    expect(
      pictureHashOf({ ...MASCOT_LOOK, mark: { kind: "unrecognised" } }),
    ).toBeNull();
  });

  it.each([
    [
      "a bad hash",
      '{"mark":{"kind":"picture","sha256":"xyz","mascotShape":null}}',
    ],
    [
      "an uppercase hash",
      `{"mark":{"kind":"picture","sha256":"${"A".repeat(64)}"}}`,
    ],
    ["a hash that is not a string", '{"mark":{"kind":"picture","sha256":7}}'],
    ["no hash", '{"mark":{"kind":"picture"}}'],
    ["a mark that is not an object", '{"mark":"picture"}'],
    ["a kind it does not know", `{"mark":{"kind":"video","sha256":"${HASH}"}}`],
  ])("is nothing for a delivered look with %s", (_name, json) => {
    expect(pictureHashOf(deliveredLook(json))).toBeNull();
  });

  it("is the hash of a delivered picture mark that carries no kept shape, as an older writer sent it", () => {
    expect(
      pictureHashOf(
        deliveredLook(`{"mark":{"kind":"picture","sha256":"${HASH}"}}`),
      ),
    ).toBe(HASH);
  });
});

describe("reading the pictures that drawn bots want", () => {
  it("reads nothing until a drawn picture wants one, though the directory lists picture bots, and then reads it as the bot that wears it", async () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    expect(host.reads).toEqual([]);
    expectNoRequestInFlight();

    drawn(PICTURE_BOT, pictureLook(HASH));

    await waitFor(() => {
      expect(host.reads.map((read) => read.request)).toEqual([
        { botId: PICTURE_BOT, sha256: HASH },
      ]);
    });
  });

  it("holds the link of an answered read, and reads a hash no more once it is held", async () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    const { result } = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });

    host.reads[0].answer();

    await waitFor(() => {
      expect(result.current).toBe("blob:picture-1");
    });
    drawn(SECOND_PICTURE_BOT, pictureLook(HASH));
    expect(host.reads).toHaveLength(1);
    expectNoRequestInFlight();
  });

  it("issues one read at a time: the second is not asked until the first has settled", async () => {
    const host = pictureHost();
    const model = modelOf(
      [PICTURE_BOT, "env-1", pictureLook(HASH)],
      [SECOND_PICTURE_BOT, "env-2", pictureLook(OTHER)],
    );
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    drawn(SECOND_PICTURE_BOT, pictureLook(OTHER));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    expect(readsInFlight()).toBe(1);
    expect(host.reads).toHaveLength(1);

    host.reads[0].answer();

    await waitFor(() => {
      expect(host.reads.map((read) => read.request.sha256)).toEqual([
        HASH,
        OTHER,
      ]);
    });
  });

  it("tries each hash once: a failed read is not retried when another picture is wanted, though that one is read", async () => {
    const host = pictureHost();
    const model = modelOf(
      [PICTURE_BOT, "env-1", pictureLook(HASH)],
      [SECOND_PICTURE_BOT, "env-2", pictureLook(OTHER)],
    );
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].fail(hostFailure("RPC_ERROR"));
    await settled();

    drawn(SECOND_PICTURE_BOT, pictureLook(OTHER));
    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    host.reads[1].fail(hostFailure("RPC_ERROR"));
    await settled();
    drawn(PICTURE_BOT, pictureLook(HASH));

    expectNoRequestInFlight();
    expect(host.reads.map((read) => read.request.sha256)).toEqual([
      HASH,
      OTHER,
    ]);
  });

  it("reads a picture again when it is drawn again after its link was dropped with its last drawer", async () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", MASCOT_LOOK]);
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    const first = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answer();
    await waitFor(() => {
      expect(first.result.current).toBe("blob:picture-1");
    });
    first.unmount();
    expect(botPictureLink(HASH)).toBeNull();

    const second = drawn(PICTURE_BOT, pictureLook(HASH));

    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    host.reads[1].answer();
    await waitFor(() => {
      expect(second.result.current).toBe("blob:picture-2");
    });
  });

  it("reads a picture through the other bot drawing it as soon as the read through the first found none, with no withdrawal, and stops when that finds none too", async () => {
    const host = pictureHost();
    const lists = (): HomeBotsModel =>
      modelOf(
        [PICTURE_BOT, "env-1", pictureLook(HASH)],
        [SECOND_PICTURE_BOT, "env-2", pictureLook(HASH)],
      );
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper, initialProps: { model: lists() } },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    drawn(SECOND_PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    expect(host.reads[0].request.botId).toBe(PICTURE_BOT);
    host.reads[0].answerNone();
    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    expect(host.reads[1].request).toEqual({
      botId: SECOND_PICTURE_BOT,
      sha256: HASH,
    });
    host.reads[1].answerNone();
    await settled();

    rerender({ model: lists() });
    rerender({ model: lists() });

    await waitFor(() => {
      expect(readsInFlight()).toBe(0);
    });
    expectNoRequestInFlight();
    expect(host.reads).toHaveLength(2);
  });

  it("reads a picture through the bot that stays when the bot it was read through leaves the picture and its drawer leaves, and holds the answer", async () => {
    const host = pictureHost();
    const lists = (first: BotAppearance): HomeBotsModel =>
      modelOf(
        [PICTURE_BOT, "env-1", first],
        [SECOND_PICTURE_BOT, "env-2", pictureLook(HASH)],
      );
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper, initialProps: { model: lists(pictureLook(HASH)) } },
    );
    const leaving = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    expect(host.reads[0].request.botId).toBe(PICTURE_BOT);
    host.reads[0].answerNone();
    await settled();

    rerender({ model: lists(MASCOT_LOOK) });
    leaving.unmount();
    const staying = drawn(SECOND_PICTURE_BOT, pictureLook(HASH));

    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    expect(host.reads[1].request).toEqual({
      botId: SECOND_PICTURE_BOT,
      sha256: HASH,
    });
    host.reads[1].answer();
    await waitFor(() => {
      expect(staying.result.current).toBe("blob:picture-1");
    });
  });

  it("reads a picture through a bot that starts to draw it after the read through the only bot drawing it found none", async () => {
    const host = pictureHost();
    const model = modelOf(
      [PICTURE_BOT, "env-1", pictureLook(HASH)],
      [SECOND_PICTURE_BOT, "env-2", pictureLook(HASH)],
    );
    renderHook<void, ModelProps>(
      ({ model: listed }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, listed);
      },
      { wrapper, initialProps: { model } },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answerNone();
    await settled();
    expectNoRequestInFlight();

    drawn(SECOND_PICTURE_BOT, pictureLook(HASH));

    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    expect(host.reads[1].request.botId).toBe(SECOND_PICTURE_BOT);
  });

  it("reads a picture again in the same round when a member sets another picture and then sets it back, though the first read found none", async () => {
    const host = pictureHost();
    const lists = (sha256: string) =>
      modelOf([PICTURE_BOT, "env-1", pictureLook(sha256)]);
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper, initialProps: { model: lists(HASH) } },
    );
    const drawer = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    rerender({ model: lists(OTHER) });
    host.reads[0].answerNone();
    await settled();
    expectNoRequestInFlight();

    rerender({ model: lists(HASH) });

    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    expect(host.reads[1].request.sha256).toBe(HASH);
    host.reads[1].answer();
    await waitFor(() => {
      expect(drawer.result.current).toBe("blob:picture-1");
    });
  });

  it("reads a picture again in the same round when the bot that draws it wears it again, though another listed bot kept wearing it", async () => {
    const host = pictureHost();
    const lists = (first: BotAppearance): HomeBotsModel =>
      modelOf(
        [PICTURE_BOT, "env-1", first],
        [SECOND_PICTURE_BOT, "env-2", pictureLook(HASH)],
      );
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      {
        wrapper,
        initialProps: {
          model: lists(pictureLook(HASH)),
        },
      },
    );
    const drawer = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    expect(host.reads[0].request.botId).toBe(PICTURE_BOT);
    rerender({ model: lists(MASCOT_LOOK) });
    host.reads[0].answerNone();
    await settled();
    drawer.unmount();

    rerender({ model: lists(pictureLook(HASH)) });
    const again = drawn(PICTURE_BOT, pictureLook(HASH));

    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    expect(host.reads[1].request).toEqual({ botId: PICTURE_BOT, sha256: HASH });
    host.reads[1].answer();
    await waitFor(() => {
      expect(again.result.current).toBe("blob:picture-1");
    });
  });

  it("does not read a picture again when a none answer is followed by a refetched listing of new objects showing the same bots wearing the same pictures", async () => {
    const host = pictureHost();
    const lists = (): HomeBotsModel =>
      modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper, initialProps: { model: lists() } },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answerNone();
    await settled();

    rerender({ model: lists() });
    rerender({ model: lists() });

    await waitFor(() => {
      expect(readsInFlight()).toBe(0);
    });
    expectNoRequestInFlight();
    expect(host.reads).toHaveLength(1);
  });

  it("keeps the pairs it last saw across a render with no listing yet, so the same listing afterwards clears nothing", async () => {
    const host = pictureHost();
    const lists = (): HomeBotsModel =>
      modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    const listed: { readonly model: HomeBotsModel | null } = {
      model: lists(),
    };
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper, initialProps: listed },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answerNone();
    await settled();

    rerender({ model: null });
    rerender({ model: lists() });

    await waitFor(() => {
      expect(readsInFlight()).toBe(0);
    });
    expectNoRequestInFlight();
    expect(host.reads).toHaveLength(1);
  });

  it("does not read a picture again when a none answer is followed by a listing that still names it", async () => {
    const host = pictureHost();
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      {
        wrapper,
        initialProps: {
          model: modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]),
        },
      },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answerNone();
    await settled();

    rerender({ model: modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]) });

    expectNoRequestInFlight();
    expect(host.reads).toHaveLength(1);
  });

  describe("when the host comes back", () => {
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);

    it("reads a failed picture again exactly once when the host turns ready after not being, holds it, and sends nothing more while it stays ready", async () => {
      const host = pictureHost();
      const { rerender } = renderHook<void, ReadyListingProps>(
        ({ ready, listing }: ReadyListingProps) => {
          useBotPictureLoads(host.client, true, ready, listing);
        },
        { wrapper, initialProps: { ready: true, listing: model } },
      );
      const drawer = drawn(PICTURE_BOT, pictureLook(HASH));
      await waitFor(() => {
        expect(host.reads).toHaveLength(1);
      });
      host.reads[0].fail(hostFailure("RPC_ERROR"));
      await settled();

      rerender({ ready: false, listing: model });
      expectNoRequestInFlight();
      expect(host.reads).toHaveLength(1);
      rerender({ ready: true, listing: model });

      await waitFor(() => {
        expect(host.reads).toHaveLength(2);
      });
      host.reads[1].answer();
      await waitFor(() => {
        expect(drawer.result.current).toBe("blob:picture-1");
      });
      rerender({
        ready: true,
        listing: modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]),
      });
      expectNoRequestInFlight();
      expect(host.reads).toHaveLength(2);
    });

    it("stays in one round while it stays ready across re-renders and changed listings, so a tried hash is not read again", async () => {
      const host = pictureHost();
      const { rerender } = renderHook<void, ListingProps>(
        ({ listing }: ListingProps) => {
          useBotPictureLoads(host.client, true, true, listing);
        },
        { wrapper, initialProps: { listing: model } },
      );
      drawn(PICTURE_BOT, pictureLook(HASH));
      await waitFor(() => {
        expect(host.reads).toHaveLength(1);
      });
      host.reads[0].fail(hostFailure("RPC_ERROR"));
      await settled();

      for (let i = 0; i < 3; i += 1) {
        rerender({
          listing: modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]),
        });
      }

      expectNoRequestInFlight();
      expect(host.reads).toHaveLength(1);
      expect(nextWantedBotPicture()).toBeNull();
    });

    it("sends nothing new for a tried hash when the host only turns unready", async () => {
      const host = pictureHost();
      const { rerender } = renderHook<void, ReadyProps>(
        ({ ready }: ReadyProps) => {
          useBotPictureLoads(host.client, true, ready, model);
        },
        { wrapper, initialProps: { ready: true } },
      );
      drawn(PICTURE_BOT, pictureLook(HASH));
      await waitFor(() => {
        expect(host.reads).toHaveLength(1);
      });
      host.reads[0].fail(hostFailure("RPC_ERROR"));
      await settled();

      rerender({ ready: false });

      expectNoRequestInFlight();
      expect(host.reads).toHaveLength(1);
      expect(nextWantedBotPicture()).toBeNull();
    });

    it("asks once for a picture already wanted when the loader mounts, and holds its answer", async () => {
      const host = pictureHost();
      const wanting = drawn(PICTURE_BOT, pictureLook(HASH));

      renderHook(
        () => {
          useBotPictureLoads(host.client, true, true, model);
        },
        { wrapper },
      );

      await waitFor(() => {
        expect(host.reads).toHaveLength(1);
      });
      host.reads[0].answer();
      await waitFor(() => {
        expect(wanting.result.current).toBe("blob:picture-1");
      });
      expectNoRequestInFlight();
      expect(host.reads).toHaveLength(1);
    });

    it.each([true, false])(
      "starts no round at mount, whether the host is ready (%s) or not",
      (ready) => {
        const host = pictureHost();
        drawn(PICTURE_BOT, pictureLook(HASH));
        const before = nextWantedBotPicture()?.round;

        renderHook(
          () => {
            useBotPictureLoads(host.client, true, ready, model);
          },
          { wrapper },
        );

        expect(nextWantedBotPicture()?.round).toBe(before);
      },
    );
  });

  describe("when the loader unmounts", () => {
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);

    it("starts a round, so a hash tried under the old loader is offered to a newly mounted one", async () => {
      const host = pictureHost();
      const old = renderHook(
        () => {
          useBotPictureLoads(host.client, true, true, model);
        },
        { wrapper },
      );
      const drawer = drawn(PICTURE_BOT, pictureLook(HASH));
      await waitFor(() => {
        expect(host.reads).toHaveLength(1);
      });
      host.reads[0].fail(hostFailure("RPC_ERROR"));
      await settled();

      old.unmount();
      renderHook(
        () => {
          useBotPictureLoads(host.client, true, true, model);
        },
        { wrapper },
      );

      await waitFor(() => {
        expect(host.reads).toHaveLength(2);
      });
      host.reads[1].answer();
      await waitFor(() => {
        expect(drawer.result.current).toBe("blob:picture-1");
      });
    });

    it("holds nothing from a read still out at unmount when it settles, and the new loader's own read is the one held", async () => {
      const host = pictureHost();
      const old = renderHook(
        () => {
          useBotPictureLoads(host.client, true, true, model);
        },
        { wrapper },
      );
      const drawer = drawn(PICTURE_BOT, pictureLook(HASH));
      await waitFor(() => {
        expect(host.reads).toHaveLength(1);
      });

      old.unmount();
      renderHook(
        () => {
          useBotPictureLoads(host.client, true, true, model);
        },
        { wrapper },
      );
      await waitFor(() => {
        expect(host.reads).toHaveLength(2);
      });
      host.reads[0].answer();
      await waitFor(() => {
        expect(readsInFlight()).toBe(1);
      });

      expect(drawer.result.current).toBeNull();
      expect(createLink).not.toHaveBeenCalled();
      host.reads[1].answer();
      await waitFor(() => {
        expect(drawer.result.current).toBe("blob:picture-1");
      });
      expect(createLink).toHaveBeenCalledTimes(1);
    });
  });

  it("tries a failed hash again for a new client", async () => {
    const first = pictureHost();
    const second = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    const { rerender } = renderHook<void, ClientProps>(
      ({ client }: ClientProps) => {
        useBotPictureLoads(client, true, true, model);
      },
      { wrapper, initialProps: { client: first.client } },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(first.reads).toHaveLength(1);
    });
    first.reads[0].fail(hostFailure("RPC_ERROR"));
    await settled();

    rerender({ client: second.client });

    await waitFor(() => {
      expect(second.reads.map((read) => read.request.sha256)).toEqual([HASH]);
    });
    expect(first.reads).toHaveLength(1);
  });

  it("tries a failed hash again once the host is found to support the method, and never asks while it does not", async () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    const { rerender } = renderHook<void, SupportedProps>(
      ({ supported }: SupportedProps) => {
        useBotPictureLoads(host.client, supported, true, model);
      },
      { wrapper, initialProps: { supported: true } },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].fail(hostFailure("RPC_ERROR"));
    await settled();

    rerender({ supported: false });
    expectNoRequestInFlight();
    expect(host.reads).toHaveLength(1);
    rerender({ supported: true });

    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
  });

  it("asks for nothing when the host does not support the method, and not with no client", () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);

    renderHook(
      () => {
        useBotPictureLoads(host.client, false, true, model);
        useBotPictureLoads(null, true, true, model);
      },
      { wrapper },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));

    expect(host.reads).toEqual([]);
    expectNoRequestInFlight();
    expect(nextWantedBotPicture()?.sha256).toBe(HASH);
  });

  it("makes one request for a failed read and no retry of it, whatever the query client's default", async () => {
    const host = pictureHost();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 3, retryDelay: 1 } },
    });
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });

    host.reads[0].fail(hostFailure("RPC_ERROR"));
    await settled();

    expectNoRequestInFlight();
    expect(host.reads).toHaveLength(1);
  });

  describe("when the client changes mid-read", () => {
    /** A read begun through the first client, which the second then replaces. */
    async function replacedMidRead() {
      const first = pictureHost();
      const second = pictureHost();
      const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
      const { rerender } = renderHook<void, ClientProps>(
        ({ client }: ClientProps) => {
          useBotPictureLoads(client, true, true, model);
        },
        { wrapper, initialProps: { client: first.client } },
      );
      const { result } = drawn(PICTURE_BOT, pictureLook(HASH));
      await waitFor(() => {
        expect(first.reads).toHaveLength(1);
      });

      rerender({ client: second.client });
      await waitFor(() => {
        expect(second.reads.map((read) => read.request)).toEqual([
          { botId: PICTURE_BOT, sha256: HASH },
        ]);
      });
      return { first, second, result };
    }

    it("has the new client ask for the hash itself, and holds its answer, though the old client's read never settles", async () => {
      const { first, second, result } = await replacedMidRead();

      second.reads[0].answer();

      await waitFor(() => {
        expect(result.current).toBe("blob:picture-1");
      });
      expect(first.reads).toHaveLength(1);
      expect(createLink).toHaveBeenCalledTimes(1);
    });

    it("makes no link from the old client's answer when it arrives late, and marks nothing tried by it", async () => {
      const { first, second, result } = await replacedMidRead();

      first.reads[0].answer();
      await waitFor(() => {
        expect(readsInFlight()).toBe(1);
      });

      expect(result.current).toBeNull();
      expect(createLink).not.toHaveBeenCalled();
      expect(nextWantedBotPicture()?.sha256).toBe(HASH);
      second.reads[0].answer();
      await waitFor(() => {
        expect(result.current).toBe("blob:picture-1");
      });
      expect(createLink).toHaveBeenCalledTimes(1);
    });
  });

  it("holds no link for the answer of a read whose picture nothing wants any more by the time it arrives", async () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", MASCOT_LOOK]);
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    const want = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    want.unmount();

    host.reads[0].answer();
    await waitFor(() => {
      expect(readsInFlight()).toBe(0);
    });

    expect(botPictureLink(HASH)).toBeNull();
    expect(createLink).not.toHaveBeenCalled();
  });

  describe("a picture the bot no longer wears", () => {
    const listKey = [...hostQueryKeys.methodScope("host-1", "bot.list"), "all"];

    /** Reads one picture, ends it as `end` says, then reads a second so the first is known to be taken in. */
    async function readEndedWith(end: (read: HeldRead) => void) {
      const host = pictureHost();
      queryClient.setQueryData(listKey, { bots: [], mainBotIds: null });
      const model = modelOf(
        [PICTURE_BOT, "env-1", pictureLook(HASH)],
        [SECOND_PICTURE_BOT, "env-2", pictureLook(OTHER)],
      );
      renderHook(
        () => {
          useBotPictureLoads(host.client, true, true, model);
        },
        { wrapper },
      );
      drawn(PICTURE_BOT, pictureLook(HASH));
      await waitFor(() => {
        expect(host.reads).toHaveLength(1);
      });

      end(host.reads[0]);
      drawn(SECOND_PICTURE_BOT, pictureLook(OTHER));
      await waitFor(() => {
        expect(host.reads).toHaveLength(2);
      });
      host.reads[1].answer();
    }

    it("marks the cached bot lists stale for a none answer, and holds no link and no failure", async () => {
      await readEndedWith((read) => {
        read.answerNone();
      });

      expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
      expect(botPictureLink(HASH)).toBeNull();
    });

    it.each([
      ["a host failure", hostFailure("RPC_ERROR")],
      ["a refusal", hostFailure("FORBIDDEN")],
      ["a plain error", new Error("offline")],
    ])(
      "leaves the lists alone and holds nothing for %s",
      async (_name, error) => {
        await readEndedWith((read) => {
          read.fail(error);
        });

        expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
        expect(botPictureLink(HASH)).toBeNull();
      },
    );
  });

  it("drops the link of a picture when the directory lists no bot wearing it and nothing drawn wants it", async () => {
    const host = pictureHost();
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      {
        wrapper,
        initialProps: {
          model: modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]),
        },
      },
    );
    const want = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answer();
    await waitFor(() => {
      expect(botPictureLink(HASH)).not.toBeNull();
    });
    want.unmount();

    rerender({ model: modelOf([PICTURE_BOT, "env-1", MASCOT_LOOK]) });

    expect(botPictureLink(HASH)).toBeNull();
    expect(revokeLink).toHaveBeenCalledWith("blob:picture-1");
  });

  it("keeps a held picture nothing draws while the bots are not listed yet, and drops it once a listing no longer names it", async () => {
    const host = pictureHost();
    const listed: { readonly model: HomeBotsModel | null } = {
      model: modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]),
    };
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper, initialProps: listed },
    );
    const drawer = drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answer();
    await waitFor(() => {
      expect(botPictureLink(HASH)).not.toBeNull();
    });
    drawer.unmount();

    rerender({ model: null });
    expect(botPictureLink(HASH)).not.toBeNull();
    rerender({ model: modelOf([PICTURE_BOT, "env-1", MASCOT_LOOK]) });

    expect(botPictureLink(HASH)).toBeNull();
  });

  it("keeps the link of a picture a drawn bot still wants when the directory no longer lists a bot wearing it", async () => {
    const host = pictureHost();
    const { rerender } = renderHook<void, ModelProps>(
      ({ model }: ModelProps) => {
        useBotPictureLoads(host.client, true, true, model);
      },
      {
        wrapper,
        initialProps: {
          model: modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]),
        },
      },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].answer();
    await waitFor(() => {
      expect(botPictureLink(HASH)).not.toBeNull();
    });

    rerender({ model: modelOf([PICTURE_BOT, "env-1", MASCOT_LOOK]) });

    expect(botPictureLink(HASH)).not.toBeNull();
  });

  it("shares one link and one read between bots naming one hash, which rests on the cloud writing a picture mark only for an object stored under the bot's own key", async () => {
    const host = pictureHost();
    const model = modelOf(
      [PICTURE_BOT, "env-1", pictureLook(HASH)],
      [SECOND_PICTURE_BOT, "env-2", pictureLook(HASH)],
    );
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, true, model);
      },
      { wrapper },
    );
    const first = drawn(PICTURE_BOT, pictureLook(HASH));
    const second = drawn(SECOND_PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });

    host.reads[0].answer();

    await waitFor(() => {
      expect(first.result.current).not.toBeNull();
    });
    expect(second.result.current).toBe(first.result.current);
    expect(host.reads).toHaveLength(1);
    expect(createLink).toHaveBeenCalledTimes(1);
  });
});

describe("the link of the picture a look wears", () => {
  it("is null for a mascot look, no look, and a picture not yet read, and a mascot look wants nothing", () => {
    const { result } = renderHook(() => [
      useBotPictureLink(MASCOT_BOT, MASCOT_LOOK),
      useBotPictureLink(MASCOT_BOT, null),
      useBotPictureLink(PICTURE_BOT, pictureLook(THIRD)),
    ]);

    expect(result.current).toEqual([null, null, null]);
  });
});
