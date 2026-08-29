import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableBytes } from "@traycer-clients/shared/host-lifecycle";
import {
  projectHostServiceOwner,
  readHostServiceOwner,
  type HostServiceOwner,
  type HostServiceOwnerEvidence,
  type HostServiceOwnerLabels,
  type ObservedHostServiceLabel,
} from "../host-owner";
import type { HostFsLayout } from "../host-paths";

// `projectHostServiceOwner` is pure and total (host-owner.ts:99-165), so the
// whole precedence matrix is exercised here without touching a filesystem.
// `readHostServiceOwner` gets a thinner, fs-backed pass to prove the
// ENOENT-vs-unreadable mapping and the ok/missing wiring, since that mapping
// is where the pure matrix could silently disagree with the real reader.

const LABELS: HostServiceOwnerLabels = {
  cliLabelId: "ai.traycer.host",
  agentLabelId: "ai.traycer.host.agent",
};

const ABSENT: DurableBytes = { kind: "missing" };
const UNAVAILABLE: ObservedHostServiceLabel = { kind: "unavailable" };

function agentLabel(): ObservedHostServiceLabel {
  return { kind: "observed", label: LABELS.agentLabelId };
}

function cliLabel(): ObservedHostServiceLabel {
  return { kind: "observed", label: LABELS.cliLabelId };
}

function unrecognisedLabel(): ObservedHostServiceLabel {
  return { kind: "observed", label: "com.example.unrelated.agent" };
}

function validTransitionBytes(): DurableBytes {
  return {
    kind: "bytes",
    text: JSON.stringify({
      v: 1,
      transitionId: "t1",
      probeNonce: "n1",
      from: "raw-fallback",
      to: "smappservice",
      phase: "reclaim-probing",
      startedAt: "2026-01-01T00:00:00.000Z",
      expectedIdentities: [],
      compensation: null,
      governor: null,
    }),
  };
}

function terminalTransitionBytes(
  phase: "done" | "failed" | "compensated",
): DurableBytes {
  return {
    kind: "bytes",
    text: JSON.stringify({
      v: 1,
      transitionId: "t1",
      probeNonce: "n1",
      from: "raw-fallback",
      to: "smappservice",
      phase,
      startedAt: "2026-01-01T00:00:00.000Z",
      expectedIdentities: [],
      compensation: null,
      governor: null,
      // Retained deliberately as durable audit history. The world-probe
      // decoder drops this field - `phase` is what this projection reads.
      terminal: { outcome: phase },
    }),
  };
}

function substrateBytes(active: "smappservice" | "raw-fallback"): DurableBytes {
  return {
    kind: "bytes",
    text: JSON.stringify({
      v: 1,
      active,
      since: "2026-01-01T00:00:00.000Z",
      reason: "test-fixture",
      attestation: null,
    }),
  };
}

function evidence(
  overrides: Partial<HostServiceOwnerEvidence>,
): HostServiceOwnerEvidence {
  return {
    transition: ABSENT,
    substrate: ABSENT,
    observedLabel: UNAVAILABLE,
    labels: LABELS,
    ...overrides,
  };
}

function expectUnknown(
  owner: HostServiceOwner,
  cause: Extract<HostServiceOwner, { kind: "unknown" }>["cause"],
): void {
  expect(owner.kind).toBe("unknown");
  if (owner.kind === "unknown") {
    expect(owner.cause).toBe(cause);
  }
}

function expectOwned(
  owner: HostServiceOwner,
  substrate: "smappservice" | "raw-fallback",
  from: "service-label" | "substrate",
): void {
  expect(owner.kind).toBe("owned");
  if (owner.kind === "owned") {
    expect(owner.substrate).toBe(substrate);
    expect(owner.from).toBe(from);
  }
}

