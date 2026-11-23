import { describe, expect, it } from "vitest";
import {
  type MethodVersionRegistry,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { prepareRequestPayload } from "@traycer/protocol/host-transport/remote/rpc-codec";
import { RELEASED_154_GRANT_REQUESTS } from "./released-154-grant-request-schemas";

/**
 * Client canonical is the current latest minor on the released major.
 * `prepareRequestPayload` returns equal versions unchanged, so the current
 * request is parsed with that latest schema before projection. A newer minor
 * is re-parsed onto the 1.5.4 request schema, which keeps the grant and drops
 * keys that minor added (`selection` on the shell writes).
 */

type GrantMethod = keyof typeof RELEASED_154_GRANT_REQUESTS &
  keyof typeof hostRpcRegistry;

interface ReleasedGrantCase {
  readonly method: GrantMethod;
  readonly releasedRequest: Readonly<Record<string, unknown>>;
  readonly currentRequest: Readonly<Record<string, unknown>>;
}

const NOT_STATED = { kind: "not_stated" };

const SHELL_PATH = "/bin/zsh";

const grantCases: readonly ReleasedGrantCase[] = [
  {
    method: "config.shell.set",
    releasedRequest: {
      path: SHELL_PATH,
      args: ["-l"],
      executableWriteGrant: null,
    },
    currentRequest: {
      path: SHELL_PATH,
      args: ["-l"],
      selection: NOT_STATED,
      executableWriteGrant: null,
    },
  },
  {
    method: "config.shell.reset",
    releasedRequest: { executableWriteGrant: null },
    currentRequest: { executableWriteGrant: null },
  },
  {
    method: "config.shell.add",
    releasedRequest: { path: SHELL_PATH, executableWriteGrant: null },
    currentRequest: {
      path: SHELL_PATH,
      selection: NOT_STATED,
      executableWriteGrant: null,
    },
  },
  {
    method: "config.shell.remove",
    releasedRequest: { path: SHELL_PATH, executableWriteGrant: null },
    currentRequest: {
      path: SHELL_PATH,
      selection: NOT_STATED,
      executableWriteGrant: null,
    },
  },
  {
    method: "config.shell.revertArgs",
    releasedRequest: { path: SHELL_PATH, executableWriteGrant: null },
    currentRequest: {
      path: SHELL_PATH,
      selection: NOT_STATED,
      executableWriteGrant: null,
    },
  },
  {
    method: "config.env.set",
    releasedRequest: {
      key: "NODE_OPTIONS",
      value: "--max-old-space-size=4096",
      executableWriteGrant: null,
    },
    currentRequest: {
      key: "NODE_OPTIONS",
      value: "--max-old-space-size=4096",
      executableWriteGrant: null,
    },
  },
  {
    method: "config.env.localOverride.set",
    releasedRequest: {
      target: { kind: "variable", key: "LOG_LEVEL" },
      value: "debug",
      executableWriteGrant: null,
    },
    currentRequest: {
      target: { kind: "variable", key: "LOG_LEVEL" },
      value: "debug",
      executableWriteGrant: null,
    },
  },
  {
    method: "environment.agentDefinitions.put",
    releasedRequest: {
      name: "reviewer.md",
      text: "Review the change.",
      expectedRevision: null,
      executableWriteGrant: null,
    },
    currentRequest: {
      name: "reviewer.md",
      text: "Review the change.",
      expectedRevision: null,
      executableWriteGrant: null,
    },
  },
  {
    method: "environment.setup.put",
    releasedRequest: {
      os: "linux",
      text: "apt-get install -y jq",
      expectedRevision: null,
      executableWriteGrant: null,
    },
    currentRequest: {
      os: "linux",
      text: "apt-get install -y jq",
      expectedRevision: null,
      executableWriteGrant: null,
    },
  },
  {
    method: "environment.undo",
    releasedRequest: { noticeId: "notice-1", executableWriteGrant: null },
    currentRequest: { noticeId: "notice-1", executableWriteGrant: null },
  },
  {
    method: "providers.setEnvOverride",
    releasedRequest: {
      providerId: "claude-code",
      key: "CLAUDE_BIN",
      value: "/x",
      executableWriteGrant: null,
    },
    currentRequest: {
      providerId: "claude-code",
      key: "CLAUDE_BIN",
      value: "/x",
      executableWriteGrant: null,
    },
  },
  {
    method: "host.notificationHooks.save",
    releasedRequest: {
      hooks: [
        {
          id: "hook-1",
          name: "Pager",
          enabled: true,
          severities: null,
          action: { type: "command", command: "/bin/echo", args: ["hi"] },
        },
      ],
      executableWriteGrant: null,
      configurationRevision: "rev-7",
    },
    currentRequest: {
      hooks: [
        {
          id: "hook-1",
          name: "Pager",
          enabled: true,
          severities: null,
          action: { type: "command", command: "/bin/echo", args: ["hi"] },
        },
      ],
      executableWriteGrant: null,
      configurationRevision: "rev-7",
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEMA_KEYWORDS = new Set([
  "$schema",
  "additionalProperties",
  "anyOf",
  "const",
  "enum",
  "items",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "propertyNames",
  "required",
  "type",
]);

function unhandledKeyword(schema: Record<string, unknown>): string | null {
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) return `unhandled keyword ${key}`;
  }
  return null;
}

function typeMismatch(typeName: string, value: unknown): string | null {
  if (typeName === "null") return value === null ? null : "expected null";
  if (typeName === "array") {
    return Array.isArray(value) ? null : "expected array";
  }
  if (typeName === "integer") {
    return typeof value === "number" && Number.isInteger(value)
      ? null
      : "expected integer";
  }
  if (typeName === "object") {
    return isRecord(value) ? null : "expected object";
  }
  return typeof value === typeName ? null : `expected ${typeName}`;
}

function stringMismatch(
  schema: Record<string, unknown>,
  value: string,
): string | null {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    return "minLength";
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return "maxLength";
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    return "pattern";
  }
  return null;
}

function numberMismatch(
  schema: Record<string, unknown>,
  value: number,
): string | null {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    return "minimum";
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return "maximum";
  }
  return null;
}

