import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  providersListV104,
  providersListV105,
} from "@traycer/protocol/host/registry";
import {
  providersListResponseSchema,
  providersListResponseSchemaV104Preimage,
  providersListResponseSchemaV105Preimage,
} from "@traycer/protocol/host/provider-schemas";

/**
 * `providers.list@10.5`: the envelope's `credentialsManagedInAccount`, true on
 * a sandbox host. A new KEY, so the frozen 10.4 response strips it on the
 * within-major re-parse.
 */

describe("providers.list@10.5 registry binding", () => {
  it("opens 10.5 above a frozen 10.4", () => {
    const line = hostRpcRegistry["providers.list"][10];
    expect(line.versions[4].contract).toBe(providersListV104);
    expect(line.versions[5].contract).toBe(providersListV105);
    expect(providersListV105.responseSchema).toBe(
      providersListResponseSchemaV105Preimage,
    );
    expect(providersListV104.responseSchema).toBe(
      providersListResponseSchemaV104Preimage,
    );
  });
});

describe("providers.list live response", () => {
  it.each([true, false])("keeps credentialsManagedInAccount %s", (flag) => {
    const parsed = providersListResponseSchema.parse({
      providers: [],
      credentialsManagedInAccount: flag,
    });
    expect(parsed.credentialsManagedInAccount).toBe(flag);
  });

  it("parses a response without the key and leaves it absent", () => {
    const parsed = providersListResponseSchema.parse({ providers: [] });
    expect(parsed.providers).toEqual([]);
    expect(parsed.credentialsManagedInAccount).toBeUndefined();
  });
});

describe("providers.list frozen 10.4 response", () => {
  it.each([true, false])("strips credentialsManagedInAccount %s", (flag) => {
    const parsed = providersListResponseSchemaV104Preimage.parse({
      providers: [],
      credentialsManagedInAccount: flag,
    });
    expect(Object.hasOwn(parsed, "credentialsManagedInAccount")).toBe(false);
    expect(parsed.providers).toEqual([]);
  });
});