describe("projectHostServiceOwner - precedence matrix", () => {
  it("vetoes to unknown/transition-in-flight on a decodable journal, regardless of the other legs", () => {
    const owner = projectHostServiceOwner(
      evidence({
        transition: validTransitionBytes(),
        observedLabel: agentLabel(),
        substrate: substrateBytes("smappservice"),
      }),
    );
    expectUnknown(owner, "transition-in-flight");
  });

  it("vetoes to transition-record-faulted on a present-but-undecodable journal", () => {
    const owner = projectHostServiceOwner(
      evidence({ transition: { kind: "bytes", text: "not json" } }),
    );
    expectUnknown(owner, "transition-record-faulted");
  });

  it("vetoes to transition-record-faulted when the journal file is unreadable", () => {
    const owner = projectHostServiceOwner(
      evidence({
        transition: { kind: "unreadable", cause: "EACCES" },
      }),
    );
    expectUnknown(owner, "transition-record-faulted");
  });

  it("recognises the agent label as smappservice", () => {
    const owner = projectHostServiceOwner(
      evidence({ observedLabel: agentLabel() }),
    );
    expectOwned(owner, "smappservice", "service-label");
  });

  it("recognises the cli label as raw-fallback", () => {
    const owner = projectHostServiceOwner(
      evidence({ observedLabel: cliLabel() }),
    );
    expectOwned(owner, "raw-fallback", "service-label");
  });

  it("falls through an unrecognised label to the durable substrate rather than vetoing", () => {
    const owner = projectHostServiceOwner(
      evidence({
        observedLabel: unrecognisedLabel(),
        substrate: substrateBytes("smappservice"),
      }),
    );
    expectOwned(owner, "smappservice", "substrate");
  });

  it("falls an unrecognised label through to unknown/substrate-absent when nothing else corroborates", () => {
    const owner = projectHostServiceOwner(
      evidence({ observedLabel: unrecognisedLabel() }),
    );
    expectUnknown(owner, "substrate-absent");
  });

  it("corroborates a recognised label against a matching substrate", () => {
    const owner = projectHostServiceOwner(
      evidence({
        observedLabel: agentLabel(),
        substrate: substrateBytes("smappservice"),
      }),
    );
    expectOwned(owner, "smappservice", "service-label");
  });

  it("resolves label/substrate contradiction to unknown, never trusting the fresher one", () => {
    const owner = projectHostServiceOwner(
      evidence({
        observedLabel: agentLabel(),
        substrate: substrateBytes("raw-fallback"),
      }),
    );
    expectUnknown(owner, "label-substrate-contradiction");
  });

  it("resolves the reverse contradiction (raw label vs smappservice substrate) to unknown as well", () => {
    const owner = projectHostServiceOwner(
      evidence({
        observedLabel: cliLabel(),
        substrate: substrateBytes("smappservice"),
      }),
    );
    expectUnknown(owner, "label-substrate-contradiction");
  });

  it("trusts the durable substrate alone when no label is observed", () => {
    const owner = projectHostServiceOwner(
      evidence({ substrate: substrateBytes("raw-fallback") }),
    );
    expectOwned(owner, "raw-fallback", "substrate");
  });

  it("is unknown/substrate-absent with no label and no substrate", () => {
    const owner = projectHostServiceOwner(evidence({}));
    expectUnknown(owner, "substrate-absent");
  });

  it("is unknown/substrate-record-faulted on a corrupt substrate with no label", () => {
    const owner = projectHostServiceOwner(
      evidence({ substrate: { kind: "bytes", text: "not json" } }),
    );
    expectUnknown(owner, "substrate-record-faulted");
  });

  it("is unknown/substrate-record-faulted on an unreadable substrate with no label", () => {
    const owner = projectHostServiceOwner(
      evidence({ substrate: { kind: "unreadable", cause: "EIO" } }),
    );
    expectUnknown(owner, "substrate-record-faulted");
  });

  it("is unknown/substrate-record-faulted on an unsupported substrate version, never a guessed owner", () => {
    const owner = projectHostServiceOwner(
      evidence({
        substrate: {
          kind: "bytes",
          text: JSON.stringify({
            v: 99,
            active: "smappservice",
            since: "2026-01-01T00:00:00.000Z",
            reason: "future-version",
            attestation: null,
          }),
        },
      }),
    );
    expectUnknown(owner, "substrate-record-faulted");
  });

  describe("darwin-unknown never defaults to raw-fallback by guess", () => {
    const causes: Array<{
      readonly name: string;
      readonly build: () => HostServiceOwnerEvidence;
    }> = [
      { name: "no evidence at all", build: () => evidence({}) },
      {
        name: "corrupt substrate, no label",
        build: () =>
          evidence({ substrate: { kind: "bytes", text: "garbage" } }),
      },
      {
        name: "unrecognised label, no substrate",
        build: () => evidence({ observedLabel: unrecognisedLabel() }),
      },
      {
        name: "label/substrate contradiction",
        build: () =>
          evidence({
            observedLabel: agentLabel(),
            substrate: substrateBytes("raw-fallback"),
          }),
      },
      {
        name: "in-flight transition with an agent label present",
        build: () =>
          evidence({
            transition: validTransitionBytes(),
            observedLabel: agentLabel(),
          }),
      },
    ];

    it.each(causes.map(({ name, build }) => [name, build] as const))(
      "%s never yields raw-fallback",
      (_name, build) => {
        const owner = projectHostServiceOwner(build());
        if (owner.kind === "owned") {
          expect(owner.substrate).not.toBe("raw-fallback");
        } else {
          expect(owner.kind).toBe("unknown");
        }
      },
    );
  });

  it("never yields raw-fallback (or any owned substrate) without positive evidence, across the full precedence matrix", () => {
    const transitions: DurableBytes[] = [
      ABSENT,
      validTransitionBytes(),
      { kind: "bytes", text: "corrupt" },
      { kind: "unreadable", cause: "EIO" },
    ];
    const labels: ObservedHostServiceLabel[] = [
      UNAVAILABLE,
      agentLabel(),
      cliLabel(),
      unrecognisedLabel(),
    ];
    const substrates: DurableBytes[] = [
      ABSENT,
      substrateBytes("smappservice"),
      substrateBytes("raw-fallback"),
      { kind: "bytes", text: "corrupt" },
      { kind: "unreadable", cause: "EIO" },
    ];

    for (const transition of transitions) {
      for (const observedLabel of labels) {
        for (const substrate of substrates) {
          const owner = projectHostServiceOwner(
            evidence({ transition, substrate, observedLabel }),
          );
          if (owner.kind !== "owned") continue;

          // Positive evidence for the substrate this projection returned:
          // either the label leg named it directly, or the durable record
          // (decodable and present) recorded it. Anything else would be the
          // projection guessing an owner instead of reading one.
          const labelNamesIt =
            (owner.substrate === "smappservice" &&
              observedLabel.kind === "observed" &&
              observedLabel.label === LABELS.agentLabelId) ||
            (owner.substrate === "raw-fallback" &&
              observedLabel.kind === "observed" &&
              observedLabel.label === LABELS.cliLabelId);
          const substrateRecordsIt =
            substrate.kind === "bytes" &&
            (() => {
              try {
                const parsed = JSON.parse(substrate.text) as {
                  active?: string;
                };
                return parsed.active === owner.substrate;
              } catch {
                return false;
              }
            })();

          expect(labelNamesIt || substrateRecordsIt).toBe(true);
        }
      }
    }
  });
});

