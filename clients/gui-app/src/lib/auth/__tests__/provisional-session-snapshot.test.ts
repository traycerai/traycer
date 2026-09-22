/**
 * Dedicated tests for `provisional-session-snapshot.ts`'s major-1 pin (see
 * that file's header, "Why this file is pinned to record major 1"). A
 * dedicated file rather than growing `provisional-boot-session.test.ts`,
 * which drives the snapshot only through `AuthService`/`AuthService.start()`
 * and never calls `writeProvisionalSessionSnapshot`/
 * `readProvisionalSessionSnapshot` directly.
 */
import { describe, expect, it } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createAppleAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { authenticatedUserResponseRecordV100 } from "@traycer/protocol/auth/registry";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  readProvisionalSessionSnapshot,
  writeProvisionalSessionSnapshot,
} from "@/lib/auth/provisional-session-snapshot";

const SNAPSHOT_KEY = "traycer.auth.provisionalSession.v1";

function makeHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

interface RawSnapshotEnvelope {
  readonly schemaVersion: { readonly major: number; readonly minor: number };
  readonly userId: string;
  readonly user: unknown;
}

describe("provisional session snapshot - pinned to record major 1", () => {
  it("9: a snapshot written from an APPLE (major-2) user persists at 1.0 with the bridge's EMAIL stand-in, parses under the RELEASED 1.0 reader, and reads back as a latest-major value", async () => {
    const host = makeHost();
    const base = createAppleAuthenticatedUserFixture(undefined);
    const appleUser: AuthenticatedUser = {
      ...base,
      user: { ...base.user, id: "user-apple" },
    };

    await writeProvisionalSessionSnapshot(host.secureStorage, appleUser);

    const raw = host.secureStorageEntries.get(SNAPSHOT_KEY);
    if (raw === undefined) {
      throw new Error("expected a snapshot to have been written");
    }
    const envelope = JSON.parse(raw) as RawSnapshotEnvelope;

    // Persisted at the frozen record's stamp, not the value's own major-2 one.
    expect(envelope.schemaVersion).toEqual({ major: 1, minor: 0 });

    // THE RELEASED reader (`authenticatedUserResponseRecordV100.schema`) must
    // accept exactly what was persisted - that IS the bridge's contract: a
    // released client that has never heard of major 2 can still read this.
    const releasedParse = authenticatedUserResponseRecordV100.schema.safeParse(
      envelope.user,
    );
    expect(releasedParse.success).toBe(true);
    if (releasedParse.success) {
      // The bridge's APPLE -> EMAIL stand-in, at the wire level.
      expect(releasedParse.data.user.providerType).toBe("EMAIL");
    }

    const read = await readProvisionalSessionSnapshot(
      host.secureStorage,
      "user-apple",
    );
    expect(read).not.toBeNull();
    // Upgraded back to a latest-major value (identity upgrade from 1.0), so
    // this is the same shape a live major-2 validation produces - but the
    // downgrade already lost the APPLE distinction, so it reads back EMAIL,
    // not APPLE. That loss is the file's documented, accepted tradeoff, not
    // a bug this test is pinning.
    expect(read?.user.providerType).toBe("EMAIL");
    expect(read?.user.id).toBe("user-apple");
  });

  it("10: a non-Apple (GITHUB) user round-trips unchanged, byte-level", async () => {
    const host = makeHost();
    const base = createAppleAuthenticatedUserFixture(undefined);
    const githubUser: AuthenticatedUser = {
      ...base,
      user: { ...base.user, id: "user-github", providerType: "GITHUB" },
    };

    await writeProvisionalSessionSnapshot(host.secureStorage, githubUser);

    const raw = host.secureStorageEntries.get(SNAPSHOT_KEY);
    if (raw === undefined) {
      throw new Error("expected a snapshot to have been written");
    }
    const envelope = JSON.parse(raw) as RawSnapshotEnvelope & {
      readonly user: { readonly user: { readonly providerType: string } };
    };
    // Untouched by the bridge: GITHUB stays GITHUB at rest.
    expect(envelope.user.user.providerType).toBe("GITHUB");

    const read = await readProvisionalSessionSnapshot(
      host.secureStorage,
      "user-github",
    );
    expect(read?.user.providerType).toBe("GITHUB");
  });
});
