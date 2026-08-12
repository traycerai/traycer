/**
 * Wire schemas + registry surface for host.identity.get / host.identity.set.
 * Transport bounds live here; the host-side 80-char reject is a resolver rule.
 */
import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  hostIdentityGetRequestSchema,
  hostIdentityGetResponseSchema,
  hostIdentitySchema,
  hostIdentitySetRequestSchema,
  hostIdentitySetResponseSchema,
  HOST_NAME_MAX_TRANSPORT_LENGTH,
} from "@traycer/protocol/host/identity/schemas";

const validIdentity = {
  systemName: "workbox",
  customName: "Nice Box",
  effectiveName: "Nice Box",
} as const;

const validIdentityNoCustom = {
  systemName: "workbox",
  customName: null,
  effectiveName: "workbox",
} as const;

describe("hostIdentitySchema (get/set response)", () => {
  it("parses a full identity", () => {
    expect(hostIdentitySchema.parse(validIdentity)).toEqual(validIdentity);
    expect(hostIdentityGetResponseSchema.parse(validIdentity)).toEqual(
      validIdentity,
    );
    expect(hostIdentitySetResponseSchema.parse(validIdentityNoCustom)).toEqual(
      validIdentityNoCustom,
    );
  });

  it("rejects empty effectiveName / systemName", () => {
    expect(
      hostIdentitySchema.safeParse({
        ...validIdentity,
        effectiveName: "",
      }).success,
    ).toBe(false);
    expect(
      hostIdentitySchema.safeParse({
        ...validIdentity,
        systemName: "",
      }).success,
    ).toBe(false);
  });

  it("rejects empty customName string (must be null when unset)", () => {
    expect(
      hostIdentitySchema.safeParse({
        ...validIdentity,
        customName: "",
      }).success,
    ).toBe(false);
  });

  it("rejects missing fields and wrong types", () => {
    expect(hostIdentitySchema.safeParse({}).success).toBe(false);
    expect(
      hostIdentitySchema.safeParse({
        systemName: "x",
        customName: "y",
      }).success,
    ).toBe(false);
    expect(
      hostIdentitySchema.safeParse({
        systemName: 1,
        customName: null,
        effectiveName: "x",
      }).success,
    ).toBe(false);
  });
});

describe("hostIdentityGetRequestSchema", () => {
  it("accepts an empty object", () => {
    expect(hostIdentityGetRequestSchema.parse({})).toEqual({});
  });

  it("rejects non-objects", () => {
    expect(hostIdentityGetRequestSchema.safeParse(null).success).toBe(false);
    expect(hostIdentityGetRequestSchema.safeParse("get").success).toBe(false);
  });
});

describe("hostIdentitySetRequestSchema", () => {
  it("accepts a custom name or null clear", () => {
    expect(hostIdentitySetRequestSchema.parse({ customName: "Box" })).toEqual({
      customName: "Box",
    });
    expect(hostIdentitySetRequestSchema.parse({ customName: null })).toEqual({
      customName: null,
    });
  });

  it("enforces the transport-safety max length only", () => {
    const atCap = "a".repeat(HOST_NAME_MAX_TRANSPORT_LENGTH);
    const over = "a".repeat(HOST_NAME_MAX_TRANSPORT_LENGTH + 1);
    expect(
      hostIdentitySetRequestSchema.safeParse({ customName: atCap }).success,
    ).toBe(true);
    expect(
      hostIdentitySetRequestSchema.safeParse({ customName: over }).success,
    ).toBe(false);
  });

  it("rejects missing customName and wrong types", () => {
    expect(hostIdentitySetRequestSchema.safeParse({}).success).toBe(false);
    expect(
      hostIdentitySetRequestSchema.safeParse({ customName: 12 }).success,
    ).toBe(false);
  });
});

describe("host.identity registry surface", () => {
  it("resolves host.identity.get at v1.0 with degrade: unsupported", () => {
    const entry = hostRpcRegistry["host.identity.get"];
    expect(entry).toBeDefined();
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1]?.versions[0]?.contract.method).toBe("host.identity.get");
    expect(entry[1]?.versions[0]?.contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("resolves host.identity.set at v1.0 with degrade: unsupported", () => {
    const entry = hostRpcRegistry["host.identity.set"];
    expect(entry).toBeDefined();
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1]?.versions[0]?.contract.method).toBe("host.identity.set");
    expect(entry[1]?.versions[0]?.contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });
});
