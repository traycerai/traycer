import { describe, expect, it } from "vitest";
import {
  EnvironmentCloudError,
  type EnvironmentCloud,
  type EnvironmentTransportRequest,
} from "../environment-cloud";
import { HostRpcError } from "../../host-transport/host-messenger";
import type {
  EnvironmentMoveOutcomeAnswer,
  EnvironmentMoveStageRequest,
  EnvironmentMoveStageResponse,
  EnvironmentMoveStartRequest,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  runEnvironmentMove,
  type EnvironmentMoveAcceptance,
  type EnvironmentMoveHost,
} from "../environment-move-flow";

const HOST_ID = "8f0c2a4e-5b1d-4c3e-9a7f-1e2d3c4b5a60";
const TEAM_ID = "2b7e9d10-4c5a-4f6e-8d3b-a1c2e3f40516";
const ATTEMPT_ID = "c3d4e5f6-0718-4a29-8b3c-4d5e6f708192";
const ACCEPTANCE_ID = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f60718293";
const PLAN_HASH = "a".repeat(64);
const DISCLOSURE_HASH = "b".repeat(64);

const teamAcceptance: EnvironmentMoveAcceptance = {
  hostId: HOST_ID,
  target: { kind: "team", environmentId: "env-team", teamId: TEAM_ID },
  planHash: PLAN_HASH,
  keyChoices: [{ key: "variable:API_URL", choice: "stays" }],
  personal: null,
};

function teamStage(
  overrides: Partial<{ planHash: string; keyChoices: [] }>,
): EnvironmentMoveStageResponse {
  return {
    evidence: {
      attemptId: ATTEMPT_ID,
      planHash: overrides.planHash ?? PLAN_HASH,
      planRevision: 3,
      hostVersion: "1.2.3",
      itemCount: 4,
      keyChoices: overrides.keyChoices ?? [
        { key: "variable:API_URL", choice: "stays" },
      ],
      sourceHostId: HOST_ID,
      sharingGeneration: 1,
      targetKind: "team",
      environmentId: "env-team",
      teamId: TEAM_ID,
      disclosureVersion: 2,
    },
    authorization: { disclosureHash: DISCLOSURE_HASH },
  };
}

interface HostCalls {
  readonly stage: EnvironmentMoveStageRequest[];
  readonly start: EnvironmentMoveStartRequest[];
}

function fakeHost(stage: () => Promise<EnvironmentMoveStageResponse>): {
  readonly host: EnvironmentMoveHost;
  readonly calls: HostCalls;
} {
  const calls: HostCalls = { stage: [], start: [] };
  const host: EnvironmentMoveHost = {
    stage: (request) => {
      calls.stage.push(request);
      return stage();
    },
    start: (request) => {
      calls.start.push(request);
      const running: EnvironmentMoveOutcomeAnswer = {
        state: "running",
        attemptId: request.attemptId,
        acceptanceId: request.acceptanceId,
      };
      return Promise.resolve(running);
    },
  };
  return { host, calls };
}

function fakeCloud(
  answer:
    | { status: number; body: unknown }
    | ((
        request: EnvironmentTransportRequest,
        origin: { current: boolean },
      ) =>
        | { status: number; body: unknown }
        | Promise<{ status: number; body: unknown }>),
): {
  readonly cloud: EnvironmentCloud;
  readonly sent: EnvironmentTransportRequest[];
  readonly origin: { current: boolean };
} {
  const sent: EnvironmentTransportRequest[] = [];
  const origin = { current: true };
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.test",
    bearer: { kind: "cloud", getBearerToken: () => "bearer-1" },
    onOriginSignIn: () => origin.current,
    transport: async (request) => {
      sent.push(request);
      const response =
        typeof answer === "function" ? await answer(request, origin) : answer;
      return { status: response.status, text: JSON.stringify(response.body) };
    },
  };
  return { cloud, sent, origin };
}

