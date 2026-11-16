import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentTransport,
  EnvironmentTransportRequest,
} from "../../environment/environment-cloud";
import { fetchEnvironmentTransport } from "../../environment/environment-cloud";
import type {
  BotDeleteRequest,
  BotUpdateReplyModeRequest,
  BotUpdateRunSettingsRequest,
} from "@traycer/protocol/host/bot/schemas";
import {
  deleteBotViaHttp,
  updateBotReplyModeViaHttp,
  updateBotRunSettingsViaHttp,
} from "../bot-setup";

const BASE = "https://server.example.test";
const BEARER = "user-jwt";
const PROXY = "iap-jwt";
const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_SETTINGS: BotUpdateRunSettingsRequest = {
  botId: BOT_ID,
  harness: "claude",
  model: "model-x",
  effort: "high",
  profile: "profile-a",
};
const REPLY_MODE: BotUpdateReplyModeRequest = {
  botId: BOT_ID,
  replyMode: "direct",
};
const DELETE: BotDeleteRequest = { botId: BOT_ID };
const ROW = {
  botId: BOT_ID,
  harness: "claude",
  model: "model-x",
  effort: "high",
  profile: "profile-a",
  replyMode: "direct" as const,
};

function recorder(answer: {
  readonly status: number;
  readonly text: string | null;
}): {
  readonly transport: EnvironmentTransport;
  readonly requests: EnvironmentTransportRequest[];
} {
  const requests: EnvironmentTransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return answer;
    },
  };
}

