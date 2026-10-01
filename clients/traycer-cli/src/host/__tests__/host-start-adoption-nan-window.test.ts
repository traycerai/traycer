import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withUpdateContender } from "@traycer-clients/shared/host-update";

// This file needs a mock on the shared leaf that no other adoption test file
// may carry (`vi.mock` is file-wide, so it would poison every other suite's
// real window if placed anywhere shared). It exists to prove the fail-closed
// direction of `adoptionGrantExpired`: a `NaN` window must expire every
// grant, never admit one.
//
// Targets `@traycer-clients/shared/host-start-adoption/spawn-edge-bounds`
// directly, NOT this project's own `../../service/spawn-edge-bounds` (a thin
// `export *` wrapper around it, post-#2267 extraction): `adoptionGrantExpired`
// lives in `@traycer-clients/shared/host-start-adoption/index.ts`, which
// imports `HOST_START_ADOPTION_MAX_AGE_MS` from `"./spawn-edge-bounds"` -
// i.e. the SHARED file, a different module specifier than the CLI wrapper.
// Mocking the wrapper does not affect what `index.ts` itself imports, so the
// override would never reach `adoptionGrantExpired` at all.
vi.mock(
  "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-start-adoption/spawn-edge-bounds")
      >();
    return { ...actual, HOST_START_ADOPTION_MAX_AGE_MS: Number.NaN };
  },
);

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

import {
  consumeHostStartAdoption,
  publishHostStartAdoption,
  readHostStartAdoptionNonce,
} from "../host-start-adoption";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-start-adoption-nan-test-"));
  roots.push(root);
  return join(root, "host-home");
}

const options = (hostHomeDir: string) => ({
  environment: "production" as const,
  hostHomeDir,
  reason: "host-start-adoption-nan-window-test",
  waitMs: 0,
  pollIntervalMs: 10,
  admission: "recovery-maintenance" as const,
});
const serviceLabel = "com.traycer.host";

afterEach(async () => {
  homeRef.current = "";
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("adoptionGrantExpired — fail-closed under a NaN window", () => {
  it("hands out no nonce for a FRESH (age-0) proof when the window is NaN", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-nan-window-nonce-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        // Sanity: the proof really was published, fresh, with a live parent.
        const raw = await readFile(
          join(hostHomeDir, ".host-start-adoption.json"),
          "utf8",
        );
        expect(raw.length).toBeGreaterThan(0);

        // `!(Math.abs(now - issuedAtMs) <= NaN)` is `!(false)` == `true` for
        // ANY age, including a proof issued this instant, because every
        // comparison against `NaN` is false. So a NaN window must still read
        // this fresh grant as expired and hand out no nonce.
        await expect(
          readHostStartAdoptionNonce("production", serviceLabel),
        ).resolves.toBeNull();
      },
    );
  });

  it("a LABELLED consume presenting the proof's real nonce still returns absent, never a grant", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-nan-window-labelled-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const proof = JSON.parse(
          await readFile(
            join(hostHomeDir, ".host-start-adoption.json"),
            "utf8",
          ),
        ) as { readonly nonce: string };

        const result = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          proof.nonce,
        );
        expect(result).toEqual({ kind: "absent" });
      },
    );
  });

  it("a STANDALONE consume (no label) also returns absent, never a grant", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-nan-window-standalone-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );

        const result = await consumeHostStartAdoption("production", null, null);
        expect(result).toEqual({ kind: "absent" });
      },
    );
  });
});
