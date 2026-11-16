import { describe, expect, it } from "vitest";
import type {
  EnvironmentTransport,
  EnvironmentTransportRequest,
} from "../../environment/environment-cloud";
import {
  fetchTeamChatAutoArchiveViaHttp,
  parseTeamChatAutoArchiveSetRequest,
  putTeamChatAutoArchiveViaHttp,
} from "../team-chat-auto-archive";

const RECORD = {
  enabled: true,
  includeUserCreated: false,
  idleSeconds: 604_800,
  updatedAt: 1_763_100_000_000,
};

function transportAnswering(
  status: number,
  text: string | null,
): { transport: EnvironmentTransport; sent: EnvironmentTransportRequest[] } {
  const sent: EnvironmentTransportRequest[] = [];
  return {
    sent,
    transport: (request) => {
      sent.push(request);
      return Promise.resolve({ status, text });
    },
  };
}

describe("fetchTeamChatAutoArchiveViaHttp", () => {
  it("reads the team's record with the bearer, and null for a team that never saved one", async () => {
    const saved = transportAnswering(200, JSON.stringify(RECORD));
    expect(
      await fetchTeamChatAutoArchiveViaHttp(
        "https://server.example",
        "tok",
        null,
        saved.transport,
        "team/a",
      ),
    ).toEqual({ kind: "ok", record: RECORD });
    expect(saved.sent).toEqual([
      expect.objectContaining({
        url: "https://server.example/api/traycer/chat-auto-archive/teams/team%2Fa",
        method: "GET",
        headers: { Authorization: "Bearer tok", Accept: "application/json" },
        body: null,
      }),
    ]);

    const never = transportAnswering(200, "null");
    expect(
      await fetchTeamChatAutoArchiveViaHttp(
        "https://server.example/",
        "tok",
        null,
        never.transport,
        "team-a",
      ),
    ).toEqual({ kind: "ok", record: null });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [302, "failed"],
    [503, "failed"],
  ] as const)("reads a %i as %s", async (status, kind) => {
    const { transport } = transportAnswering(status, "");
    expect(
      await fetchTeamChatAutoArchiveViaHttp(
        "https://server.example",
        "tok",
        null,
        transport,
        "team-a",
      ),
    ).toEqual({ kind });
  });

  it("reads a body off the contract, or nothing answering, as failed", async () => {
    const off = transportAnswering(200, JSON.stringify({ enabled: "yes" }));
    expect(
      await fetchTeamChatAutoArchiveViaHttp(
        "https://server.example",
        "tok",
        null,
        off.transport,
        "team-a",
      ),
    ).toEqual({ kind: "failed" });
    expect(
      await fetchTeamChatAutoArchiveViaHttp(
        "https://server.example",
        "tok",
        null,
        () => Promise.reject(new Error("offline")),
        "team-a",
      ),
    ).toEqual({ kind: "failed" });
  });
});

describe("putTeamChatAutoArchiveViaHttp", () => {
  it("sends the three fields and answers the stored record", async () => {
    const saved = transportAnswering(200, JSON.stringify(RECORD));
    const request = {
      enabled: true,
      includeUserCreated: false,
      idleSeconds: 604_800,
    };
    expect(
      await putTeamChatAutoArchiveViaHttp(
        "https://server.example",
        "tok",
        "proxy",
        saved.transport,
        "team-a",
        request,
      ),
    ).toEqual({ kind: "ok", record: RECORD });
    expect(saved.sent).toEqual([
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Proxy-Authorization": "Bearer proxy",
          Authorization: "Bearer tok",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: request,
      }),
    ]);
  });
});

describe("parseTeamChatAutoArchiveSetRequest", () => {
  it("takes a threshold from 1 to 31,536,000 whole seconds and nothing else", () => {
    const write = (idleSeconds: number) => ({
      enabled: true,
      includeUserCreated: true,
      idleSeconds,
    });
    expect(parseTeamChatAutoArchiveSetRequest(write(1))).toEqual(write(1));
    expect(parseTeamChatAutoArchiveSetRequest(write(31_536_000))).toEqual(
      write(31_536_000),
    );
    expect(parseTeamChatAutoArchiveSetRequest(write(0))).toBeNull();
    expect(parseTeamChatAutoArchiveSetRequest(write(31_536_001))).toBeNull();
    expect(parseTeamChatAutoArchiveSetRequest(write(1.5))).toBeNull();
    expect(
      parseTeamChatAutoArchiveSetRequest({ ...write(60), extra: true }),
    ).toBeNull();
  });
});
