import { describe, expect, it } from "vitest";
import type {
  EnvironmentCloud,
  EnvironmentTransportRequest,
} from "../environment-cloud";
import {
  PERSONAL_FOR_MOVE_MAX_ITEMS,
  readPersonalForMove,
} from "../personal-for-move";

const ME_PATH = "api/v3/environments/me";
const ITEMS_PATH = "api/v3/environments/env-me/items";
const SECRETS_PATH = "api/v3/environments/env-me/secrets";

interface Personal {
  readonly me: { readonly status: number; readonly body: unknown };
  /** Rows by kind; a kind not named answers no rows. */
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
  readonly secrets: readonly unknown[];
}

/** authn at the transport, answering Personal's reads on the person's sign-in. */
function personalCloud(personal: Personal): {
  readonly cloud: EnvironmentCloud;
  readonly requested: string[];
} {
  const requested: string[] = [];
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.test",
    bearer: { kind: "cloud", getBearerToken: () => "bearer" },
    onOriginSignIn: () => true,
    transport: async (request: EnvironmentTransportRequest) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\//u, "");
      requested.push(path);
      if (path === ME_PATH)
        return {
          status: personal.me.status,
          text: JSON.stringify(personal.me.body),
        };
      if (path === ITEMS_PATH) {
        const kind = url.searchParams.get("kind") ?? "";
        const items = personal.rows[kind] ?? [];
        return { status: 200, text: JSON.stringify({ items }) };
      }
      if (path === SECRETS_PATH)
        return {
          status: 200,
          text: JSON.stringify({ secrets: personal.secrets, removed: [] }),
        };
      return { status: 404, text: "{}" };
    },
  };
  return { cloud, requested };
}

function row(kind: string, key: string, value: unknown): unknown {
  return {
    kind,
    key,
    os: null,
    value,
    revision: 4,
    updatedAt: 1_700_000_000_000,
    writtenBy: { source: "app", hostId: "host-1", hostName: "Rae's Mac" },
  };
}

const SECRET_ROW = {
  id: "secret-1",
  name: "GITHUB_TOKEN",
  kind: "env",
  protocol: "env",
  hosts: [],
  currentVersionId: "version-1",
  updatedAt: 1_700_000_000_000,
};

const FOUND_ME = { status: 200, body: { environmentId: "env-me" } };

describe("readPersonalForMove", () => {
  it("hands the computer each compared row's address and value, and whether Personal holds a secret", async () => {
    const { cloud } = personalCloud({
      me: FOUND_ME,
      rows: {
        variable: [row("variable", "NODE_ENV", "production")],
        shell: [row("shell", "zsh", { path: "/bin/zsh" })],
        auto_policy: [row("auto_policy", "default", { mode: "auto" })],
      },
      secrets: [SECRET_ROW],
    });

    await expect(readPersonalForMove(cloud)).resolves.toEqual({
      items: [
        { kind: "variable", key: "NODE_ENV", os: null, value: "production" },
        { kind: "shell", key: "zsh", os: null, value: { path: "/bin/zsh" } },
      ],
      holdsSecrets: true,
    });
  });

  it("says Personal holds no secret when the secret list is empty", async () => {
    const { cloud } = personalCloud({ me: FOUND_ME, rows: {}, secrets: [] });

    await expect(readPersonalForMove(cloud)).resolves.toEqual({
      items: [],
      holdsSecrets: false,
    });
  });

  it("is null, and reads no item, when Personal cannot be found on the sign-in", async () => {
    const { cloud, requested } = personalCloud({
      me: { status: 401, body: { error: "unauthorized" } },
      rows: { variable: [row("variable", "NODE_ENV", "production")] },
      secrets: [],
    });

    await expect(readPersonalForMove(cloud)).resolves.toBeNull();
    expect(requested).toEqual([ME_PATH]);
  });

  it("is null when Personal holds more rows than the requests carry", async () => {
    const variables = Array.from(
      { length: PERSONAL_FOR_MOVE_MAX_ITEMS + 1 },
      (_, index) => row("variable", `VAR_${String(index)}`, "x"),
    );
    const { cloud } = personalCloud({
      me: FOUND_ME,
      rows: { variable: variables },
      secrets: [],
    });

    await expect(readPersonalForMove(cloud)).resolves.toBeNull();
  });
});