describe("readHostServiceOwner", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function freshLayout(): Promise<HostFsLayout> {
    const root = await mkdtemp(join(tmpdir(), "host-owner-fs-test-"));
    roots.push(root);
    return {
      rootDir: root,
      pidMetadataFile: join(root, "pid.json"),
      identityEnrollmentFile: join(root, "identity", "enrollment.json"),
      logFile: join(root, "host.log"),
      installDir: join(root, "install"),
      installRecordFile: join(root, "install", "install.json"),
      stagedDir: join(root, "staged"),
      stagedRecordFile: join(root, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        root,
        "pending-login-item-revision.json",
      ),
      substrateFile: join(root, "substrate.json"),
      transitionJournalFile: join(root, "transition.json"),
      environment: "production",
    };
  }

  it("resolves unknown/substrate-absent when neither durable record exists (ENOENT)", async () => {
    const layout = await freshLayout();
    const owner = await readHostServiceOwner(layout, LABELS, UNAVAILABLE);
    expectUnknown(owner, "substrate-absent");
  });

  it("reads a real substrate.json off disk and reports it owned", async () => {
    const layout = await freshLayout();
    await mkdir(layout.rootDir, { recursive: true });
    await writeFile(
      layout.substrateFile,
      JSON.stringify({
        v: 1,
        active: "smappservice",
        since: "2026-01-01T00:00:00.000Z",
        reason: "test",
        attestation: null,
      }),
    );
    const owner = await readHostServiceOwner(layout, LABELS, UNAVAILABLE);
    expectOwned(owner, "smappservice", "substrate");
  });

  it("maps a non-ENOENT read failure (a directory in place of the file) to unreadable, not absent", async () => {
    const layout = await freshLayout();
    await mkdir(layout.substrateFile, { recursive: true });
    const owner = await readHostServiceOwner(layout, LABELS, UNAVAILABLE);
    expectUnknown(owner, "substrate-record-faulted");
  });

  it("maps an unreadable transition journal (directory in its place) to transition-record-faulted, never absent", async () => {
    const layout = await freshLayout();
    await mkdir(layout.transitionJournalFile, { recursive: true });
    const owner = await readHostServiceOwner(layout, LABELS, UNAVAILABLE);
    expectUnknown(owner, "transition-record-faulted");
  });
});

