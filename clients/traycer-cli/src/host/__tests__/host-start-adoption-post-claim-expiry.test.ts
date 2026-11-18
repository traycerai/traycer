import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withUpdateContender } from "@traycer-clients/shared/host-update";

// R4 §41: a proof that expires between the pending read and the atomic
// claim `rename` reads as ABSENT, not a "malformed or expired" refusal. An
// absent grant lets a standalone start reach ordinary admission instead of
// wedging a service-manager relaunch behind a proof nobody can still use.
//
// RED-FIRST against the pre-R4 worktree: `consumeHostStartAdoption`'s
// post-claim expiry check (`host-start-adoption.ts` around the
// `adoptionGrantExpired(parsed.issuedAtMs)` branch inside the claimed-read
// try block) still returns `{ kind: "refused", reason: "host-start adoption
// was malformed or expired" }`.

const rmCalls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options: Parameters<typeof actual.rm>[1] | undefined,
    ) => {
      rmCalls.paths.push(String(path));
      return actual.rm(path, options);
    },
  };
});

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

import {
  __setBeforeHostStartAdoptionClaimHookForTest,
  consumeHostStartAdoption,
  publishHostStartAdoption,
} from "../host-start-adoption";
import { HOST_START_ADOPTION_MAX_AGE_MS } from "../../service/spawn-edge-bounds";

const roots: string[] = [];
async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-start-adoption-expiry-"));
  roots.push(root);
  return join(root, "host-home");
}

const serviceLabel = "com.traycer.host";

async function readAdoptionNonce(hostHomeDir: string): Promise<{
  readonly nonce: string;
  readonly issuedAtMs: number;
}> {
  const { readFile } = await import("node:fs/promises");
  const parsed = JSON.parse(
    await readFile(join(hostHomeDir, ".host-start-adoption.json"), "utf8"),
  ) as { readonly nonce: string; readonly issuedAtMs: number };
  return parsed;
}

async function entriesEndingIn(dir: string, suffix: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(suffix));
}

afterEach(async () => {
  __setBeforeHostStartAdoptionClaimHookForTest(null);
  homeRef.current = "";
  rmCalls.paths = [];
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function withPublishedProof(
  hostHomeDir: string,
  run: (nonce: string, issuedAtMs: number) => Promise<void>,
): Promise<void> {
  await withUpdateContender(
    {
      hostHomeDir,
      reason: "host-start-adoption-post-claim-expiry-test",
      waitMs: 0,
      pollIntervalMs: 10,
      admission: "recovery-maintenance",
    },
    async (capability) => {
      await publishHostStartAdoption(
        capability,
        {
          environment: "production",
          hostHomeDir,
          reason: "host-start-adoption-post-claim-expiry-test",
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "recovery-maintenance",
        },
        serviceLabel,
        "terminal",
      );
      const { nonce, issuedAtMs } = await readAdoptionNonce(hostHomeDir);
      await run(nonce, issuedAtMs);
    },
  );
}

describe("consumeHostStartAdoption: a proof that expires between the pending read and the claim", () => {
  it("41a: reads as absent, leaves nothing behind, and abandons exactly once", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    await withPublishedProof(hostHomeDir, async (nonce, issuedAtMs) => {
      __setBeforeHostStartAdoptionClaimHookForTest(async () => {
        vi.spyOn(Date, "now").mockReturnValue(
          issuedAtMs + HOST_START_ADOPTION_MAX_AGE_MS + 1,
        );
      });

      const result = await consumeHostStartAdoption(
        "production",
        serviceLabel,
        nonce,
      );

      expect(result).toEqual({ kind: "absent" });
      expect(
        await entriesEndingIn(hostHomeDir, ".host-start-adoption.json"),
      ).toEqual([]);
      expect(await entriesEndingIn(hostHomeDir, ".claimed")).toEqual([]);
      expect(
        rmCalls.paths.filter((path) => path.endsWith(".claimed")),
      ).toHaveLength(1);
    });

    vi.restoreAllMocks();
  });

  it("41b: malformed after a valid pending read stays refused, on the reason alone", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const path = join(hostHomeDir, ".host-start-adoption.json");

    await withPublishedProof(hostHomeDir, async (nonce) => {
      __setBeforeHostStartAdoptionClaimHookForTest(async () => {
        await writeFile(path, "not-json", "utf8");
      });

      const result = await consumeHostStartAdoption(
        "production",
        serviceLabel,
        nonce,
      );

      expect(result).toEqual({
        kind: "refused",
        reason: "host-start adoption was malformed",
      });
      expect(rmCalls.paths.filter((p) => p.endsWith(".claimed"))).toHaveLength(
        1,
      );
    });
  });

  it("41c: control - without the clock move, the same proof yields a grant", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    await withPublishedProof(hostHomeDir, async (nonce) => {
      const result = await consumeHostStartAdoption(
        "production",
        serviceLabel,
        nonce,
      );
      expect(result.kind).toBe("grant");
      if (result.kind === "grant") await result.grant.abandon();
    });
  });
});
