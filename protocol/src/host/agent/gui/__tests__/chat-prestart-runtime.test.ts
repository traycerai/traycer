import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  checkSurfaceCompatibility,
  protocolSurfaceSchema,
} from "@traycer/protocol/framework/surface-compat";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  chatPrestartRuntimeRequestSchema,
  chatPrestartRuntimeResponseSchema,
  chatPrestartRuntimeV10,
} from "@traycer/protocol/host/agent/gui/index";

/**
 * `chat.prestartRuntime@1.0`: typing in an open chat may warm its provider
 * runtime. It is an OPTIONAL method, never part of the released floor: a host
 * that predates it simply does not advertise it, and the caller sees an
 * unsupported method rather than an incompatible connection.
 */

const SETTINGS = {
  harnessId: "codex",
  model: "gpt-5.4",
  permissionMode: "supervised",
  reasoningEffort: "high",
  agentMode: "epic",
  profileId: null,
  serviceTier: null,
} as const;

const REQUEST = {
  epicId: "epic-1",
  chatId: "chat-1",
  settings: SETTINGS,
  accountContext: DEFAULT_ACCOUNT_CONTEXT,
};

const SKIP_REASONS = [
  "turn_active",
  "queue_nonempty",
  "no_live_session",
  "no_provider_session",
  "harness_unsupported",
  "sandbox_host",
  "session_closing",
  "catalog_unavailable",
  "runtime_busy",
] as const;

const baselinePath = join(
  import.meta.dirname,
  "../../../__tests__/__fixtures__/released-baseline-surface.json",
);

describe("chat.prestartRuntime request", () => {
  it("parses settings and account context and keeps them as sent", () => {
    expect(chatPrestartRuntimeRequestSchema.parse(REQUEST)).toEqual(REQUEST);
  });

  it("is strict: an unknown key is refused rather than stripped", () => {
    expect(
      chatPrestartRuntimeRequestSchema.safeParse({
        ...REQUEST,
        message: "hello",
      }).success,
    ).toBe(false);
  });

  it.each(["epicId", "chatId", "settings", "accountContext"] as const)(
    "requires %s",
    (key) => {
      const rest = Object.fromEntries(
        Object.entries(REQUEST).filter(([name]) => name !== key),
      );
      expect(chatPrestartRuntimeRequestSchema.safeParse(rest).success).toBe(
        false,
      );
    },
  );

  it("refuses malformed settings", () => {
    expect(
      chatPrestartRuntimeRequestSchema.safeParse({
        ...REQUEST,
        settings: { ...SETTINGS, permissionMode: "yolo" },
      }).success,
    ).toBe(false);
  });
});

describe("chat.prestartRuntime response", () => {
  it.each(["spawned", "replaced"] as const)(
    "parses started with reason %s",
    (reason) => {
      const response = { outcome: "started", reason };
      expect(chatPrestartRuntimeResponseSchema.parse(response)).toEqual(
        response,
      );
    },
  );

  it("parses reused only with reason warm", () => {
    const response = { outcome: "reused", reason: "warm" };
    expect(chatPrestartRuntimeResponseSchema.parse(response)).toEqual(response);
  });

  it.each(SKIP_REASONS)("parses skipped with reason %s", (reason) => {
    const response = { outcome: "skipped", reason };
    expect(chatPrestartRuntimeResponseSchema.parse(response)).toEqual(response);
  });

  it.each([
    { outcome: "started", reason: "warm" },
    { outcome: "started", reason: "turn_active" },
    { outcome: "reused", reason: "spawned" },
    { outcome: "reused", reason: "runtime_busy" },
    { outcome: "skipped", reason: "spawned" },
    { outcome: "skipped", reason: "replaced" },
    { outcome: "skipped", reason: "warm" },
  ])("refuses the mismatched pair $outcome / $reason", (response) => {
    expect(chatPrestartRuntimeResponseSchema.safeParse(response).success).toBe(
      false,
    );
  });

  it.each([
    { outcome: "started" },
    { outcome: "skipped" },
    { reason: "spawned" },
    { outcome: "failed", reason: "spawned" },
    { outcome: "skipped", reason: "provider said: not logged in" },
  ])("refuses %j", (response) => {
    expect(chatPrestartRuntimeResponseSchema.safeParse(response).success).toBe(
      false,
    );
  });
});

describe("chat.prestartRuntime registration", () => {
  it("binds @1.0 to the exported contract and schemas", () => {
    expect(chatPrestartRuntimeV10.method).toBe("chat.prestartRuntime");
    expect(chatPrestartRuntimeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(chatPrestartRuntimeV10.requestSchema).toBe(
      chatPrestartRuntimeRequestSchema,
    );
    expect(chatPrestartRuntimeV10.responseSchema).toBe(
      chatPrestartRuntimeResponseSchema,
    );

    const entry = hostRpcRegistry["chat.prestartRuntime"];
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(chatPrestartRuntimeV10);
  });

  it("is optional: off the released floor and degrading to unsupported", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("chat.prestartRuntime");
    expect(hostRpcRegistry["chat.prestartRuntime"].degrade).toEqual({
      kind: "unsupported",
    });
  });
});

describe("chat.prestartRuntime against a host that predates it", () => {
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );

  it("advertises the method on the optional manifest only", () => {
    expect(split.manifest).not.toHaveProperty(["chat.prestartRuntime"]);
    expect(split.optionalManifest).toMatchObject({
      "chat.prestartRuntime": { major: 1, minor: 0 },
    });
  });

  it("is an advisory finding, never a blocking one, against the released baseline", () => {
    const theirs = protocolSurfaceSchema.parse(
      JSON.parse(readFileSync(baselinePath, "utf8")),
    );
    const mine = buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    });

    const result = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released-baseline-surface.json",
      exceptions: [],
    });

    const findings = result.findings.filter(
      (finding) => finding.method === "chat.prestartRuntime",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      family: "unary",
      severity: "advisory",
    });
    expect(findings[0].detail).toContain("unsupported");
    expect(
      result.blocking.filter(
        (finding) => finding.method === "chat.prestartRuntime",
      ),
    ).toEqual([]);
  });
});
