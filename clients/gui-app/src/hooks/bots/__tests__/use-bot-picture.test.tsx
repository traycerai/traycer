import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
import { botPictureLink, clearBotPictures } from "@/lib/bots/bot-picture-cache";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HomeBotsGroup, HomeBotsModel } from "@/lib/home-bots/bots-model";
import { deliveredLook } from "@/components/bots/__tests__/mascot-drawing";
import { tracyRecord } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";

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

/** Lets every settled promise run, without waiting on a clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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
        useBotPictureLoads(host.client, true, model);
      },
      { wrapper },
    );
    await flush();
    expect(host.reads).toEqual([]);

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
        useBotPictureLoads(host.client, true, model);
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
    await flush();
    expect(host.reads).toHaveLength(1);
  });

  it("issues one read at a time: the second is not asked until the first has settled", async () => {
    const host = pictureHost();
    const model = modelOf(
      [PICTURE_BOT, "env-1", pictureLook(HASH)],
      [SECOND_PICTURE_BOT, "env-2", pictureLook(OTHER)],
    );
    renderHook(
      () => {
        useBotPictureLoads(host.client, true, model);
      },
      { wrapper },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    drawn(SECOND_PICTURE_BOT, pictureLook(OTHER));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    await flush();
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
        useBotPictureLoads(host.client, true, model);
      },
      { wrapper },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].fail(hostFailure("RPC_ERROR"));
    await flush();

    drawn(SECOND_PICTURE_BOT, pictureLook(OTHER));
    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
    host.reads[1].fail(hostFailure("RPC_ERROR"));
    drawn(PICTURE_BOT, pictureLook(HASH));
    await flush();

    expect(host.reads.map((read) => read.request.sha256)).toEqual([
      HASH,
      OTHER,
    ]);
  });

  it("tries a failed hash again for a new client", async () => {
    const first = pictureHost();
    const second = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    const { rerender } = renderHook(
      ({ client }) => {
        useBotPictureLoads(client, true, model);
      },
      { wrapper, initialProps: { client: first.client } },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(first.reads).toHaveLength(1);
    });
    first.reads[0].fail(hostFailure("RPC_ERROR"));
    await flush();

    rerender({ client: second.client });

    await waitFor(() => {
      expect(second.reads.map((read) => read.request.sha256)).toEqual([HASH]);
    });
    expect(first.reads).toHaveLength(1);
  });

  it("tries a failed hash again once the host is found to support the method, and never asks while it does not", async () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);
    const { rerender } = renderHook(
      ({ supported }) => {
        useBotPictureLoads(host.client, supported, model);
      },
      { wrapper, initialProps: { supported: true } },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await waitFor(() => {
      expect(host.reads).toHaveLength(1);
    });
    host.reads[0].fail(hostFailure("RPC_ERROR"));
    await flush();

    rerender({ supported: false });
    await flush();
    expect(host.reads).toHaveLength(1);
    rerender({ supported: true });

    await waitFor(() => {
      expect(host.reads).toHaveLength(2);
    });
  });

  it("asks for nothing when the host does not support the method, and not with no client", async () => {
    const host = pictureHost();
    const model = modelOf([PICTURE_BOT, "env-1", pictureLook(HASH)]);

    renderHook(
      () => {
        useBotPictureLoads(host.client, false, model);
        useBotPictureLoads(null, true, model);
      },
      { wrapper },
    );
    drawn(PICTURE_BOT, pictureLook(HASH));
    await flush();

    expect(host.reads).toEqual([]);
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
          useBotPictureLoads(host.client, true, model);
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
    const { rerender } = renderHook(
      ({ model }) => {
        useBotPictureLoads(host.client, true, model);
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

  it("keeps the link of a picture a drawn bot still wants when the directory no longer lists a bot wearing it", async () => {
    const host = pictureHost();
    const { rerender } = renderHook(
      ({ model }) => {
        useBotPictureLoads(host.client, true, model);
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
        useBotPictureLoads(host.client, true, model);
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