function arrayMismatch(
  schema: Record<string, unknown>,
  value: readonly unknown[],
  path: string,
): string | null {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return `${path} minItems`;
  }
  if (!("items" in schema)) return null;
  for (let index = 0; index < value.length; index += 1) {
    const itemError = mismatchAt(
      schema.items,
      value[index],
      `${path}[${String(index)}]`,
    );
    if (itemError !== null) return itemError;
  }
  return null;
}

function objectMismatch(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
): string | null {
  if ("propertyNames" in schema) {
    for (const key of Object.keys(value)) {
      const nameError = mismatchAt(schema.propertyNames, key, `${path} key`);
      if (nameError !== null) return nameError;
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string") return `${path} required entry is not a string`;
    if (!(key in value)) return `${path} missing ${key}`;
  }
  for (const [key, propertyValue] of Object.entries(value)) {
    if (key in properties) {
      const propertyError = mismatchAt(
        properties[key],
        propertyValue,
        `${path}.${key}`,
      );
      if (propertyError !== null) return propertyError;
      continue;
    }
    if (schema.additionalProperties === false) {
      return `${path} unexpected ${key}`;
    }
    if (isRecord(schema.additionalProperties)) {
      const extraError = mismatchAt(
        schema.additionalProperties,
        propertyValue,
        `${path}.${key}`,
      );
      if (extraError !== null) return extraError;
    }
  }
  return null;
}

function mismatchAt(schema: unknown, value: unknown, path: string): string | null {
  if (!isRecord(schema)) return `${path} schema is not an object`;
  const unknownKeyword = unhandledKeyword(schema);
  if (unknownKeyword !== null) return `${path} ${unknownKeyword}`;
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      if (mismatchAt(branch, value, path) === null) return null;
    }
    return `${path} matched no anyOf branch`;
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      if (mismatchAt(branch, value, path) === null) matches += 1;
    }
    return matches === 1 ? null : `${path} oneOf matched ${String(matches)}`;
  }
  if (typeof schema.type === "string") {
    const typeError = typeMismatch(schema.type, value);
    if (typeError !== null) return `${path} ${typeError}`;
  }
  if ("const" in schema && value !== schema.const) return `${path} const`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} enum`;
  }
  if (schema.type === "string" && typeof value === "string") {
    const error = stringMismatch(schema, value);
    if (error !== null) return `${path} ${error}`;
  }
  if (
    (schema.type === "integer" || schema.type === "number") &&
    typeof value === "number"
  ) {
    const error = numberMismatch(schema, value);
    if (error !== null) return `${path} ${error}`;
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return arrayMismatch(schema, value, path);
  }
  if (schema.type === "object" && isRecord(value)) {
    return objectMismatch(schema, value, path);
  }
  return null;
}

function schemaMismatch(schema: unknown, value: unknown): string | null {
  return mismatchAt(schema, value, "$");
}

function installedLine(method: GrantMethod, major: number) {
  const registry: MethodVersionRegistry = hostRpcRegistry[method];
  const line = registry[major];
  if (line === undefined) {
    throw new Error(`${method} has no major ${String(major)}`);
  }
  return line;
}

function requestSchemaAt(method: GrantMethod, version: SchemaVersion) {
  const entry = installedLine(method, version.major).versions[version.minor];
  if (entry === undefined) {
    throw new Error(
      `${method} has no ${String(version.major)}.${String(version.minor)}`,
    );
  }
  return entry.contract.requestSchema;
}

describe("released 1.5.4 requests that carry executableWriteGrant", () => {
  it.each(grantCases)(
    "parses a released 1.5.4 $method request on the current host line",
    (grantCase) => {
      const released = RELEASED_154_GRANT_REQUESTS[grantCase.method];
      const parsed = requestSchemaAt(
        grantCase.method,
        released.version,
      ).safeParse(grantCase.releasedRequest);
      expect(parsed.success).toBe(true);
    },
  );

  it.each(grantCases)(
    "prepares a current $method request for a released 1.5.4 host with the grant",
    (grantCase) => {
      const released = RELEASED_154_GRANT_REQUESTS[grantCase.method];
      const line = installedLine(grantCase.method, released.version.major);
      const currentVersion: SchemaVersion = {
        major: released.version.major,
        minor: line.latestMinor,
      };
      expect(currentVersion.minor).toBeGreaterThanOrEqual(
        released.version.minor,
      );

      const parsed = requestSchemaAt(grantCase.method, currentVersion).safeParse(
        grantCase.currentRequest,
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const currentParams: unknown = parsed.data;

      const prepared = prepareRequestPayload(
        hostRpcRegistry[grantCase.method],
        currentVersion,
        released.version,
        currentParams,
        "released-154",
        grantCase.method,
      );
      expect(prepared.onWireVersion).toEqual(released.version);
      expect(prepared.onWirePayload).toEqual(grantCase.releasedRequest);
      const publishedSchema: unknown = released.request;
      expect(schemaMismatch(publishedSchema, prepared.onWirePayload)).toBeNull();
    },
  );
});
