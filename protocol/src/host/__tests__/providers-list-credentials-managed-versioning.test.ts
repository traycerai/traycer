import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  providersListV102,
  providersListV103,
} from "@traycer/protocol/host/registry";
import {
  providersListResponseSchema,
  providersListResponseSchemaV102Preimage,
} from "@traycer/protocol/host/provider-schemas";

/**
 * `providers.list@10.3`: the envelope's `credentialsManagedInAccount`, true on
 * a sandbox host. A new KEY, so the frozen 10.2 response strips it on the
 * within-major re-parse.
 */

describe("providers.list@10.3 registry binding", () => {
  it("opens 10.3 above a frozen 10.2", () => {
    const line = hostRpcRegistry["providers.list"][10];
    expect(line.latestMinor).toBe(3);
    expect(line.versions[2].contract).toBe(providersListV102);
    expect(line.versions[3].contract).toBe(providersListV103);
    expect(providersListV103.responseSchema).toBe(providersListResponseSchema);
    expect(providersListV102.responseSchema).toBe(
      providersListResponseSchemaV102Preimage,
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

describe("providers.list frozen 10.2 response", () => {
  it.each([true, false])("strips credentialsManagedInAccount %s", (flag) => {
    const parsed = providersListResponseSchemaV102Preimage.parse({
      providers: [],
      credentialsManagedInAccount: flag,
    });
    expect(Object.hasOwn(parsed, "credentialsManagedInAccount")).toBe(false);
    expect(parsed.providers).toEqual([]);
  });
});
