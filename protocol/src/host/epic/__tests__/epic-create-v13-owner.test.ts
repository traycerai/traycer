import { describe, expect, it } from "vitest";
import {
  epicCreateUpgradeV12ToV13,
  epicCreateV12,
  epicCreateV13,
} from "@traycer/protocol/host/epic/contracts";
import {
  createEpicRequestSchemaV12,
  createEpicRequestSchemaV13,
  createEpicResponseSchemaV12,
  epicCreateOwnerSchema,
  type CreateEpicRequestV12,
  type CreateEpicRequestV13,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * `epic.create@1.3`: the request names who owns the new epic. `owner` is
 * `{kind: "person"} | {kind: "team", teamId} | null`; an absent key is the
 * person, which is exactly what every older caller meant. A `@1.2` host's
 * frozen request STRIPS the key, so a caller that sends a team owner requires
 * `@1.3` of the host.
 */

const epicLight = {
  id: "epic-1",
  title: "Epic",
  initialUserPrompt: "Do the thing",
  ticketCount: 0,
  specCount: 0,
  storyCount: 0,
  reviewCount: 0,
  status: "todo",
  createdAt: 1000,
  updatedAt: 1000,
  createdBy: "user-1",
  version: "2.0.0",
};

const baseRequest: CreateEpicRequestV12 = {
  epic: epicLight,
  repoIdentifiers: [],
  workspaces: [],
  chat: null,
};

describe("epic.create@1.3 request owner", () => {
  it("parses an absent owner to null: the person", () => {
    const parsed = createEpicRequestSchemaV13.parse(baseRequest);
    expect(parsed.owner).toBeNull();
  });

  it("parses an explicit null owner", () => {
    const parsed = createEpicRequestSchemaV13.parse({
      ...baseRequest,
      owner: null,
    });
    expect(parsed.owner).toBeNull();
  });

  it("parses a person owner", () => {
    const parsed = createEpicRequestSchemaV13.parse({
      ...baseRequest,
      owner: { kind: "person" },
    });
    expect(parsed.owner).toEqual({ kind: "person" });
  });

  it("parses a team owner and keeps everything else", () => {
    const parsed = createEpicRequestSchemaV13.parse({
      ...baseRequest,
      owner: { kind: "team", teamId: "team-1" },
    });
    expect(parsed.owner).toEqual({ kind: "team", teamId: "team-1" });
    expect(parsed.epic).toEqual(epicLight);
    expect(parsed.chat).toBeNull();
  });

  it("accepts a 64-character team id and refuses a 65-character one", () => {
    expect(
      epicCreateOwnerSchema.safeParse({ kind: "team", teamId: "t".repeat(64) })
        .success,
    ).toBe(true);
    expect(
      epicCreateOwnerSchema.safeParse({ kind: "team", teamId: "t".repeat(65) })
        .success,
    ).toBe(false);
  });

  it("refuses an empty team id", () => {
    expect(
      createEpicRequestSchemaV13.safeParse({
        ...baseRequest,
        owner: { kind: "team", teamId: "" },
      }).success,
    ).toBe(false);
  });

  it("refuses a team owner with no team id", () => {
    expect(
      createEpicRequestSchemaV13.safeParse({
        ...baseRequest,
        owner: { kind: "team" },
      }).success,
    ).toBe(false);
  });

  it("refuses an extra key on either owner arm", () => {
    expect(
      epicCreateOwnerSchema.safeParse({
        kind: "team",
        teamId: "team-1",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      epicCreateOwnerSchema.safeParse({ kind: "person", teamId: "team-1" })
        .success,
    ).toBe(false);
  });

  it("refuses an unknown owner kind", () => {
    expect(
      epicCreateOwnerSchema.safeParse({ kind: "org", teamId: "team-1" })
        .success,
    ).toBe(false);
  });
});

describe("epic.create@1.2 -> @1.3 upgrade", () => {
  it("fills owner: null on a @1.2 request and keeps every other field", () => {
    const upgraded = epicCreateUpgradeV12ToV13.upgradeRequest(baseRequest);
    expect(upgraded).toEqual({ ...baseRequest, owner: null });
    // The upgraded value is a valid @1.3 request as the schema parses it.
    expect(createEpicRequestSchemaV13.parse(upgraded)).toMatchObject(upgraded);
  });

  it("leaves the response alone", () => {
    const response = createEpicResponseSchemaV12.parse({
      roomInfo: null,
      initialTurnStarted: null,
    });
    expect(epicCreateUpgradeV12ToV13.upgradeResponse(response)).toBe(response);
  });

  it("runs from the @1.2 contract to the @1.3 one", () => {
    expect(epicCreateUpgradeV12ToV13.from).toBe(epicCreateV12.schemaVersion);
    expect(epicCreateUpgradeV12ToV13.to).toBe(epicCreateV13.schemaVersion);
  });
});

describe("epic.create@1.2 peer strip", () => {
  const v13Request: CreateEpicRequestV13 = {
    ...baseRequest,
    owner: { kind: "team", teamId: "team-1" },
  };

  it("a @1.2 peer's own request schema strips owner, keeping everything else", () => {
    const stripped = epicCreateV12.requestSchema.parse(v13Request);
    expect(stripped).not.toHaveProperty("owner");
    expect(stripped).toMatchObject(baseRequest);
  });

  it("the @1.2 request schema is not the @1.3 one: the freeze is a separate object", () => {
    expect(epicCreateV12.requestSchema).toBe(createEpicRequestSchemaV12);
    expect(epicCreateV13.requestSchema).toBe(createEpicRequestSchemaV13);
    expect(createEpicRequestSchemaV13).not.toBe(createEpicRequestSchemaV12);
    expect(createEpicRequestSchemaV12.shape).not.toHaveProperty("owner");
    expect(createEpicRequestSchemaV13.shape).toHaveProperty("owner");
  });
});

describe("epic.create registry line", () => {
  const line = hostRpcRegistry["epic.create"][1];

  it("advertises 1.5 on the released floor of a connection manifest", () => {
    const { manifest } = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(manifest["epic.create"]).toEqual({ major: 1, minor: 5 });
  });

  it("minor 3 is the epicCreateV13 contract, upgrading from the previous minor", () => {
    expect(line.versions[3].contract).toBe(epicCreateV13);
    expect(line.versions[3].upgradeFromPreviousVersion).toBe(
      epicCreateUpgradeV12ToV13,
    );
  });

  it("minor 3 keeps @1.2's response instance", () => {
    expect(line.versions[3].contract.responseSchema).toBe(
      createEpicResponseSchemaV12,
    );
    expect(line.versions[2].contract.responseSchema).toBe(
      createEpicResponseSchemaV12,
    );
  });

  it("the earlier minors are untouched", () => {
    expect(line.versions[2].contract).toBe(epicCreateV12);
  });
});