// A SETTLED transition is history, not a veto (cold-review finding 5).
//
// Terminal journals are retained as durable audit/governor history and
// `TransitionJournalStore` has no removal operation - so treating every
// decodable journal as in-flight excluded the machine PERMANENTLY. The
// substrate backfill defers on the same cause, so nothing could repair it.
//
// The invariant, from the transition model's author: persisted history never
// GRANTS ownership by itself, but completed history never permanently BLOCKS
// it either; only an in-flight transition vetoes.
describe("projectHostServiceOwner - terminal journals do not veto", () => {
  it.each(["done", "failed", "compensated"] as const)(
    "a settled %s journal falls through to the durable substrate and GRANTS ownership",
    (phase) => {
      // The cold review's exact failing probe: complete terminal journal plus a
      // positive smappservice substrate.
      expect(
        projectHostServiceOwner({
          transition: terminalTransitionBytes(phase),
          substrate: substrateBytes("smappservice"),
          observedLabel: { kind: "unavailable" },
          labels: LABELS,
        }),
      ).toEqual({
        kind: "owned",
        substrate: "smappservice",
        from: "substrate",
      });
    },
  );

  it("an IN-FLIGHT journal still vetoes - the fix narrows the veto, it does not remove it", () => {
    expect(
      projectHostServiceOwner({
        transition: validTransitionBytes(),
        substrate: substrateBytes("smappservice"),
        observedLabel: { kind: "unavailable" },
        labels: LABELS,
      }),
    ).toEqual({ kind: "unknown", cause: "transition-in-flight" });
  });

  it("an UNDECODABLE journal stays fail-closed - it may be an in-flight one we cannot parse", () => {
    expect(
      projectHostServiceOwner({
        transition: { kind: "bytes", text: "{not json" },
        substrate: substrateBytes("smappservice"),
        observedLabel: { kind: "unavailable" },
        labels: LABELS,
      }).kind,
    ).toBe("unknown");
  });
});
