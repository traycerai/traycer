import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  validateVersionedRpcRegistry,
  type MethodVersionRegistry,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import {
  configEnvSetUpgradeV10ToV11,
  configEnvSetV10,
  configShellAddUpgradeV10ToV11,
  configShellAddV10,
  configShellRemoveUpgradeV10ToV11,
  configShellRemoveV10,
  configShellResetUpgradeV10ToV11,
  configShellResetV10,
  configShellRevertArgsUpgradeV10ToV11,
  configShellRevertArgsV10,
  configShellSetUpgradeV10ToV11,
  configShellSetV10,
} from "@traycer/protocol/host/config/contracts";
import {
  ENVIRONMENT_RPC_METHODS,
  environmentReviewUpgradeV11ToV12,
  environmentReviewV11,
  environmentReviewV12,
} from "@traycer/protocol/host/environment-contracts";
import * as env from "@traycer/protocol/host/environment-schemas";
import { EXECUTABLE_WRITE_GRANT_MAX_LENGTH } from "@traycer/protocol/host/executable-write-grant";
import {
  hostNotificationHooksSave,
  hostNotificationHooksSaveUpgradeV1ToV2,
  hostNotificationHooksSaveV20,
} from "@traycer/protocol/host/notifications/host-notifications";
import { providersListResponseSchema } from "@traycer/protocol/host/provider-schemas";
import {
  PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
  hostRpcRegistry,
  providersListV100,
  providersNativeMutateUpgradeV12ToV13,
  providersNativeMutateV12,
  providersSetEnvOverrideUpgradeV21ToV22,
  providersSetEnvOverrideV10,
  providersSetEnvOverrideV20,
  providersSetEnvOverrideV21,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { prepareRequestPayload } from "@traycer/protocol/host-transport/remote/rpc-codec";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  negotiatedVersionMeetsRequirement,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { releasedMethodNames } from "./__fixtures__/released-method-names";
import { supportMatrix } from "./__fixtures__/support-matrix";

/**
 * The wire of the environment family: the 26 environment methods, the
 * executable-write grant on every method that reaches an execution sink, the
 * `providers.list@10.5` envelope keys, `providers.nativeMutate@1.3`'s
 * `promoteToPersonal`, and the five secret shapes, field for field.
 *
 * Two kinds of negative control live here, each on a COPY (never on the
 * registry): a main assertion that can only pass is not evidence, so each shows
 * the assertion fails when the mechanism under test is removed.
 */

type EnvironmentMethodName = keyof typeof ENVIRONMENT_RPC_METHODS;

function isEnvironmentMethodName(name: string): name is EnvironmentMethodName {
  return name in ENVIRONMENT_RPC_METHODS;
}

const ENVIRONMENT_METHOD_NAMES = Object.keys(ENVIRONMENT_RPC_METHODS).filter(
  isEnvironmentMethodName,
);

/** The family's methods that carry a `@1.2` MINOR over their `@1.1`. */
const ENVIRONMENT_METHODS_WITH_MINOR_1_2: ReadonlySet<string> = new Set([
  "environment.review",
  "environment.secrets.list",
]);

/** The family's methods that carry an `@1.1` MINOR over their `@1.0`. */
const ENVIRONMENT_METHODS_WITH_MINOR_1_1: ReadonlySet<string> = new Set([
  "providers.link",
  "providers.linkComplete",
  "environment.secrets.create",
  "environment.secrets.verify",
  "environment.secrets.replaceValue",
  "environment.secrets.versions",
  "environment.secrets.undo",
  "environment.secrets.destroy",
  "environment.secrets.rotation",
  "environment.secrets.consent",
  "environment.status",
  "environment.review",
]);

const JWT_SHAPED_GRANT =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIiwiaG9zdCI6ImgxIn0.c2lnbmF0dXJl";

function majorKeys(entry: object): string[] {
  return Object.keys(entry).filter((key) => /^\d+$/.test(key));
}

interface EnvironmentRegistryEntryView {
  readonly degrade: { readonly kind: string };
  readonly 1: { readonly latestMinor: number; readonly versions: object };
}

function registryShapeOf(entry: EnvironmentRegistryEntryView): string {
  return [
    `degrade=${entry.degrade.kind}`,
    `majors=${majorKeys(entry).join(",")}`,
    `latestMinor=${String(entry[1].latestMinor)}`,
    `minors=${Object.keys(entry[1].versions).join(",")}`,
  ].join(" ");
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function accepts(schema: z.ZodType, input: unknown): boolean {
  return schema.safeParse(input).success;
}

const baseBinding = {
  kind: "http",
  protocol: "https",
  hosts: ["api.example.com"],
  port: null,
  identity: null,
  database: null,
  policy: null,
  tlsPolicy: null,
  pinnedHostKeys: null,
  connectorId: null,
  confirmedAddresses: null,
};

const databaseBinding = {
  ...baseBinding,
  kind: "database",
  protocol: "postgres",
  hosts: ["db.internal.example.com"],
  port: 5432,
  identity: "app_user",
  database: "orders",
  value: "s3cret-password",
};

const sshBinding = {
  ...baseBinding,
  kind: "ssh",
  protocol: "ssh",
  hosts: ["bastion.example.com", "10.0.0.7"],
  port: 22,
  identity: "deploy",
  policy: { allowForwarding: false, maxSessionSeconds: 3600 },
  pinnedHostKeys: [
    { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc123" },
    { algorithm: "ecdsa-sha2-nistp256", fingerprint: "SHA256:def456" },
  ],
  confirmedAddresses: ["10.0.0.7"],
  value: null,
};

const createOptions = {
  name: "PROD_DB",
  mode: "brokered",
  portOverride: false,
  swapSites: ["header"],
  variables: [{ name: "DATABASE_URL", dialect: "postgres_url" }],
  exportPolicy: null,
  sandboxesByDefault: false,
  plaintextConsent: null,
};

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return null;
}

function expectDowngradeUnsupported(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(HostRpcError);
  if (!(thrown instanceof HostRpcError)) return;
  expect(thrown.code).toBe("DOWNGRADE_UNSUPPORTED");
}

// ── (a) ─────────────────────────────────────────────────────────────────────

describe("new methods are off every released floor", () => {
  it("registers exactly 27 environment methods", () => {
    expect(ENVIRONMENT_METHOD_NAMES).toHaveLength(27);
    expect(Object.keys(ENVIRONMENT_RPC_METHODS)).toHaveLength(27);
  });

  it("keeps all of them out of RELEASED_FLOOR_METHOD_NAMES", () => {
    const floor = new Set(RELEASED_FLOOR_METHOD_NAMES);
    expect(ENVIRONMENT_METHOD_NAMES.filter((name) => floor.has(name))).toEqual(
      [],
    );
  });

  it("keeps all of them out of the guarded released-method-names fixture", () => {
    const released = new Set(releasedMethodNames);
    expect(
      ENVIRONMENT_METHOD_NAMES.filter((name) => released.has(name)),
    ).toEqual([]);
  });

  it("keeps all of them out of every support-matrix manifest", () => {
    expect(supportMatrix.length).toBeGreaterThan(0);
    const offenders = supportMatrix.flatMap((entry) =>
      ENVIRONMENT_METHOD_NAMES.filter((name) => name in entry.manifest).map(
        (name) => `${entry.version}: ${name}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("registers each in hostRpcRegistry as unsupported-degrade, major 1 only, with @1.0 alone, @1.0 and @1.1, or @1.0 to @1.2", () => {
    const shapes = ENVIRONMENT_METHOD_NAMES.map(
      (name) => `${name}: ${registryShapeOf(hostRpcRegistry[name])}`,
    );
    expect(shapes).toEqual(
      ENVIRONMENT_METHOD_NAMES.map((name) =>
        ENVIRONMENT_METHODS_WITH_MINOR_1_2.has(name)
          ? `${name}: degrade=unsupported majors=1 latestMinor=2 minors=0,1,2`
          : ENVIRONMENT_METHODS_WITH_MINOR_1_1.has(name)
            ? `${name}: degrade=unsupported majors=1 latestMinor=1 minors=0,1`
            : `${name}: degrade=unsupported majors=1 latestMinor=0 minors=0`,
      ),
    );
    expect(hostRpcRegistry["environment.status"].degrade).toEqual({
      kind: "unsupported",
    });
  });
});

// ── (b) ─────────────────────────────────────────────────────────────────────

describe("a 10.0 caller of providers.list receives no scope or onHostOnly", () => {
  const tenOne = {
    providers: [],
    native: null,
    scope: "personal",
    onHostOnly: [{ providerId: "claude-code", profileId: "p1" }],
  };

  it("keeps both envelope keys on the 10.5 response schema", () => {
    const line = hostRpcRegistry["providers.list"][10];
    const live = line.versions[5].contract.responseSchema.parse(tenOne);
    expect(live.scope).toBe("personal");
    expect(live.onHostOnly).toEqual([
      { providerId: "claude-code", profileId: "p1" },
    ]);
    expect(providersListResponseSchema.parse(tenOne)).toEqual(live);
  });

  it("projects a 10.0 caller's response with neither key", () => {
    const row = hostRpcRegistry["providers.list"][10].versions[0].contract;
    expect(row).toBe(providersListV100);
    expect(row.schemaVersion).toEqual({ major: 10, minor: 0 });
    const projected = row.responseSchema.parse(tenOne);
    expect(sortedKeys(projected)).toEqual(["native", "providers"]);
    expect(projected).not.toHaveProperty("scope");
    expect(projected).not.toHaveProperty("onHostOnly");
  });

  it("RED PROOF ON A COPY: the same 10.0 row with its freeze removed keeps both keys", () => {
    const unfrozenCopy = defineRpcContract({
      method: "providers.list",
      schemaVersion: { major: 10, minor: 0 },
      requestSchema: providersListV100.requestSchema,
      responseSchema: providersListResponseSchema,
    });
    const leaked = unfrozenCopy.responseSchema.parse(tenOne);
    // The main assertion above (`not.toHaveProperty`) fails on exactly this.
    expect(leaked).toHaveProperty("scope", "personal");
    expect(leaked).toHaveProperty("onHostOnly");
    expect(sortedKeys(leaked)).toEqual([
      "native",
      "onHostOnly",
      "providers",
      "scope",
    ]);
    // And the registry's own row is not that copy.
    expect(hostRpcRegistry["providers.list"][10].versions[0].contract).not.toBe(
      unfrozenCopy,
    );
  });
});

// ── (c) ─────────────────────────────────────────────────────────────────────

interface ReleasedSinkCase {
  readonly label: string;
  readonly registry: MethodVersionRegistry;
  readonly method: string;
  readonly clientVersion: SchemaVersion;
  readonly latestRequestSchema: z.ZodType;
  /** The request a caller on the previous released line sends (no grant). */
  readonly legacyRequest: Record<string, unknown>;
  /** Every older line a new client reaches, newest first. */
  readonly hostLines: readonly {
    readonly version: SchemaVersion;
    readonly requestSchema: z.ZodType;
  }[];
  readonly upgradePath: unknown;
  readonly registeredUpgrade: unknown;
  readonly upgrade: (legacy: unknown) => unknown;
}

const releasedSinkCases: readonly ReleasedSinkCase[] = [
  {
    label: "providers.nativeMutate@1.3",
    registry: hostRpcRegistry["providers.nativeMutate"],
    method: "providers.nativeMutate",
    clientVersion: { major: 1, minor: 3 },
    latestRequestSchema:
      hostRpcRegistry["providers.nativeMutate"][1].versions[3].contract
        .requestSchema,
    legacyRequest: {
      providerId: "claude-code",
      mutation: {
        kind: "mcp",
        scope: "global",
        workspaceRoot: null,
        mutation: { action: "remove", name: "x" },
      },
    },
    hostLines: [
      {
        version: { major: 1, minor: 2 },
        requestSchema: providersNativeMutateV12.requestSchema,
      },
    ],
    upgradePath: providersNativeMutateUpgradeV12ToV13,
    registeredUpgrade:
      hostRpcRegistry["providers.nativeMutate"][1].versions[3]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      providersNativeMutateUpgradeV12ToV13.upgradeRequest(
        providersNativeMutateV12.requestSchema.parse(legacy),
      ),
  },
  {
    label: "config.shell.set@1.1",
    registry: hostRpcRegistry["config.shell.set"],
    method: "config.shell.set",
    clientVersion: { major: 1, minor: 1 },
    latestRequestSchema:
      hostRpcRegistry["config.shell.set"][1].versions[1].contract.requestSchema,
    legacyRequest: { path: "/bin/zsh", args: ["-l"] },
    hostLines: [
      {
        version: { major: 1, minor: 0 },
        requestSchema: configShellSetV10.requestSchema,
      },
    ],
    upgradePath: configShellSetUpgradeV10ToV11,
    registeredUpgrade:
      hostRpcRegistry["config.shell.set"][1].versions[1]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      configShellSetUpgradeV10ToV11.upgradeRequest(
        configShellSetV10.requestSchema.parse(legacy),
      ),
  },
  {
    label: "config.shell.add@1.1",
    registry: hostRpcRegistry["config.shell.add"],
    method: "config.shell.add",
    clientVersion: { major: 1, minor: 1 },
    latestRequestSchema:
      hostRpcRegistry["config.shell.add"][1].versions[1].contract.requestSchema,
    legacyRequest: { path: "/usr/local/bin/fish" },
    hostLines: [
      {
        version: { major: 1, minor: 0 },
        requestSchema: configShellAddV10.requestSchema,
      },
    ],
    upgradePath: configShellAddUpgradeV10ToV11,
    registeredUpgrade:
      hostRpcRegistry["config.shell.add"][1].versions[1]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      configShellAddUpgradeV10ToV11.upgradeRequest(
        configShellAddV10.requestSchema.parse(legacy),
      ),
  },
  {
    label: "config.shell.remove@1.1",
    registry: hostRpcRegistry["config.shell.remove"],
    method: "config.shell.remove",
    clientVersion: { major: 1, minor: 1 },
    latestRequestSchema:
      hostRpcRegistry["config.shell.remove"][1].versions[1].contract
        .requestSchema,
    legacyRequest: { path: "/usr/local/bin/fish" },
    hostLines: [
      {
        version: { major: 1, minor: 0 },
        requestSchema: configShellRemoveV10.requestSchema,
      },
    ],
    upgradePath: configShellRemoveUpgradeV10ToV11,
    registeredUpgrade:
      hostRpcRegistry["config.shell.remove"][1].versions[1]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      configShellRemoveUpgradeV10ToV11.upgradeRequest(
        configShellRemoveV10.requestSchema.parse(legacy),
      ),
  },
  {
    label: "config.shell.reset@1.1",
    registry: hostRpcRegistry["config.shell.reset"],
    method: "config.shell.reset",
    clientVersion: { major: 1, minor: 1 },
    latestRequestSchema:
      hostRpcRegistry["config.shell.reset"][1].versions[1].contract
        .requestSchema,
    legacyRequest: {},
    hostLines: [
      {
        version: { major: 1, minor: 0 },
        requestSchema: configShellResetV10.requestSchema,
      },
    ],
    upgradePath: configShellResetUpgradeV10ToV11,
    registeredUpgrade:
      hostRpcRegistry["config.shell.reset"][1].versions[1]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      configShellResetUpgradeV10ToV11.upgradeRequest(
        configShellResetV10.requestSchema.parse(legacy),
      ),
  },
  {
    label: "config.shell.revertArgs@1.1",
    registry: hostRpcRegistry["config.shell.revertArgs"],
    method: "config.shell.revertArgs",
    clientVersion: { major: 1, minor: 1 },
    latestRequestSchema:
      hostRpcRegistry["config.shell.revertArgs"][1].versions[1].contract
        .requestSchema,
    legacyRequest: { path: "/bin/zsh" },
    hostLines: [
      {
        version: { major: 1, minor: 0 },
        requestSchema: configShellRevertArgsV10.requestSchema,
      },
    ],
    upgradePath: configShellRevertArgsUpgradeV10ToV11,
    registeredUpgrade:
      hostRpcRegistry["config.shell.revertArgs"][1].versions[1]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      configShellRevertArgsUpgradeV10ToV11.upgradeRequest(
        configShellRevertArgsV10.requestSchema.parse(legacy),
      ),
  },
  {
    label: "config.env.set@1.1",
    registry: hostRpcRegistry["config.env.set"],
    method: "config.env.set",
    clientVersion: { major: 1, minor: 1 },
    latestRequestSchema:
      hostRpcRegistry["config.env.set"][1].versions[1].contract.requestSchema,
    legacyRequest: { key: "NODE_OPTIONS", value: "--max-old-space-size=4096" },
    hostLines: [
      {
        version: { major: 1, minor: 0 },
        requestSchema: configEnvSetV10.requestSchema,
      },
    ],
    upgradePath: configEnvSetUpgradeV10ToV11,
    registeredUpgrade:
      hostRpcRegistry["config.env.set"][1].versions[1]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      configEnvSetUpgradeV10ToV11.upgradeRequest(
        configEnvSetV10.requestSchema.parse(legacy),
      ),
  },
  {
    label: "providers.setEnvOverride@2.2",
    registry: hostRpcRegistry["providers.setEnvOverride"],
    method: "providers.setEnvOverride",
    clientVersion: { major: 2, minor: 2 },
    latestRequestSchema:
      hostRpcRegistry["providers.setEnvOverride"][2].versions[2].contract
        .requestSchema,
    legacyRequest: {
      providerId: "claude-code",
      key: "CLAUDE_BIN",
      value: "/x",
    },
    hostLines: [
      {
        version: { major: 2, minor: 1 },
        requestSchema: providersSetEnvOverrideV21.requestSchema,
      },
      {
        version: { major: 2, minor: 0 },
        requestSchema: providersSetEnvOverrideV20.requestSchema,
      },
      {
        version: { major: 1, minor: 0 },
        requestSchema: providersSetEnvOverrideV10.requestSchema,
      },
    ],
    upgradePath: providersSetEnvOverrideUpgradeV21ToV22,
    registeredUpgrade:
      hostRpcRegistry["providers.setEnvOverride"][2].versions[2]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      providersSetEnvOverrideUpgradeV21ToV22.upgradeRequest(
        providersSetEnvOverrideV21.requestSchema.parse(legacy),
      ),
  },
  {
    label: "host.notificationHooks.save@2.0",
    registry: hostRpcRegistry["host.notificationHooks.save"],
    method: "host.notificationHooks.save",
    clientVersion: { major: 2, minor: 0 },
    latestRequestSchema:
      hostRpcRegistry["host.notificationHooks.save"][2].versions[0].contract
        .requestSchema,
    legacyRequest: {
      hooks: [
        {
          id: "h1",
          name: null,
          enabled: true,
          severities: null,
          action: { type: "command", command: "/bin/echo", args: ["hi"] },
        },
      ],
    },
    hostLines: [
      {
        version: { major: 1, minor: 0 },
        requestSchema: hostNotificationHooksSave.requestSchema,
      },
    ],
    upgradePath: hostNotificationHooksSaveUpgradeV1ToV2,
    registeredUpgrade:
      hostRpcRegistry["host.notificationHooks.save"][2].versions[0]
        .upgradeFromPreviousVersion,
    upgrade: (legacy) =>
      hostNotificationHooksSaveUpgradeV1ToV2.upgradeRequest(
        hostNotificationHooksSave.requestSchema.parse(legacy),
      ),
  },
];

interface NewSinkCase {
  readonly label: string;
  readonly requestSchema: z.ZodType;
  readonly request: Record<string, unknown>;
}

const newSinkCases: readonly NewSinkCase[] = [
  {
    label: "config.env.localOverride.set@1.0",
    requestSchema:
      ENVIRONMENT_RPC_METHODS["config.env.localOverride.set"][1].versions[0]
        .contract.requestSchema,
    request: {
      target: { kind: "variable", key: "NODE_OPTIONS" },
      value: "--inspect",
    },
  },
  {
    label: "environment.agentDefinitions.put@1.0",
    requestSchema:
      ENVIRONMENT_RPC_METHODS["environment.agentDefinitions.put"][1].versions[0]
        .contract.requestSchema,
    request: {
      name: "reviewer.md",
      text: "# Reviewer",
      expectedRevision: null,
    },
  },
  {
    label: "environment.setup.put@1.0",
    requestSchema:
      ENVIRONMENT_RPC_METHODS["environment.setup.put"][1].versions[0].contract
        .requestSchema,
    request: { os: "linux", text: "echo setup", expectedRevision: 3 },
  },
  {
    label: "environment.undo@1.0",
    requestSchema:
      ENVIRONMENT_RPC_METHODS["environment.undo"][1].versions[0].contract
        .requestSchema,
    request: { noticeId: "notice-1" },
  },
];

const allSinkCases: readonly NewSinkCase[] = [
  ...releasedSinkCases.map((entry) => ({
    label: entry.label,
    requestSchema: entry.latestRequestSchema,
    request: entry.legacyRequest,
  })),
  ...newSinkCases,
];

describe("every sink-reaching method parses with and without executableWriteGrant", () => {
  it("covers 13 methods: nine released lines that grew a grant, four new ones", () => {
    expect(releasedSinkCases).toHaveLength(9);
    expect(newSinkCases).toHaveLength(4);
    expect(allSinkCases).toHaveLength(13);
  });

  describe.each(allSinkCases)("$label latest request", (entry) => {
    it("accepts a jwt-shaped grant and null, and keeps the grant on the parsed value", () => {
      const withGrant = entry.requestSchema.safeParse({
        ...entry.request,
        executableWriteGrant: JWT_SHAPED_GRANT,
      });
      expect(withGrant.success).toBe(true);
      expect(withGrant.data).toHaveProperty(
        "executableWriteGrant",
        JWT_SHAPED_GRANT,
      );
      const withNull = entry.requestSchema.safeParse({
        ...entry.request,
        executableWriteGrant: null,
      });
      expect(withNull.success).toBe(true);
      expect(withNull.data).toHaveProperty("executableWriteGrant", null);
    });

    it("rejects a grant longer than 8192 characters, but accepts one of exactly 8192", () => {
      expect(EXECUTABLE_WRITE_GRANT_MAX_LENGTH).toBe(8192);
      expect(
        accepts(entry.requestSchema, {
          ...entry.request,
          executableWriteGrant: "a".repeat(8192),
        }),
      ).toBe(true);
      expect(
        accepts(entry.requestSchema, {
          ...entry.request,
          executableWriteGrant: "a".repeat(8193),
        }),
      ).toBe(false);
    });

    it("requires the key: no grant is `null`, never an omitted field", () => {
      expect(accepts(entry.requestSchema, entry.request)).toBe(false);
      expect(
        accepts(entry.requestSchema, {
          ...entry.request,
          executableWriteGrant: "",
        }),
      ).toBe(false);
    });
  });

  describe.each(releasedSinkCases)(
    "$label against the released line",
    (entry) => {
      it("keeps the previous line's request schema parsing the old shape", () => {
        for (const line of entry.hostLines) {
          expect(
            accepts(line.requestSchema, entry.legacyRequest),
            `${String(line.version.major)}.${String(line.version.minor)}`,
          ).toBe(true);
        }
      });

      it("registers the upgrade path, which fills executableWriteGrant: null", () => {
        expect(entry.registeredUpgrade).toBe(entry.upgradePath);
        const upgraded = entry.upgrade(entry.legacyRequest);
        expect(upgraded).toEqual({
          ...entry.legacyRequest,
          executableWriteGrant: null,
        });
        expect(accepts(entry.latestRequestSchema, upgraded)).toBe(true);
      });

      it("sends a newer client's request to every older host line WITHOUT the grant, in a shape that line accepts", () => {
        const params = {
          ...entry.legacyRequest,
          executableWriteGrant: JWT_SHAPED_GRANT,
        };
        for (const line of entry.hostLines) {
          const prepared = prepareRequestPayload(
            entry.registry,
            entry.clientVersion,
            line.version,
            params,
            "r1",
            entry.method,
          );
          const label = `${String(line.version.major)}.${String(line.version.minor)}`;
          expect(prepared.onWireVersion, label).toEqual(line.version);
          expect(prepared.onWirePayload, label).not.toHaveProperty(
            "executableWriteGrant",
          );
          expect(prepared.onWirePayload, label).toEqual(entry.legacyRequest);
          expect(
            accepts(line.requestSchema, prepared.onWirePayload),
            label,
          ).toBe(true);
        }
      });

      it("leaves the grant intact between peers on the same line", () => {
        const params = {
          ...entry.legacyRequest,
          executableWriteGrant: JWT_SHAPED_GRANT,
        };
        const prepared = prepareRequestPayload(
          entry.registry,
          entry.clientVersion,
          entry.clientVersion,
          params,
          "r2",
          entry.method,
        );
        expect(prepared.onWirePayload).toEqual(params);
      });
    },
  );

  it("providers.setEnvOverride: the 1.0 line is strict, which is why the downgrade must strip the grant", () => {
    const strictRefusal = providersSetEnvOverrideV10.requestSchema.safeParse({
      providerId: "claude-code",
      key: "CLAUDE_BIN",
      value: "/x",
      executableWriteGrant: JWT_SHAPED_GRANT,
    });
    expect(strictRefusal.success).toBe(false);
  });

  it("host.notificationHooks.save: the 1.0 line is strict, so a grant-bearing body is refused there", () => {
    const hooks = releasedSinkCases.find(
      (entry) => entry.method === "host.notificationHooks.save",
    );
    expect(hooks).toBeDefined();
    if (hooks === undefined) return;
    expect(
      accepts(hostNotificationHooksSave.requestSchema, {
        ...hooks.legacyRequest,
        executableWriteGrant: null,
      }),
    ).toBe(false);
    // The 2.0 -> 1.0 downgrade (cross-major) is what lets a hook be saved on a
    // released host at all.
    expect(
      hostRpcRegistry["host.notificationHooks.save"][2]
        .downgradePathsFromLatest[1],
    ).toBeDefined();
  });

  it("RED PROOF ON A COPY: a hypothetical host.notificationHooks.save@1.1 carrying the 2.0 request throws DOWNGRADE_UNSUPPORTED toward 1.0", () => {
    // The copy: the 2.0 request schema installed as a 1.1 MINOR inside a
    // copied method registry. A same-major newer client is re-parsed with the
    // host minor's own schema, and 1.0's request is `.strict()`.
    const hypotheticalV11 = defineRpcContract({
      method: "host.notificationHooks.save",
      schemaVersion: { major: 1, minor: 1 },
      requestSchema: hostNotificationHooksSaveV20.requestSchema,
      responseSchema: hostNotificationHooksSaveV20.responseSchema,
    });
    const upgradeV10ToV11 = defineUpgradePath<
      typeof hostNotificationHooksSave,
      typeof hypotheticalV11
    >({
      from: { major: 1, minor: 0 },
      to: { major: 1, minor: 1 },
      upgradeRequest: (request) => ({ ...request, executableWriteGrant: null }),
      upgradeResponse: (response) => response,
    });
    const copiedRegistry = defineVersionedRpcRegistry({
      "host.notificationHooks.save": {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: hostNotificationHooksSave,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: hypotheticalV11,
              upgradeFromPreviousVersion: upgradeV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });
    const hooks = [
      {
        id: "h1",
        name: null,
        enabled: true,
        severities: null,
        action: { type: "command", command: "/bin/echo", args: [] },
      },
    ];
    for (const executableWriteGrant of [JWT_SHAPED_GRANT, null]) {
      expectDowngradeUnsupported(
        captureThrown(() =>
          prepareRequestPayload(
            copiedRegistry["host.notificationHooks.save"],
            { major: 1, minor: 1 },
            { major: 1, minor: 0 },
            { hooks, executableWriteGrant },
            "r-copy",
            "host.notificationHooks.save",
          ),
        ),
      );
    }
    // The real registry, where the grant rides a MAJOR, saves the same list.
    const prepared = prepareRequestPayload(
      hostRpcRegistry["host.notificationHooks.save"],
      { major: 2, minor: 0 },
      { major: 1, minor: 0 },
      { hooks, executableWriteGrant: JWT_SHAPED_GRANT },
      "r-real",
      "host.notificationHooks.save",
    );
    expect(prepared.onWirePayload).toEqual({ hooks });
  });
});

// ── (d) ─────────────────────────────────────────────────────────────────────

describe("promoteToPersonal toward a 1.2 host is refused, never dropped", () => {
  const promote = {
    kind: "promoteToPersonal",
    entryKind: "mcp",
    scope: "global",
    workspaceRoot: null,
    name: "x",
  };

  it("throws DOWNGRADE_UNSUPPORTED from 1.3 to 1.2 for a promoteToPersonal mutation", () => {
    const params = {
      providerId: "claude-code",
      mutation: promote,
      executableWriteGrant: null,
    };
    expect(
      accepts(
        hostRpcRegistry["providers.nativeMutate"][1].versions[3].contract
          .requestSchema,
        params,
      ),
    ).toBe(true);
    expect(accepts(providersNativeMutateV12.requestSchema, params)).toBe(false);
    expectDowngradeUnsupported(
      captureThrown(() =>
        prepareRequestPayload(
          hostRpcRegistry["providers.nativeMutate"],
          { major: 1, minor: 3 },
          { major: 1, minor: 2 },
          params,
          "r-promote",
          "providers.nativeMutate",
        ),
      ),
    );
  });

  it("passes a v1.2-shaped mutation from 1.3 to 1.2 with the grant stripped", () => {
    const legacyMutation = {
      kind: "mcp",
      scope: "global",
      workspaceRoot: null,
      mutation: { action: "remove", name: "x" },
    };
    const prepared = prepareRequestPayload(
      hostRpcRegistry["providers.nativeMutate"],
      { major: 1, minor: 3 },
      { major: 1, minor: 2 },
      {
        providerId: "claude-code",
        mutation: legacyMutation,
        executableWriteGrant: JWT_SHAPED_GRANT,
      },
      "r-legacy",
      "providers.nativeMutate",
    );
    expect(prepared.onWireVersion).toEqual({ major: 1, minor: 2 });
    expect(prepared.onWirePayload).toEqual({
      providerId: "claude-code",
      mutation: legacyMutation,
    });
  });

  it("delivers promoteToPersonal intact between two 1.3 peers", () => {
    const params = {
      providerId: "claude-code",
      mutation: promote,
      executableWriteGrant: JWT_SHAPED_GRANT,
    };
    const prepared = prepareRequestPayload(
      hostRpcRegistry["providers.nativeMutate"],
      { major: 1, minor: 3 },
      { major: 1, minor: 3 },
      params,
      "r-same",
      "providers.nativeMutate",
    );
    expect(prepared.onWirePayload).toEqual(params);
  });

  it("names the refusal with the typed floor the GUI shows in copy", () => {
    expect(PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION).toEqual({
      method: "providers.nativeMutate",
      version: { major: 1, minor: 3 },
    });
    expect(
      negotiatedVersionMeetsRequirement(
        { major: 1, minor: 2 },
        PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
      ),
    ).toBe(false);
    expect(
      negotiatedVersionMeetsRequirement(
        { major: 1, minor: 3 },
        PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
      ),
    ).toBe(true);
    expect(
      negotiatedVersionMeetsRequirement(
        undefined,
        PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
      ),
    ).toBe(false);
    // A different major is a break, not "higher".
    expect(
      negotiatedVersionMeetsRequirement(
        { major: 2, minor: 0 },
        PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
      ),
    ).toBe(false);
  });

  it("raises HostMethodVersionUnsatisfiedError carrying that requirement", () => {
    const error = new HostMethodVersionUnsatisfiedError({
      requirement: PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
      negotiated: { major: 1, minor: 0 },
      requestId: "r",
      method: "providers.nativeMutate",
      hostId: "h",
    });
    expect(error).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error.requirement).toEqual(
      PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
    );
    expect(error.negotiated).toEqual({ major: 1, minor: 0 });
    expect(error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });
});

// ── (e) ─────────────────────────────────────────────────────────────────────

const SECRET_ROTATION_STATES = [
  "accepted",
  "enforcing",
  "stalled",
  "enforced",
  "failed",
] as const;

describe("secret versions, Undo, Destroy, rotation and consent shapes, field for field", () => {
  // `GET .../secrets/:secretId/versions`: the versions list with ordinal,
  // created, superseded and destroyed times and the rotation state of each,
  // never a value. A rotation's state is `accepted` (committed), `enforcing` (a
  // receipt is missing), `stalled`, `enforced` or `failed`.
  it("environment.secrets.versions: ordinal, created, superseded, destroyed times and the rotation state of each, never a value", () => {
    const request = env.environmentSecretsVersionsRequestSchema.parse({
      secretId: "s1",
    });
    expect(request).toEqual({ secretId: "s1" });
    expect(accepts(env.environmentSecretsVersionsRequestSchema, {})).toBe(
      false,
    );

    const row = {
      versionId: "v2",
      ordinal: 2,
      createdAt: 1_791_000_000_000,
      supersededAt: null,
      destroyedAt: null,
      current: true,
      rotationState: "enforced",
    };
    const older = {
      ...row,
      versionId: "v1",
      ordinal: 1,
      supersededAt: 1_791_000_100_000,
      destroyedAt: 1_791_000_200_000,
      current: false,
      rotationState: null,
    };
    const parsed = env.environmentSecretsVersionsResponseSchema.parse({
      versions: [
        // A value the server must never send, even if it did: zod strips it.
        { ...row, value: "sk-live-secret", ciphertext: "AAAA" },
        older,
      ],
    });
    expect(parsed.versions).toHaveLength(2);
    for (const version of parsed.versions) {
      expect(sortedKeys(version)).toEqual([
        "createdAt",
        "current",
        "destroyedAt",
        "ordinal",
        "rotationState",
        "supersededAt",
        "versionId",
      ]);
      expect(version).not.toHaveProperty("value");
      expect(version).not.toHaveProperty("ciphertext");
    }
    expect(parsed.versions[0]?.current).toBe(true);
    expect(parsed.versions[1]?.destroyedAt).toBe(1_791_000_200_000);
    expect(parsed.versions[1]?.rotationState).toBeNull();

    // The rotation state is the wire's closed five.
    for (const rotationState of SECRET_ROTATION_STATES) {
      expect(
        accepts(env.environmentSecretsVersionsResponseSchema, {
          versions: [{ ...row, rotationState }],
        }),
        rotationState,
      ).toBe(true);
    }
    expect(
      accepts(env.environmentSecretsVersionsResponseSchema, {
        versions: [{ ...row, rotationState: "pending" }],
      }),
    ).toBe(false);
  });

  // `POST .../versions/:versionId/undo`: a rotation back to that version's
  // content under a fresh epoch, refused `version_destroyed` for a tombstone
  // (copy "that value was destroyed") and refused on a revoked secret unless
  // the same call re-grants.
  it("environment.secrets.undo: a rotation back to that version, `regrant` in the same action, refused version_destroyed", () => {
    expect(
      env.environmentSecretsUndoRequestSchema.parse({
        secretId: "s1",
        versionId: "v1",
        regrant: true,
      }),
    ).toEqual({ secretId: "s1", versionId: "v1", regrant: true });
    // `regrant` is the same-action re-grant: always stated, never implied.
    expect(
      accepts(env.environmentSecretsUndoRequestSchema, {
        secretId: "s1",
        versionId: "v1",
      }),
    ).toBe(false);

    // Undo is a rotation: its answer opens one (same ids as a value
    // replacement's), under a new version.
    expect(
      env.environmentSecretsUndoResponseSchema.parse({
        outcome: "accepted",
        rotationId: "rot-1",
        versionId: "v3",
      }),
    ).toEqual({ outcome: "accepted", rotationId: "rot-1", versionId: "v3" });

    expect(env.SECRET_UNDO_REFUSAL_CODES).toContain("version_destroyed");
    for (const code of env.SECRET_UNDO_REFUSAL_CODES) {
      expect(
        env.environmentSecretsUndoResponseSchema.parse({
          outcome: "refused",
          code,
        }),
        code,
      ).toEqual({ outcome: "refused", code });
    }
    expect(
      accepts(env.environmentSecretsUndoResponseSchema, {
        outcome: "refused",
      }),
    ).toBe(false);
  });

  // `POST .../versions/:versionId/destroy`: nulls a superseded version's sealed
  // columns at once, sets `destroyedAt`, deletes any `HostSealedValue` naming
  // it and records the event; refused `version_current` for the live version
  // until it is replaced or revoked (copy "replace or revoke it first").
  it("environment.secrets.destroy: destroys a superseded version at once, refused version_current for the live one", () => {
    expect(
      env.environmentSecretsDestroyRequestSchema.parse({
        secretId: "s1",
        versionId: "v1",
      }),
    ).toEqual({ secretId: "s1", versionId: "v1" });
    expect(
      env.environmentSecretsDestroyResponseSchema.parse({
        outcome: "destroyed",
        destroyedAt: 1_791_000_300_000,
      }),
    ).toEqual({ outcome: "destroyed", destroyedAt: 1_791_000_300_000 });

    expect(env.SECRET_DESTROY_REFUSAL_CODES).toContain("version_current");
    expect(
      env.environmentSecretsDestroyResponseSchema.parse({
        outcome: "refused",
        code: "version_current",
      }),
    ).toEqual({ outcome: "refused", code: "version_current" });
    // A destroy answer states when it happened: no destroy without the time.
    expect(
      accepts(env.environmentSecretsDestroyResponseSchema, {
        outcome: "destroyed",
      }),
    ).toBe(false);
  });

  // `GET .../secrets/:secretId/rotation`: the current rotation's state
  // (`accepted`, `enforcing`, `stalled`, `enforced`, `failed`) and, per host
  // and class, the evidence entries of its `rotation_ack` receipt, or
  // "contained by expiry" for an incarnation that is no longer live; and the
  // secret's last Verify result.
  // `evidence` is a list of `{ kind, count }` entries, one per kind the
  // producer can show, from a closed enum of three: `session_closed` (every
  // native session admitted under the old value is closed; `count` is the
  // number closed, nullable only for a class that holds no sessions),
  // `cache_cleared` (the sealed or cached value is evicted; `count` is the
  // number of cache entries dropped, never null, zero allowed), `probe_refused`
  // (the old value was probed against the service and refused; `count` is null,
  // one probe being one). A fence, a `fencedAt` and a deadline are never
  // evidence.
  // An incarnation whose authorization has provably ceased owes no receipt and
  // is shown "contained by expiry"; a host not delivered (asleep, suspended,
  // offline) owes none and shows "applies on resume".
  // `issuedAt` is the broker's clock at the controller's first send; sixty
  // seconds after `issuedAt` without `enforced`, the status turns `stalled`.
  it("environment.secrets.rotation: the wire's five states, three evidence kinds, worker and host producers, last Verify", () => {
    expect(
      env.environmentSecretsRotationRequestSchema.parse({ secretId: "s1" }),
    ).toEqual({ secretId: "s1" });

    const workerAcked = {
      producer: "worker",
      workerClass: "https",
      incarnation: "inc-1",
      status: "acknowledged",
      evidence: [
        { kind: "session_closed", count: 3 },
        { kind: "cache_cleared", count: 0 },
        { kind: "probe_refused", count: null },
      ],
    };
    const workerContained = {
      producer: "worker",
      workerClass: "signing",
      incarnation: "inc-2",
      status: "contained_by_expiry",
      evidence: null,
    };
    const hostAcked = {
      producer: "host",
      hostId: "h1",
      incarnation: "proc-1",
      status: "acknowledged",
      evidence: [{ kind: "cache_cleared", count: 1 }],
    };
    const hostOnResume = {
      producer: "host",
      hostId: "h2",
      incarnation: null,
      status: "applies_on_resume",
      evidence: null,
    };
    const rotation = {
      rotationId: "rot-1",
      fromVersionId: "v1",
      toVersionId: "v2",
      state: "enforcing",
      issuedAt: 1_791_000_000_000,
      producers: [workerAcked, workerContained, hostAcked, hostOnResume],
    };
    const parsed = env.environmentSecretsRotationResponseSchema.parse({
      rotation,
      lastVerify: {
        result: { evidence: "probe_refused", hop: "login" },
        at: 1_791_000_050_000,
      },
    });
    expect(parsed.rotation?.state).toBe("enforcing");
    expect(parsed.rotation?.producers).toHaveLength(4);
    expect(parsed.lastVerify).toEqual({
      result: { evidence: "probe_refused", hop: "login" },
      at: 1_791_000_050_000,
    });

    // The states: exactly the wire's five.
    for (const state of SECRET_ROTATION_STATES) {
      expect(
        accepts(env.environmentSecretsRotationResponseSchema, {
          rotation: { ...rotation, state },
          lastVerify: null,
        }),
        state,
      ).toBe(true);
    }
    expect(
      accepts(env.environmentSecretsRotationResponseSchema, {
        rotation: { ...rotation, state: "pending" },
        lastVerify: null,
      }),
    ).toBe(false);
    expect([...env.secretRotationStateSchema.options].sort()).toEqual(
      [...SECRET_ROTATION_STATES].sort(),
    );

    // Evidence kinds: exactly the closed three; a fence is never evidence.
    for (const entry of [
      { kind: "session_closed", count: 1 },
      { kind: "cache_cleared", count: 1 },
      { kind: "probe_refused", count: null },
    ]) {
      expect(accepts(env.rotationEvidenceSchema, entry), entry.kind).toBe(true);
    }
    for (const kind of ["fenced", "fencedAt", "deadline"]) {
      expect(
        accepts(env.rotationEvidenceSchema, { kind, count: 1 }),
        kind,
      ).toBe(false);
    }
    // Evidence count: null (no sessions, or one probe) and a truthful zero.
    expect(
      accepts(env.rotationEvidenceSchema, {
        kind: "session_closed",
        count: null,
      }),
    ).toBe(true);
    expect(
      accepts(env.rotationEvidenceSchema, { kind: "cache_cleared", count: 0 }),
    ).toBe(true);
    // Per kind, as the Evidence row gives it: `cache_cleared` is "never
    // null"; `probe_refused` "is null, one probe being one".
    expect(
      accepts(env.rotationEvidenceSchema, {
        kind: "cache_cleared",
        count: null,
      }),
    ).toBe(false);
    expect(
      accepts(env.rotationEvidenceSchema, { kind: "probe_refused", count: 1 }),
    ).toBe(false);
    expect(
      accepts(env.rotationEvidenceSchema, {
        kind: "session_closed",
        count: -1,
      }),
    ).toBe(false);
    expect(
      accepts(env.rotationEvidenceSchema, {
        kind: "session_closed",
        count: 1.5,
      }),
    ).toBe(false);

    // A producer is a worker (contained by expiry) or a host (applies on
    // resume); the two statuses do not cross.
    expect(accepts(env.rotationProducerSchema, workerContained)).toBe(true);
    expect(accepts(env.rotationProducerSchema, hostOnResume)).toBe(true);
    expect(
      accepts(env.rotationProducerSchema, {
        ...workerContained,
        status: "applies_on_resume",
      }),
    ).toBe(false);
    expect(
      accepts(env.rotationProducerSchema, {
        ...hostOnResume,
        status: "contained_by_expiry",
      }),
    ).toBe(false);
    expect(
      accepts(env.rotationProducerSchema, {
        ...hostAcked,
        producer: "gateway",
      }),
    ).toBe(false);
    // A missing receipt is what keeps a rotation `enforcing`.
    expect(
      accepts(env.rotationProducerSchema, {
        ...workerAcked,
        status: "missing",
        evidence: null,
      }),
    ).toBe(true);

    // No rotation yet, and no Verify yet, are both states of a secret.
    expect(
      env.environmentSecretsRotationResponseSchema.parse({
        rotation: null,
        lastVerify: null,
      }),
    ).toEqual({ rotation: null, lastVerify: null });
    // `issuedAt` is null before the controller's first send.
    expect(
      accepts(env.environmentSecretsRotationResponseSchema, {
        rotation: {
          ...rotation,
          state: "accepted",
          issuedAt: null,
          producers: [],
        },
        lastVerify: null,
      }),
    ).toBe(true);
  });

  // `POST .../secrets/:secretId/consent` records the acceptance for the
  // disclosure version shown, the scope and the authenticated actor; the
  // create route calls it for the consent checkbox, so no secret is created
  // with a consent that has no evidence. `disclosure` is a closed enum
  // (`plaintext_gateway`), `disclosureVersion` is the version of the disclosure
  // text that was shown, and `scope` is `secret` or `environment` (what the
  // acceptance covers). The actor is server-side, never a request field.
  it("environment.secrets.consent: disclosure, version shown and scope, and no actor on the request", () => {
    const request = {
      secretId: "s1",
      disclosure: "plaintext_gateway",
      disclosureVersion: 2,
      scope: "secret",
    };
    expect(env.SECRET_CONSENT_DISCLOSURES).toContain("plaintext_gateway");
    expect(env.environmentSecretsConsentRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(
      env.environmentSecretsConsentRequestSchema.parse({
        ...request,
        scope: "environment",
      }),
    ).toHaveProperty("scope", "environment");

    // Scope: secret or environment only.
    for (const scope of ["team", "host", "user", ""]) {
      expect(
        accepts(env.environmentSecretsConsentRequestSchema, {
          ...request,
          scope,
        }),
        scope,
      ).toBe(false);
    }
    // The version shown is a non-negative integer, and is required.
    expect(
      accepts(env.environmentSecretsConsentRequestSchema, {
        ...request,
        disclosureVersion: -1,
      }),
    ).toBe(false);
    expect(
      accepts(env.environmentSecretsConsentRequestSchema, {
        secretId: "s1",
        disclosure: "plaintext_gateway",
        scope: "secret",
      }),
    ).toBe(false);

    // No actor on the request: a caller-supplied one is stripped, so it can
    // never reach what the server records.
    const withActor = env.environmentSecretsConsentRequestSchema.parse({
      ...request,
      actorRef: "user:someone-else",
      actor: "someone-else",
      actorId: "someone-else",
    });
    expect(sortedKeys(withActor)).toEqual([
      "disclosure",
      "disclosureVersion",
      "scope",
      "secretId",
    ]);

    // The answer names the acceptance and when it was accepted.
    expect(
      env.environmentSecretsConsentResponseSchema.parse({
        acceptanceId: "acc-1",
        acceptedAt: 1_791_000_000_000,
      }),
    ).toEqual({ acceptanceId: "acc-1", acceptedAt: 1_791_000_000_000 });
  });

  // Verify makes one request or handshake to the bound destination through the
  // path a sandbox would take and answers with one evidence receipt:
  // `probe_accepted`, or `probe_refused` with a closed hop code (`host`,
  // `port`, `protocol` or `login`), never the value or the upstream's body. It
  // runs from the Secrets page's action on a row, and on the add dialog before
  // the secret exists; `unreachable` is the silent-incarnation answer (see
  // `environmentSecretsVerifyRequestSchema`'s comment).
  it("environment.secrets.verify: probe_accepted, probe_refused with a closed hop, unreachable; never the value or a body", () => {
    expect(
      env.environmentSecretsVerifyRequestSchema.parse({
        target: "secret",
        secretId: "s1",
      }),
    ).toEqual({ target: "secret", secretId: "s1" });
    const httpsCandidate = { ...baseBinding, value: "sk-candidate" };
    expect(
      env.environmentSecretsVerifyRequestSchema.parse({
        target: "candidate",
        ...httpsCandidate,
      }),
    ).toEqual({ target: "candidate", ...httpsCandidate });
    // The value is required (null for SSH), never absent.
    const { value: _omittedValue, ...candidateWithoutValue } = httpsCandidate;
    expect(
      accepts(env.environmentSecretsVerifyRequestSchema, {
        target: "candidate",
        ...candidateWithoutValue,
      }),
    ).toBe(false);
    // The old candidate shape (`destinations`, no `hosts`) is refused.
    expect(
      accepts(env.environmentSecretsVerifyRequestSchema, {
        target: "candidate",
        protocol: "https",
        destinations: ["api.example.com"],
        value: "sk-candidate",
      }),
    ).toBe(false);
    // A full database candidate parses on the candidate arm.
    expect(
      env.environmentSecretsVerifyRequestSchema.parse({
        target: "candidate",
        ...databaseBinding,
      }),
    ).toEqual({ target: "candidate", ...databaseBinding });
    // An SSH candidate carries no value, plus pinned host keys and a policy.
    expect(
      env.environmentSecretsVerifyRequestSchema.parse({
        target: "candidate",
        ...sshBinding,
      }),
    ).toEqual({ target: "candidate", ...sshBinding });
    // The shared fields are bounded on this arm too.
    for (const hosts of [[], Array.from({ length: 17 }, (_, i) => `h${i}`)]) {
      expect(
        accepts(env.environmentSecretsVerifyRequestSchema, {
          target: "candidate",
          ...httpsCandidate,
          hosts,
        }),
        `${hosts.length} hosts`,
      ).toBe(false);
    }

    expect(
      env.environmentSecretsVerifyResponseSchema.parse({
        evidence: "probe_accepted",
      }),
    ).toEqual({ evidence: "probe_accepted" });
    expect(
      env.environmentSecretsVerifyResponseSchema.parse({
        evidence: "unreachable",
      }),
    ).toEqual({ evidence: "unreachable" });
    for (const hop of ["host", "port", "protocol", "login"]) {
      expect(
        env.environmentSecretsVerifyResponseSchema.parse({
          evidence: "probe_refused",
          hop,
        }),
        hop,
      ).toEqual({ evidence: "probe_refused", hop });
    }
    for (const hop of ["dns", "timeout", "tls", ""]) {
      expect(
        accepts(env.environmentSecretsVerifyResponseSchema, {
          evidence: "probe_refused",
          hop,
        }),
        hop,
      ).toBe(false);
    }
    expect(
      accepts(env.environmentSecretsVerifyResponseSchema, {
        evidence: "probe_refused",
      }),
    ).toBe(false);
    expect(
      accepts(env.environmentSecretsVerifyResponseSchema, {
        evidence: "probe_rejected",
      }),
    ).toBe(false);
    // Never the value or the upstream's body: neither survives the parse.
    const stripped = env.environmentSecretsVerifyResponseSchema.parse({
      evidence: "probe_refused",
      hop: "login",
      value: "sk-candidate",
      body: "401 Unauthorized: bad key",
    });
    expect(sortedKeys(stripped)).toEqual(["evidence", "hop"]);
  });

  // The add dialog creates a database, SSH or connector secret, so the
  // create request carries the same binding fields as the verify candidate.
  it("environment.secrets.create: the binding fields, hosts not destinations, authn validates kind and protocol", () => {
    const schema = env.environmentSecretsCreateRequestSchema;
    const database = { ...createOptions, ...databaseBinding };
    const ssh = {
      ...createOptions,
      ...sshBinding,
      name: "BASTION",
      swapSites: ["header"],
    };

    // A full database request parses and round-trips unchanged.
    expect(schema.parse(database)).toEqual(database);
    // An SSH request carries a null value, pinned host keys and a policy.
    expect(schema.parse(ssh)).toEqual(ssh);

    // The same database binding parses on both arms.
    expect(
      accepts(env.environmentSecretsVerifyRequestSchema, {
        target: "candidate",
        ...databaseBinding,
      }),
    ).toBe(true);
    expect(accepts(schema, database)).toBe(true);

    // The old request shape (`destinations`, no `hosts`) is refused.
    const { hosts: _hosts, ...withoutHosts } = database;
    expect(
      accepts(schema, { ...withoutHosts, destinations: ["db.example.com"] }),
    ).toBe(false);
    expect(accepts(schema, withoutHosts)).toBe(false);
    // `destinations` beside `hosts` is not read.
    expect(
      sortedKeys(
        schema.parse({ ...database, destinations: ["x.example.com"] }),
      ),
    ).not.toContain("destinations");

    // Hosts: one to sixteen.
    for (const count of [0, 17]) {
      expect(
        accepts(schema, {
          ...database,
          hosts: Array.from({ length: count }, (_, i) => `h${i}.example.com`),
        }),
        `${count} hosts`,
      ).toBe(false);
    }
    for (const count of [1, 16]) {
      expect(
        accepts(schema, {
          ...database,
          hosts: Array.from({ length: count }, (_, i) => `h${i}.example.com`),
        }),
        `${count} hosts`,
      ).toBe(true);
    }

    // Port: null or 1..65535.
    for (const port of [0, 65_536, 1.5]) {
      expect(accepts(schema, { ...database, port }), String(port)).toBe(false);
    }
    for (const port of [null, 1, 65_535]) {
      expect(accepts(schema, { ...database, port }), String(port)).toBe(true);
    }

    // kind and protocol are open strings here: authn validates them.
    expect(
      schema.parse({
        ...database,
        kind: "not-a-kind-yet",
        protocol: "not-a-protocol-yet",
      }),
    ).toMatchObject({ kind: "not-a-kind-yet", protocol: "not-a-protocol-yet" });
    expect(accepts(schema, { ...database, kind: "" })).toBe(false);
    expect(accepts(schema, { ...database, protocol: "" })).toBe(false);

    // policy and tlsPolicy pass through as records, unchanged.
    const policy = { nested: { allow: ["a", "b"] }, limit: 3, flag: true };
    const tlsPolicy = { mode: "verify-full", caBundle: null };
    const passed = schema.parse({ ...database, policy, tlsPolicy });
    expect(passed.policy).toEqual(policy);
    expect(passed.tlsPolicy).toEqual(tlsPolicy);
    expect(accepts(schema, { ...database, policy: "strict" })).toBe(false);
    expect(accepts(schema, { ...database, tlsPolicy: [1] })).toBe(false);

    // pinnedHostKeys: records, at most sixteen.
    const keys = Array.from({ length: 16 }, (_, i) => ({
      fingerprint: `k${i}`,
    }));
    expect(accepts(schema, { ...ssh, pinnedHostKeys: keys })).toBe(true);
    expect(
      accepts(schema, {
        ...ssh,
        pinnedHostKeys: [...keys, { fingerprint: "k16" }],
      }),
    ).toBe(false);
    expect(accepts(schema, { ...ssh, pinnedHostKeys: ["SHA256:abc"] })).toBe(
      false,
    );

    // confirmedAddresses: strings of 2..64, at most sixteen.
    expect(accepts(schema, { ...ssh, confirmedAddresses: ["a"] })).toBe(false);
    expect(
      accepts(schema, { ...ssh, confirmedAddresses: ["a".repeat(65)] }),
    ).toBe(false);
    expect(
      accepts(schema, {
        ...ssh,
        confirmedAddresses: Array.from({ length: 17 }, () => "10.0.0.1"),
      }),
    ).toBe(false);

    // value: null or 1..65536 characters, and never absent.
    expect(accepts(schema, { ...database, value: "" })).toBe(false);
    expect(accepts(schema, { ...database, value: "v".repeat(65_536) })).toBe(
      true,
    );
    expect(accepts(schema, { ...database, value: "v".repeat(65_537) })).toBe(
      false,
    );
    const { value: _value, ...withoutValue } = database;
    expect(accepts(schema, withoutValue)).toBe(false);

    // swapSites: one to three; variables: at most sixteen.
    expect(accepts(schema, { ...database, swapSites: [] })).toBe(false);
    expect(
      accepts(schema, {
        ...database,
        swapSites: ["header", "query", "body", "extra"],
      }),
    ).toBe(false);
    expect(
      accepts(schema, {
        ...database,
        swapSites: ["header", "query", "body"],
      }),
    ).toBe(true);
    expect(
      accepts(schema, {
        ...database,
        variables: Array.from({ length: 17 }, (_, i) => ({
          name: `V${i}`,
          dialect: "postgres_url",
        })),
      }),
    ).toBe(false);
    expect(accepts(schema, { ...database, variables: [] })).toBe(true);
    expect(accepts(schema, { ...database, exportPolicy: "none" })).toBe(true);
    expect(accepts(schema, { ...database, portOverride: "yes" })).toBe(false);
    expect(
      accepts(schema, { ...database, sandboxesByDefault: undefined }),
    ).toBe(false);
    expect(
      accepts(schema, {
        ...database,
        plaintextConsent: { disclosureVersion: 2 },
      }),
    ).toBe(true);
  });

  // The two additional refusal codes are accepted on the undo answer.
  it("environment.secrets.undo: version_current and secret_version_stale are refusal codes", () => {
    for (const code of ["version_current", "secret_version_stale"]) {
      expect(env.SECRET_UNDO_REFUSAL_CODES).toContain(code);
      expect(
        env.environmentSecretsUndoResponseSchema.parse({
          outcome: "refused",
          code,
        }),
      ).toEqual({ outcome: "refused", code });
    }
    // The code is an open string on the wire: a code a newer host adds still
    // parses, and the client shows the refusal's own message for it.
    expect(
      env.environmentSecretsUndoResponseSchema.parse({
        outcome: "refused",
        code: "a_code_added_later",
      }),
    ).toEqual({ outcome: "refused", code: "a_code_added_later" });
    expect(
      accepts(env.environmentSecretsUndoResponseSchema, {
        outcome: "refused",
        code: "",
      }),
    ).toBe(false);
  });
});

// ── (f) the redesign's @1.1 MINORs, upgraded through the registry ───────────

const ONE_ZERO = { major: 1, minor: 0 } as const;
const ONE_ONE = { major: 1, minor: 1 } as const;

const STATUS_V10 = {
  principal: { kind: "team", teamName: "acme" },
  reachability: "connected",
  bindingGeneration: 2,
  desiredRevision: 5,
  receivedRevision: 5,
  appliedRevision: 4,
  receiptAgeMs: 1200,
  items: [],
  pendingUploads: [],
  setup: { stage: "applying", state: "running" },
  remoteAccess: "on",
};

const REVIEW_ENTRY = {
  entryId: "e1",
  reason: "needs_grant",
  kind: "variable",
  key: "API_KEY",
  os: "any",
  hostId: null,
  heldAt: 1_700_000_000_000,
};

describe("environment.status@1.1 and environment.review@1.1 upgrade from @1.0 to exactly their defaults", () => {
  it("upgrades a status answer with no consent, every plane moved, no return from a team and not stopped", () => {
    const v10 =
      hostRpcRegistry[
        "environment.status"
      ][1].versions[0].contract.responseSchema.parse(STATUS_V10);
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["environment.status"],
      ONE_ZERO,
      ONE_ONE,
      v10,
    );
    expect(upgraded).toEqual({
      ...v10,
      consent: null,
      planes: { records: "moved", broker: "moved", room: "moved" },
      returnedFromTeam: null,
      stoppedAt: null,
    });
    // The upgrade lands on a value the @1.1 contract itself accepts.
    expect(
      hostRpcRegistry[
        "environment.status"
      ][1].versions[1].contract.responseSchema.parse(upgraded),
    ).toEqual(upgraded);
  });

  it("leaves the status request untouched", () => {
    expect(
      upgradeRequestToVersion(
        hostRpcRegistry["environment.status"],
        ONE_ZERO,
        ONE_ONE,
        {},
      ),
    ).toEqual({});
  });

  it("parses a status answer that names the move's consent, a stopped plane and a stop time", () => {
    const answer = {
      ...STATUS_V10,
      setup: { stage: "moving_settings", state: "awaiting_consent" },
      consent: { acceptedAt: 1_700_000_000_000, planHash: "h1" },
      planes: {
        records: "local",
        broker: "shared_unrecorded",
        room: "stopped",
      },
      returnedFromTeam: { at: 1_700_000_000_001 },
      stoppedAt: 1_700_000_000_002,
    };
    expect(
      hostRpcRegistry[
        "environment.status"
      ][1].versions[1].contract.responseSchema.parse(answer),
    ).toEqual(answer);
    expect(
      hostRpcRegistry[
        "environment.status"
      ][1].versions[1].contract.responseSchema.safeParse({
        ...answer,
        planes: { ...answer.planes, room: "elsewhere" },
      }).success,
    ).toBe(false);
  });

  it("upgrades a review answer as a sheet never shown, never acknowledged, with no evidence", () => {
    const v10 = hostRpcRegistry[
      "environment.review"
    ][1].versions[0].contract.responseSchema.parse({ entries: [REVIEW_ENTRY] });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["environment.review"],
      ONE_ZERO,
      ONE_ONE,
      v10,
    );
    expect(upgraded).toEqual({
      entries: [REVIEW_ENTRY],
      shownAt: null,
      acknowledgedAt: null,
      evidence: { version: null, at: null },
    });
    expect(
      hostRpcRegistry[
        "environment.review"
      ][1].versions[1].contract.responseSchema.parse(upgraded),
    ).toEqual(upgraded);
  });
});

describe("environment.review@1.2 names what a held executable runs", () => {
  const line = hostRpcRegistry["environment.review"][1];
  const v11Answer = {
    entries: [
      { ...REVIEW_ENTRY, reason: "executable_entry", kind: "mcp_server" },
    ],
    shownAt: null,
    acknowledgedAt: null,
    evidence: { version: null, at: null },
  };

  it("opens @1.2 after @1.1, with the upgrade between them", () => {
    expect(line.versions[2].contract).toBe(environmentReviewV12);
    expect(line.versions[2].upgradeFromPreviousVersion).toBe(
      environmentReviewUpgradeV11ToV12,
    );
  });

  it("upgrades a @1.1 answer with none of an entry's facts", () => {
    const v11 = environmentReviewV11.responseSchema.parse(v11Answer);
    const upgraded = environmentReviewUpgradeV11ToV12.upgradeResponse(v11);
    expect(upgraded.entries).toEqual([
      {
        ...v11Answer.entries[0],
        command: null,
        event: null,
        description: null,
        harness: null,
        value: null,
      },
    ]);
    expect(environmentReviewV12.responseSchema.parse(upgraded)).toEqual(
      upgraded,
    );
  });

  it("keeps each fact as sent, defaults all to null, and refuses an empty one", () => {
    const parse = (entry: object) =>
      environmentReviewV12.responseSchema.parse({
        ...v11Answer,
        entries: [{ ...v11Answer.entries[0], ...entry }],
      }).entries[0];
    expect(
      parse({ command: "node hook.js --loud", event: "Notification" }),
    ).toMatchObject({ command: "node hook.js --loud", event: "Notification" });
    expect(
      parse({ description: "reviewing pull requests", harness: "claude" }),
    ).toMatchObject({
      description: "reviewing pull requests",
      harness: "claude",
    });
    expect(parse({ value: "--inspect" })).toMatchObject({ value: "--inspect" });
    expect(parse({})).toMatchObject({
      command: null,
      event: null,
      description: null,
      harness: null,
      value: null,
    });
    for (const field of ["command", "description", "harness", "value"]) {
      expect(
        environmentReviewV12.responseSchema.safeParse({
          ...v11Answer,
          entries: [{ ...v11Answer.entries[0], [field]: "" }],
        }).success,
      ).toBe(false);
    }
  });
});

describe("environment.review.heldApply and environment.review.record", () => {
  const heldApply =
    hostRpcRegistry["environment.review.heldApply"][1].versions[0].contract;
  const record =
    hostRpcRegistry["environment.review.record"][1].versions[0].contract;
  const secretArm = {
    heldId: "held-1",
    choice: "secret",
    kind: "api_key",
    protocol: "https",
    hosts: ["api.example.com"],
    port: null,
    portOverride: false,
    swapSites: ["header"],
    plaintextConsent: { disclosureVersion: 1 },
  };

  it("registers both off the released floor with unsupported degrade, major 1", () => {
    for (const method of [
      "environment.review.heldApply",
      "environment.review.record",
    ] as const) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      expect(releasedMethodNames).not.toContain(method);
      expect(registryShapeOf(hostRpcRegistry[method])).toBe(
        "degrade=unsupported majors=1 latestMinor=0 minors=0",
      );
    }
  });

  it("takes the secret arm's binding when the choice is secret, and refuses the choice without it", () => {
    expect(heldApply.requestSchema.parse(secretArm)).toEqual(secretArm);
    expect(
      accepts(heldApply.requestSchema, { heldId: "held-1", choice: "secret" }),
    ).toBe(false);
    for (const bad of [
      { ...secretArm, hosts: [] },
      { ...secretArm, swapSites: [] },
      { ...secretArm, swapSites: ["cookie"] },
      { ...secretArm, port: 0 },
      { ...secretArm, protocol: "gopher" },
      { ...secretArm, kind: "pgp" },
    ]) {
      expect(accepts(heldApply.requestSchema, bad)).toBe(false);
    }
  });

  it("takes only the held id for the plain choices, dropping a binding sent with them", () => {
    for (const choice of ["variable", "stays", "discard", "approve"] as const) {
      expect(
        heldApply.requestSchema.parse({ heldId: "held-1", choice }),
      ).toEqual({ heldId: "held-1", choice });
    }
    expect(
      heldApply.requestSchema.parse({
        ...secretArm,
        choice: "variable",
      }),
    ).toEqual({ heldId: "held-1", choice: "variable" });
    expect(
      accepts(heldApply.requestSchema, { heldId: "", choice: "variable" }),
    ).toBe(false);
    expect(
      accepts(heldApply.requestSchema, { heldId: "held-1", choice: "keep" }),
    ).toBe(false);
  });

  it("answers applied, gone or forbidden, and nothing carrying the held value", () => {
    for (const outcome of ["applied", "gone", "forbidden"] as const) {
      expect(heldApply.responseSchema.parse({ outcome })).toEqual({ outcome });
    }
    expect(
      heldApply.responseSchema.parse({
        outcome: "applied",
        value: "sk-live-1",
      }),
    ).toEqual({ outcome: "applied" });
    expect(accepts(heldApply.responseSchema, { outcome: "pending" })).toBe(
      false,
    );
  });

  it("records a shown or acknowledged sheet, and answers recorded or not_shared", () => {
    for (const event of ["shown", "acknowledged"] as const) {
      expect(record.requestSchema.parse({ event })).toEqual({ event });
    }
    expect(accepts(record.requestSchema, { event: "dismissed" })).toBe(false);
    expect(accepts(record.requestSchema, {})).toBe(false);
    for (const outcome of ["recorded", "not_shared"] as const) {
      expect(record.responseSchema.parse({ outcome })).toEqual({ outcome });
    }
    expect(accepts(record.responseSchema, { outcome: "ignored" })).toBe(false);
  });
});

describe("environment.secrets.* @1.1 requests gain environmentId: null through the registry", () => {
  const cases: ReadonlyArray<{
    readonly method: string;
    readonly request: Record<string, unknown>;
    readonly upgrade: (request: unknown) => unknown;
    readonly v11: z.ZodType;
  }> = [
    {
      method: "environment.secrets.list",
      request: {},
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.list"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsListRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsListRequestSchemaV11,
    },
    {
      method: "environment.secrets.create",
      request: { ...databaseBinding, ...createOptions },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.create"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsCreateRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsCreateRequestSchemaV11,
    },
    {
      method: "environment.secrets.verify",
      request: { target: "secret", secretId: "s1" },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.verify"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsVerifyRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsVerifyRequestSchemaV11,
    },
    {
      method: "environment.secrets.replaceValue",
      request: { secretId: "s1", value: "v", expectedVersionId: "ver1" },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.replaceValue"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsReplaceValueRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsReplaceValueRequestSchemaV11,
    },
    {
      method: "environment.secrets.versions",
      request: { secretId: "s1" },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.versions"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsVersionsRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsVersionsRequestSchemaV11,
    },
    {
      method: "environment.secrets.undo",
      request: { secretId: "s1", versionId: "ver1", regrant: false },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.undo"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsUndoRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsUndoRequestSchemaV11,
    },
    {
      method: "environment.secrets.destroy",
      request: { secretId: "s1", versionId: "ver1" },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.destroy"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsDestroyRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsDestroyRequestSchemaV11,
    },
    {
      method: "environment.secrets.rotation",
      request: { secretId: "s1" },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.rotation"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsRotationRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsRotationRequestSchemaV11,
    },
    {
      method: "environment.secrets.consent",
      request: {
        secretId: "s1",
        disclosure: "plaintext_gateway",
        disclosureVersion: 1,
        scope: "secret",
      },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["environment.secrets.consent"],
          ONE_ZERO,
          ONE_ONE,
          env.environmentSecretsConsentRequestSchema.parse(request),
        ),
      v11: env.environmentSecretsConsentRequestSchemaV11,
    },
    {
      method: "providers.link",
      request: { providerId: "claude-code", profileId: null },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["providers.link"],
          ONE_ZERO,
          ONE_ONE,
          env.providersLinkRequestSchema.parse(request),
        ),
      v11: env.providersLinkRequestSchemaV11,
    },
    {
      method: "providers.linkComplete",
      request: { linkId: "l1", code: null },
      upgrade: (request) =>
        upgradeRequestToVersion(
          hostRpcRegistry["providers.linkComplete"],
          ONE_ZERO,
          ONE_ONE,
          env.providersLinkCompleteRequestSchema.parse(request),
        ),
      v11: env.providersLinkCompleteRequestSchemaV11,
    },
  ];

  it.each(cases.map((c) => [c.method, c] as const))(
    "%s: an @1.0 request upgrades to the same request plus environmentId: null, and the @1.1 schema accepts it",
    (_method, wire) => {
      const upgraded = wire.upgrade(wire.request);
      // Same request, one key added: the @1.0 request is a subset of the result.
      expect(upgraded).toMatchObject(wire.request);
      expect(Object.keys(upgraded as object).sort()).toEqual(
        [...Object.keys(wire.request), "environmentId"].sort(),
      );
      expect(upgraded).toHaveProperty("environmentId", null);
      expect(wire.v11.parse(upgraded)).toEqual(upgraded);
      // The @1.1 schema also takes an addressed environment, and refuses an empty one.
      expect(
        accepts(wire.v11, { ...wire.request, environmentId: "env_team_1" }),
      ).toBe(true);
      expect(accepts(wire.v11, { ...wire.request, environmentId: "" })).toBe(
        false,
      );
    },
  );

  it("covers every environment.secrets.* method and both link methods", () => {
    expect(cases.map((c) => c.method).sort()).toEqual(
      [
        ...ENVIRONMENT_METHOD_NAMES.filter((name) =>
          name.startsWith("environment.secrets."),
        ),
        "providers.link",
        "providers.linkComplete",
      ].sort(),
    );
  });

  it("answers environment.secrets.versions with the removal that follows, null from an @1.0 host", () => {
    const v10 = env.environmentSecretsVersionsResponseSchema.parse({
      versions: [],
    });
    expect(
      upgradeResponseToVersion(
        hostRpcRegistry["environment.secrets.versions"],
        ONE_ZERO,
        ONE_ONE,
        v10,
      ),
    ).toEqual({ versions: [], removal: null });
    const removal = {
      outcome: "cleanup_requested",
      revokedAt: 1_700_000_000_000,
      destroyedAt: null,
      targets: [
        {
          target: "host",
          hostId: "host-1",
          hostName: "studio",
          state: "requested",
          at: 1_700_000_000_001,
        },
        {
          target: "broker_current",
          hostId: null,
          hostName: null,
          state: "confirmed",
          at: 1_700_000_000_002,
        },
      ],
    };
    expect(
      env.environmentSecretsVersionsResponseSchemaV11.parse({
        versions: [],
        removal,
      }).removal,
    ).toEqual(removal);
    expect(
      accepts(env.environmentSecretsVersionsResponseSchemaV11, {
        versions: [],
        removal: { ...removal, outcome: "vaporized" },
      }),
    ).toBe(false);
  });

  it("answers environment.secrets.list with no removed secrets from an @1.0 host, and the removed ones when it has them", () => {
    const v10 = env.environmentSecretsListResponseSchema.parse({ secrets: [] });
    expect(
      upgradeResponseToVersion(
        hostRpcRegistry["environment.secrets.list"],
        ONE_ZERO,
        ONE_ONE,
        v10,
      ),
    ).toEqual({ secrets: [], removed: [] });
    const removed = {
      id: "s1",
      name: "PROD_DB",
      removal: {
        outcome: "revoked",
        revokedAt: 1,
        destroyedAt: null,
        targets: [],
      },
    };
    expect(
      env.environmentSecretsListResponseSchemaV11.parse({
        secrets: [],
        removed: [removed],
      }).removed,
    ).toEqual([removed]);
    expect(
      accepts(env.environmentSecretsListResponseSchemaV11, {
        secrets: [],
        removed: [{ ...removed, name: "" }],
      }),
    ).toBe(false);
  });
});

// ── (g) providers.nativeMutate@1.4 ──────────────────────────────────────────

describe("providers.nativeMutate@1.3 to @1.4 fences an edit to its environment", () => {
  const line = hostRpcRegistry["providers.nativeMutate"][1];
  const legacyRequest = {
    providerId: "claude-code",
    mutation: {
      kind: "mcp",
      scope: "global",
      workspaceRoot: null,
      mutation: { action: "remove", name: "x" },
    },
    executableWriteGrant: null,
  };
  const mismatch = {
    result: { ok: false, code: "environment_mismatch", detail: null },
  };

  it("upgrades a @1.3 request to an unfenced one: expectedEnvironmentId null", () => {
    const v13 = line.versions[3].contract.requestSchema.parse(legacyRequest);
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["providers.nativeMutate"],
      { major: 1, minor: 3 },
      { major: 1, minor: 4 },
      v13,
    );
    expect(upgraded).toEqual({ ...v13, expectedEnvironmentId: null });
    expect(line.versions[4].contract.requestSchema.parse(upgraded)).toEqual(
      upgraded,
    );
  });

  it("carries a fence on @1.4 and refuses an empty one", () => {
    const fenced = {
      ...legacyRequest,
      expectedEnvironmentId: "env_01J0000000000000000000002",
    };
    expect(
      line.versions[4].contract.requestSchema.parse(fenced),
    ).toHaveProperty("expectedEnvironmentId", "env_01J0000000000000000000002");
    expect(
      accepts(line.versions[4].contract.requestSchema, {
        ...legacyRequest,
        expectedEnvironmentId: "",
      }),
    ).toBe(false);
  });

  it("parses the environment_mismatch refusal on @1.4 and rejects it on @1.3", () => {
    expect(line.versions[4].contract.responseSchema.parse(mismatch)).toEqual(
      mismatch,
    );
    expect(accepts(line.versions[3].contract.responseSchema, mismatch)).toBe(
      false,
    );
    // Every code @1.3 answers is still answered on @1.4.
    const stillAnswered = {
      result: { ok: false, code: "server_not_found", detail: "x" },
    };
    expect(
      accepts(line.versions[3].contract.responseSchema, stillAnswered),
    ).toBe(true);
    expect(
      accepts(line.versions[4].contract.responseSchema, stillAnswered),
    ).toBe(true);
  });
});

// ── (h) the growth gate ─────────────────────────────────────────────────────

describe("responseGrowthProjectionGated on the minors that grow a response value", () => {
  const gated: ReadonlyArray<readonly [string, MethodVersionRegistry, number]> =
    [
      ["environment.host.list", hostRpcRegistry["environment.host.list"], 1],
      [
        "environment.secrets.destroy",
        hostRpcRegistry["environment.secrets.destroy"],
        1,
      ],
      ["providers.nativeMutate", hostRpcRegistry["providers.nativeMutate"], 4],
    ];

  it.each(gated)(
    "%s declares the gate on its grown minor and not on @1.0",
    (_method, registry, minor) => {
      expect(registry[1].versions[minor]).toHaveProperty(
        "responseGrowthProjectionGated",
        true,
      );
      expect(registry[1].versions[0]).not.toHaveProperty(
        "responseGrowthProjectionGated",
      );
    },
  );

  it.each(gated)(
    "%s: the registry validates with the gate and refuses to validate without it",
    (method, registry, minor) => {
      expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
      const line = registry[1];
      const { responseGrowthProjectionGated: _gate, ...ungated } =
        line.versions[minor];
      const copy = {
        [method]: {
          degrade: { kind: "unsupported" },
          1: {
            ...line,
            versions: { ...line.versions, [minor]: ungated },
          },
        },
      };
      expect(() => validateVersionedRpcRegistry(copy as never)).toThrow(
        /responseGrowthProjectionGated/,
      );
    },
  );

  it("environment.secrets.destroy: revoked parses on @1.1 and is rejected on @1.0", () => {
    const line = hostRpcRegistry["environment.secrets.destroy"][1];
    expect(
      line.versions[1].contract.responseSchema.parse({ outcome: "revoked" }),
    ).toEqual({ outcome: "revoked" });
    expect(
      accepts(line.versions[0].contract.responseSchema, { outcome: "revoked" }),
    ).toBe(false);
    // The two outcomes @1.0 answers are untouched on @1.1.
    for (const answer of [
      { outcome: "destroyed", destroyedAt: 1 },
      { outcome: "refused", code: "version_current" },
    ]) {
      expect(accepts(line.versions[0].contract.responseSchema, answer)).toBe(
        true,
      );
      expect(accepts(line.versions[1].contract.responseSchema, answer)).toBe(
        true,
      );
    }
  });

  it("environment.host.list: a host with no known enroller or bind time parses on @1.1 and is rejected on @1.0", () => {
    const line = hostRpcRegistry["environment.host.list"][1];
    const host = {
      hostId: "host-1",
      hostLabel: null,
      hostPlatform: null,
      enrolledByUserId: null,
      kind: "personal",
      boundAt: null,
    };
    expect(
      accepts(line.versions[1].contract.responseSchema, {
        hosts: [
          { ...host, reachable: true, lastReportedAt: null, applied: [] },
        ],
      }),
    ).toBe(true);
    expect(
      accepts(line.versions[0].contract.responseSchema, { hosts: [host] }),
    ).toBe(false);
  });
});
