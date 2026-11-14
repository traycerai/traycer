import { describe, expect, it } from "vitest";
import type {
  EnvironmentCloud,
  EnvironmentTransport,
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "../environment-cloud";
import {
  readAccountNotificationSettings,
  saveAccountNotificationHooks,
  saveAccountNotificationMatrix,
} from "../account-notifications";
import type {
  AccountNotificationSettings,
  AccountNotificationSettingsResponse,
} from "../account-notification-schemas";

const matrix = {
  needs_action: { renderer: true },
  failure: { renderer: true },
  done: { renderer: true },
  info: { renderer: false },
};

const settings: AccountNotificationSettings = { matrix, hooks: [] };

function answer(status: number, body: unknown): EnvironmentTransportAnswer {
  return { status, text: JSON.stringify(body) };
}

function cloudWith(answers: readonly EnvironmentTransportAnswer[]): {
  readonly cloud: EnvironmentCloud;
  readonly requests: EnvironmentTransportRequest[];
} {
  const requests: EnvironmentTransportRequest[] = [];
  let index = 0;
  const transport: EnvironmentTransport = async (request) => {
    requests.push(request);
    const next = answers[index];
    index += 1;
    if (next === undefined) throw new Error("Unexpected cloud request");
    return next;
  };
  return {
    cloud: {
      authnBaseUrl: "https://authn.example/",
      bearer: { kind: "cloud", getBearerToken: () => "test-bearer" },
      transport,
      onOriginSignIn: () => true,
    },
    requests,
  };
}

function row(
  nextSettings: AccountNotificationSettings | null,
  revision: number | null,
): AccountNotificationSettingsResponse {
  return { settings: nextSettings, revision };
}

describe("account notification settings transport", () => {
  it("reads the account row, including legacy hook actions for the editor to classify", async () => {
    const legacyHooks: AccountNotificationSettings["hooks"] = [
      {
        id: "literal",
        name: "Literal",
        enabled: true,
        severities: null,
        action: {
          type: "http",
          url: "https://hooks.example/literal",
          headers: { authorization: "Bearer typed-value" },
        },
        held: true,
      },
      {
        id: "templated",
        name: "Templated",
        enabled: true,
        severities: null,
        action: {
          type: "http",
          url: "https://hooks.example/templated",
          headers: { authorization: "Bearer $BUILD_TOKEN" },
        },
        held: false,
      },
      {
        id: "command",
        name: "Command",
        enabled: true,
        severities: null,
        action: {
          type: "command",
          command: "/usr/local/bin/notify",
          args: [],
          os: "macos",
        },
        held: false,
      },
    ];
    const response = row({ ...settings, hooks: legacyHooks }, 8);
    const { cloud, requests } = cloudWith([answer(200, response)]);

    const result = await readAccountNotificationSettings(cloud);

    expect(result).toEqual(response);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://authn.example/api/v3/user/notification-settings",
      body: null,
    });
  });

  it("sends a matrix-only update without replacing the hooks column", async () => {
    const response = row(settings, 9);
    const { cloud, requests } = cloudWith([answer(200, response)]);

    await saveAccountNotificationMatrix(cloud, { matrix, revision: 8 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({ matrix, revision: 8 });
  });

  it("sends a hooks-only update without replacing the matrix column", async () => {
    const hooks: AccountNotificationSettings["hooks"] = [
      {
        id: "one",
        name: "One",
        enabled: true,
        severities: null,
        action: {
          type: "http",
          url: "https://hooks.example/one",
          headers: {},
        },
        held: false,
      },
    ];
    const response = row({ ...settings, hooks }, 10);
    const { cloud, requests } = cloudWith([answer(200, response)]);

    await saveAccountNotificationHooks(cloud, { hooks, revision: 9 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({ hooks, revision: 9 });
  });

  it("reads the current revision and retries a revision conflict exactly once", async () => {
    const current = row(settings, 12);
    const requestedMatrix = {
      ...matrix,
      done: { renderer: false },
    };
    const updated = row({ ...settings, matrix: requestedMatrix }, 13);
    const conflict = {
      code: "revision_conflict",
      current: row(settings, 12),
    };
    const { cloud, requests } = cloudWith([
      answer(409, conflict),
      answer(200, current),
      answer(200, updated),
    ]);

    const result = await saveAccountNotificationMatrix(cloud, {
      matrix: requestedMatrix,
      revision: 11,
    });

    expect(result).toEqual(updated);
    expect(requests.map(({ method }) => method)).toEqual(["PUT", "GET", "PUT"]);
    expect(requests[0]?.body).toEqual({
      matrix: requestedMatrix,
      revision: 11,
    });
    expect(requests[2]?.body).toEqual({
      matrix: requestedMatrix,
      revision: current.revision,
    });
  });

  it.each([
    [
      400,
      {
        detail: "private response body",
        hookUrl: "https://hooks.example/private",
        headers: { authorization: "Bearer fixture-token" },
        accountId: "account-fixture",
      },
    ],
    [401, { code: "unauthorized", detail: "private response body" }],
    [403, { code: "forbidden", detail: "private response body" }],
    [302, { location: "https://elsewhere.example/private" }],
    [503, { detail: "private response body" }],
  ] as const)(
    "does not retry an ordinary %s refusal or expose its body",
    async (status, body) => {
      const { cloud, requests } = cloudWith([answer(status, body)]);

      const error = await saveAccountNotificationMatrix(cloud, {
        matrix,
        revision: 2,
      }).catch((reason: unknown) => reason);

      expect(error).toMatchObject({ name: "EnvironmentCloudError" });
      const visibleError =
        error instanceof Error ? error.message : String(error);
      expect(visibleError).not.toContain("private response body");
      expect(visibleError).not.toContain("elsewhere.example");
      expect(visibleError).not.toContain("hooks.example/private");
      expect(visibleError).not.toContain("fixture-token");
      expect(visibleError).not.toContain("account-fixture");
      expect(requests).toHaveLength(1);
    },
  );
});
