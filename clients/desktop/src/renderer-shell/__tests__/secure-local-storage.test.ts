import { afterEach, describe, expect, it } from "vitest";
import {
  readEncryptedItem,
  removeEncryptedItem,
  writeEncryptedItem,
} from "../secure-local-storage";

/** A mock that cannot break the invariant cannot pin it; only the real module can, which is why nothing here is faked but the storage back-end jsdom already provides. */

const KEY = "test.secure-local-storage.round-trip";

afterEach(() => {
  removeEncryptedItem(KEY);
});

describe("secure-local-storage round trip", () => {
  it("returns a JSON object payload as the identical STRING, not as a parsed object", () => {
    const payload = JSON.stringify({
      schemaVersion: { major: 1, minor: 0 },
      userId: "user-1",
      user: { user: { id: "user-1" } },
    });

    writeEncryptedItem(KEY, payload);

    const read = readEncryptedItem(KEY);
    expect(typeof read).toBe("string");
    expect(read).toBe(payload);
  });

  it("still round-trips a JWT-shaped string, which is what made the default look correct", () => {
    // A JWT is not valid JSON, so the default's parse throws and encrypt-storage falls back to returning the raw string.
    // That is why the legacy access/refresh token slots worked for years and the defect only surfaced when a caller stored an object.
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.signature";

    writeEncryptedItem(KEY, jwt);

    expect(readEncryptedItem(KEY)).toBe(jwt);
  });

  it("reports an absent key as null", () => {
    // The one place `null` legitimately means "nothing is stored" - which is
    // precisely why a present-but-unreadable value must never reach it.
    expect(readEncryptedItem("test.secure-local-storage.never-written")).toBe(
      null,
    );
  });

  it("round-trips a bare JSON scalar, the same trap in miniature", () => {
    // `"true"`, `"42"` and `"null"` are all valid JSON documents. A caller
    // storing any of them would hit the identical silent-absence bug without
    // ever storing anything object-shaped.
    writeEncryptedItem(KEY, "42");

    expect(readEncryptedItem(KEY)).toBe("42");
  });
});