function json(
  status: number,
  body: unknown,
): { readonly status: number; readonly text: string } {
  return { status, text: JSON.stringify(body) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bot setup HTTP writes", () => {
  it("sends exact run-settings and reply-mode payloads with normalized URLs and proxy auth", async () => {
    const run = recorder(json(200, { bot: ROW, other: "discard" }));
    const reply = recorder(json(200, { bot: ROW }));
    const extraRun = { ...RUN_SETTINGS, extra: "discard" };

    const runResult = await updateBotRunSettingsViaHttp(
      `${BASE}/`,
      BEARER,
      PROXY,
      run.transport,
      extraRun,
    );
    const replyResult = await updateBotReplyModeViaHttp(
      BASE,
      BEARER,
      null,
      reply.transport,
      REPLY_MODE,
    );

    expect(runResult).toEqual({ kind: "ok", bot: ROW });
    expect(replyResult).toEqual({ kind: "ok", bot: ROW });
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]).toMatchObject({
      url: `${BASE}/api/bots/update-run-settings`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "Proxy-Authorization": `Bearer ${PROXY}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: RUN_SETTINGS,
    });
    expect(run.requests[0].body).toEqual({
      botId: BOT_ID,
      harness: "claude",
      model: "model-x",
      effort: "high",
      profile: "profile-a",
    });
    expect(reply.requests[0]).toMatchObject({
      url: `${BASE}/api/bots/update-reply-mode`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: REPLY_MODE,
    });
    expect(reply.requests[0].headers["Proxy-Authorization"]).toBeUndefined();
  });

  it("sends one delete with only the bot id and keeps no notice data", async () => {
    const sent = recorder(
      json(200, {
        deleted: true,
        environmentId: "env-a",
        ownerDeletedNotices: [{ botId: BOT_ID, text: "notice" }],
      }),
    );

    await expect(
      deleteBotViaHttp(BASE, BEARER, null, sent.transport, DELETE),
    ).resolves.toEqual({
      kind: "ok",
      deleted: true,
    });
    expect(sent.requests).toHaveLength(1);
    expect(sent.requests[0].url).toBe(`${BASE}/api/bots/delete`);
    expect(sent.requests[0].body).toEqual({ botId: BOT_ID });
    expect(
      JSON.stringify(
        await deleteBotViaHttp(
          BASE,
          BEARER,
          null,
          recorder(json(200, { deleted: false })).transport,
          DELETE,
        ),
      ),
    ).not.toContain("notice");
  });

  it.each([
    { status: 401, text: null, kind: "unauthorized" },
    {
      status: 403,
      text: JSON.stringify({
        statusCode: 403,
        error: "Forbidden",
        code: "FORBIDDEN",
      }),
      kind: "refused",
    },
    {
      status: 404,
      text: JSON.stringify({
        statusCode: 404,
        error: "Not found",
        code: "NOT_FOUND",
      }),
      kind: "refused",
    },
    {
      status: 422,
      text: JSON.stringify({
        statusCode: 422,
        error: "Reply mode is unavailable",
        code: "E_BOT_REPLY_MODE_NOT_ALLOWED",
      }),
      kind: "refused",
    },
    { status: 302, text: "", kind: "unavailable" },
    { status: 503, text: "", kind: "unavailable" },
    { status: 200, text: "<html>", kind: "unavailable" },
    { status: 200, text: null, kind: "unavailable" },
  ])(
    "maps $status to $kind without retrying",
    async ({ status, text, kind }) => {
      const sent = recorder({ status, text });
      const result = await updateBotReplyModeViaHttp(
        BASE,
        BEARER,
        null,
        sent.transport,
        REPLY_MODE,
      );
      expect(result.kind).toBe(kind);
      expect(sent.requests).toHaveLength(1);
    },
  );

  it("uses the generic refusal when a 4xx body is absent or echoes the bearer", async () => {
    const missing = recorder({ status: 400, text: null });
    const echoed = recorder(json(400, { error: BEARER }));

    await expect(
      updateBotReplyModeViaHttp(
        BASE,
        BEARER,
        null,
        missing.transport,
        REPLY_MODE,
      ),
    ).resolves.toEqual({
      kind: "refused",
      status: 400,
      message: "Your environment did not accept this change.",
    });
    await expect(
      updateBotReplyModeViaHttp(
        BASE,
        BEARER,
        null,
        echoed.transport,
        REPLY_MODE,
      ),
    ).resolves.toEqual({
      kind: "refused",
      status: 400,
      message: "Your environment did not accept this change.",
    });
  });

  it("cleans control characters and bounds server refusal words", async () => {
    const longText = `  first\nline\u0000${"x".repeat(400)}  `;
    const result = await updateBotReplyModeViaHttp(
      BASE,
      BEARER,
      null,
      recorder(json(400, { message: longText })).transport,
      REPLY_MODE,
    );
    expect(result).toMatchObject({
      kind: "refused",
      message: `first line ${"x".repeat(289)}…`,
    });
  });

  it("uses server refusal words when present and preserves deleted false as success", async () => {
    await expect(
      updateBotReplyModeViaHttp(
        BASE,
        BEARER,
        null,
        recorder(json(422, { error: "Replies must stay in threads" }))
          .transport,
        REPLY_MODE,
      ),
    ).resolves.toMatchObject({
      kind: "refused",
      message: "Replies must stay in threads",
    });
    await expect(
      deleteBotViaHttp(
        BASE,
        BEARER,
        null,
        recorder(json(200, { deleted: false })).transport,
        DELETE,
      ),
    ).resolves.toEqual({ kind: "ok", deleted: false });
  });

  it("preserves the server's forbidden body and its message-only form", async () => {
    await expect(
      updateBotRunSettingsViaHttp(
        BASE,
        BEARER,
        null,
        recorder(
          json(403, {
            statusCode: 403,
            error: "Forbidden",
            code: "FORBIDDEN",
          }),
        ).transport,
        RUN_SETTINGS,
      ),
    ).resolves.toEqual({ kind: "refused", status: 403, message: "Forbidden" });
    await expect(
      updateBotRunSettingsViaHttp(
        BASE,
        BEARER,
        null,
        recorder(json(400, { message: "The model is not available" }))
          .transport,
        RUN_SETTINGS,
      ),
    ).resolves.toEqual({
      kind: "refused",
      status: 400,
      message: "The model is not available",
    });
  });

  it.each([
    {
      status: 200,
      text: JSON.stringify({ bot: { ...ROW, replyMode: undefined } }),
    },
    { status: 200, text: JSON.stringify({ bot: { ...ROW, harness: "" } }) },
    { status: 200, text: "not-json" },
    { status: 200, text: "" },
  ])("rejects malformed successful bot rows", async ({ status, text }) => {
    await expect(
      updateBotRunSettingsViaHttp(
        BASE,
        BEARER,
        null,
        recorder({ status, text }).transport,
        RUN_SETTINGS,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("rejects delete responses without a boolean and preserves opaque zero as unavailable", async () => {
    await expect(
      deleteBotViaHttp(
        BASE,
        BEARER,
        null,
        recorder(json(200, { deleted: "yes" })).transport,
        DELETE,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      updateBotRunSettingsViaHttp(
        BASE,
        BEARER,
        null,
        recorder({ status: 0, text: null }).transport,
        RUN_SETTINGS,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("answers no_response when the transport rejects", async () => {
    const transport: EnvironmentTransport = async () => {
      throw new Error("private transport detail");
    };
    const result = await updateBotRunSettingsViaHttp(
      BASE,
      BEARER,
      null,
      transport,
      RUN_SETTINGS,
    );
    expect(result).toEqual({ kind: "no_response" });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
    expect(JSON.stringify(result)).not.toContain(BEARER);
  });

  it("answers no_response when the transport does not answer by the write deadline", async () => {
    vi.useFakeTimers();
    const transport: EnvironmentTransport = async () =>
      new Promise<never>(() => undefined);
    const pending = updateBotRunSettingsViaHttp(
      BASE,
      BEARER,
      null,
      transport,
      RUN_SETTINGS,
    );
    await vi.advanceTimersByTimeAsync(70_000);
    await expect(pending).resolves.toEqual({ kind: "no_response" });
  });

  it.each([
    {
      name: "run settings",
      send: (transport: EnvironmentTransport) =>
        updateBotRunSettingsViaHttp(
          BASE,
          BEARER,
          null,
          transport,
          RUN_SETTINGS,
        ),
    },
    {
      name: "reply mode",
      send: (transport: EnvironmentTransport) =>
        updateBotReplyModeViaHttp(BASE, BEARER, null, transport, REPLY_MODE),
    },
    {
      name: "delete",
      send: (transport: EnvironmentTransport) =>
        deleteBotViaHttp(BASE, BEARER, null, transport, DELETE),
    },
  ])(
    "sets manual redirects through the real transport for $name",
    async ({ send }) => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response("", { status: 302 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await send(fetchEnvironmentTransport);
      expect(result.kind).toBe("unavailable");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
    },
  );
});