describe("runEnvironmentMove", () => {
  it("stages, records the acceptance at authn, then starts the computer with it", async () => {
    const { host, calls } = fakeHost(() => Promise.resolve(teamStage({})));
    const { cloud, sent } = fakeCloud({
      status: 201,
      body: { acceptanceId: ACCEPTANCE_ID },
    });

    const result = await runEnvironmentMove(host, cloud, teamAcceptance);

    expect(calls.stage).toEqual([
      {
        target: teamAcceptance.target,
        keyChoices: teamAcceptance.keyChoices,
        personal: null,
      },
    ]);
    expect(
      sent.map((request) => [request.method, request.url, request.body]),
    ).toEqual([
      [
        "POST",
        `https://authn.test/api/v3/hosts/${HOST_ID}/move-acceptances`,
        {
          ...teamStage({}).evidence,
          disclosureHash: DISCLOSURE_HASH,
        },
      ],
    ]);
    expect(calls.start).toEqual([
      {
        attemptId: ATTEMPT_ID,
        planHash: PLAN_HASH,
        acceptanceId: ACCEPTANCE_ID,
      },
    ]);
    expect(result).toEqual({
      kind: "started",
      outcome: {
        state: "running",
        attemptId: ATTEMPT_ID,
        acceptanceId: ACCEPTANCE_ID,
      },
    });
  });

  it("stages a move into Personal against the read of Personal the sheet was drawn from", async () => {
    const personal = {
      items: [
        {
          kind: "variable" as const,
          key: "API_URL",
          os: null,
          value: "https://api.example",
        },
      ],
      holdsSecrets: true,
    };
    const { host, calls } = fakeHost(() =>
      Promise.resolve({
        evidence: {
          attemptId: ATTEMPT_ID,
          planHash: PLAN_HASH,
          planRevision: 3,
          hostVersion: "1.2.3",
          itemCount: 1,
          keyChoices: [],
          sourceHostId: HOST_ID,
          sharingGeneration: 1,
          targetKind: "personal",
          environmentId: "env-me",
          disclosureVersion: 1,
        },
        authorization: { manifestHash: "d".repeat(64) },
      }),
    );
    const { cloud } = fakeCloud({
      status: 201,
      body: { acceptanceId: ACCEPTANCE_ID },
    });

    await runEnvironmentMove(host, cloud, {
      hostId: HOST_ID,
      target: { kind: "personal", environmentId: "env-me" },
      planHash: PLAN_HASH,
      keyChoices: [],
      personal,
    });

    expect(calls.stage).toEqual([
      {
        target: { kind: "personal", environmentId: "env-me" },
        keyChoices: [],
        personal,
      },
    ]);
  });

  it.each([
    ["another plan", teamStage({ planHash: "c".repeat(64) })],
    ["other key choices", teamStage({ keyChoices: [] })],
  ])(
    "records nothing and starts nothing when the computer staged %s",
    async (_label, staged) => {
      const { host, calls } = fakeHost(() => Promise.resolve(staged));
      const { cloud, sent } = fakeCloud({ status: 201, body: {} });

      const result = await runEnvironmentMove(host, cloud, teamAcceptance);

      expect(result).toEqual({ kind: "plan_changed" });
      expect(sent).toEqual([]);
      expect(calls.start).toEqual([]);
    },
  );

  it.each(["operation_acceptance_invalid", "move_acceptance_conflict"])(
    "answers refused and starts nothing on authn's 409 %s",
    async (code) => {
      const { host, calls } = fakeHost(() => Promise.resolve(teamStage({})));
      const { cloud } = fakeCloud({ status: 409, body: { code } });

      const result = await runEnvironmentMove(host, cloud, teamAcceptance);

      expect(result).toEqual({ kind: "refused" });
      expect(calls.start).toEqual([]);
    },
  );

  it("throws the permission refusal when authn answers 403", async () => {
    const { host, calls } = fakeHost(() => Promise.resolve(teamStage({})));
    const { cloud } = fakeCloud({ status: 403, body: {} });

    const run = runEnvironmentMove(host, cloud, teamAcceptance);

    await expect(run).rejects.toBeInstanceOf(EnvironmentCloudError);
    await expect(run).rejects.toMatchObject({ kind: "forbidden" });
    expect(calls.start).toEqual([]);
  });

  it("does not start after authn accepts on a sign-in that has changed", async () => {
    const { host, calls } = fakeHost(() => Promise.resolve(teamStage({})));
    const requested = Promise.withResolvers<void>();
    const acceptance = Promise.withResolvers<{
      status: number;
      body: unknown;
    }>();
    const { cloud, sent, origin } = fakeCloud((request) => {
      expect(request.url).toBe(
        `https://authn.test/api/v3/hosts/${HOST_ID}/move-acceptances`,
      );
      requested.resolve();
      return acceptance.promise;
    });

    const move = runEnvironmentMove(host, cloud, teamAcceptance);
    await requested.promise;
    origin.current = false;
    acceptance.resolve({
      status: 201,
      body: { acceptanceId: ACCEPTANCE_ID },
    });
    const result = await move;

    expect(sent).toHaveLength(1);
    expect(result).toEqual({ kind: "sign_in_changed" });
    expect(calls.start).toEqual([]);
  });

  it("returns sign_in_changed when the changed sign-in's start throws", async () => {
    const { cloud, origin } = fakeCloud({
      status: 201,
      body: { acceptanceId: ACCEPTANCE_ID },
    });
    const { host: stagedHost, calls } = fakeHost(() =>
      Promise.resolve(teamStage({})),
    );
    const host: EnvironmentMoveHost = {
      ...stagedHost,
      start: (request) => {
        calls.start.push(request);
        origin.current = false;
        return Promise.reject(new Error("the start did not reach the host"));
      },
    };

    const result = await runEnvironmentMove(host, cloud, teamAcceptance);

    expect(calls.start).toEqual([
      {
        attemptId: ATTEMPT_ID,
        planHash: PLAN_HASH,
        acceptanceId: ACCEPTANCE_ID,
      },
    ]);
    expect(result).toEqual({ kind: "sign_in_changed" });
  });

  it("answers not_awaiting when the computer has no move waiting", async () => {
    const { host } = fakeHost(() =>
      Promise.reject(
        new HostRpcError({
          code: "E_MOVE_NOT_AWAITING",
          message: "no move awaits",
          requestId: "r-1",
          method: "environment.move.stage",
          fatalDetails: null,
        }),
      ),
    );
    const { cloud, sent } = fakeCloud({ status: 201, body: {} });

    const result = await runEnvironmentMove(host, cloud, teamAcceptance);

    expect(result).toEqual({ kind: "not_awaiting" });
    expect(sent).toEqual([]);
  });
});
