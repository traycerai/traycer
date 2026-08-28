import { describe, expect, it } from "vitest";
import {
  attestTraycerRegistration,
  isEvictableTraycerIdentity,
  isTraycerLabelShape,
  traycerLabelIdsForBase,
  TRAYCER_HOST_CONTENT_TAG,
} from "../identity";
import type { TraycerLabelIds } from "../identity";
import { extractProgramArgumentsFromPrint } from "../macos/launchctl-print";
import {
  HEALTHY_TRAYCER_AGENT_PRINT,
  SYSTEM_AGENT_BARE_ARGUMENTS_PRINT,
} from "./fixtures/launchctl";

const KNOWN: TraycerLabelIds = traycerLabelIdsForBase("ai.traycer.host");

describe("traycerLabelIdsForBase", () => {
  it("derives the cli-raw / agent / fallback triple from a base label", () => {
    expect(traycerLabelIdsForBase("ai.traycer.host")).toEqual({
      cliRaw: "ai.traycer.host",
      agent: "ai.traycer.host.agent",
      fallback: "ai.traycer.host.fallback",
    });
  });

  it("derives the triple for an environment-scoped base label", () => {
    expect(traycerLabelIdsForBase("ai.traycer.host.staging")).toEqual({
      cliRaw: "ai.traycer.host.staging",
      agent: "ai.traycer.host.staging.agent",
      fallback: "ai.traycer.host.staging.fallback",
    });
  });
});

describe("isTraycerLabelShape", () => {
  it("accepts the bare base label", () => {
    expect(isTraycerLabelShape("ai.traycer.host")).toBe(true);
  });

  it("accepts dotted namespace children", () => {
    expect(isTraycerLabelShape("ai.traycer.host.agent")).toBe(true);
  });

  it("accepts hyphenated namespace children", () => {
    expect(isTraycerLabelShape("ai.traycer.host-legacy")).toBe(true);
  });

  it("rejects labels outside the namespace", () => {
    expect(isTraycerLabelShape("com.apple.finder")).toBe(false);
  });

  it("rejects a label that merely contains the namespace as a substring", () => {
    expect(isTraycerLabelShape("com.example.ai.traycer.host")).toBe(false);
  });
});

describe("attestTraycerRegistration", () => {
  it("attests via an explicit matching content-tag", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: null,
      contentTag: TRAYCER_HOST_CONTENT_TAG,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "attested",
      signals: [{ kind: "content-tag", value: TRAYCER_HOST_CONTENT_TAG }],
    });
  });

  it("rejects a foreign content-tag outright", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: null,
      contentTag: "com.other.vendor",
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "not-traycer",
      reason: "foreign content-tag: com.other.vendor",
    });
  });

  it("detects an in-body content tag when no explicit tag key is present", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: null,
      contentTag: null,
      sourceText: `some blob containing ${TRAYCER_HOST_CONTENT_TAG} inline`,
    });
    expect(result).toEqual({
      kind: "attested",
      signals: [{ kind: "content-tag", value: TRAYCER_HOST_CONTENT_TAG }],
    });
  });

  it("attests via a label that matches one of the known triple", () => {
    const result = attestTraycerRegistration({
      labelId: KNOWN.agent,
      knownLabels: KNOWN,
      programArguments: null,
      contentTag: null,
      sourceText: null,
    });
    expect(result.kind).toBe("attested");
  });

  it("records an in-namespace label outside the expected triple as a signal, but refuses eviction on that alone", () => {
    const result = attestTraycerRegistration({
      labelId: "ai.traycer.host.other-env.agent",
      knownLabels: KNOWN,
      programArguments: null,
      contentTag: null,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "indeterminate",
      cause: "label shape alone is not positive identity for eviction",
    });
  });

  it("attests an in-namespace-but-unmatched-triple label once a strong signal (ProgramArguments) is also present", () => {
    const result = attestTraycerRegistration({
      labelId: "ai.traycer.host.other-env.agent",
      knownLabels: KNOWN,
      programArguments: ["/usr/local/bin/traycer", "host", "start"],
      contentTag: null,
      sourceText: null,
    });
    expect(result.kind).toBe("attested");
  });

  it("rejects a label outside the Traycer namespace when known labels are supplied", () => {
    const result = attestTraycerRegistration({
      labelId: "com.apple.finder",
      knownLabels: KNOWN,
      programArguments: null,
      contentTag: null,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "not-traycer",
      reason: "label 'com.apple.finder' is outside the Traycer host namespace",
    });
  });

  it("attests via label shape alone when no known-labels triple is supplied, given a strong signal too", () => {
    const result = attestTraycerRegistration({
      labelId: "ai.traycer.host.agent",
      knownLabels: null,
      programArguments: ["/usr/local/bin/traycer", "host", "start"],
      contentTag: null,
      sourceText: null,
    });
    expect(result.kind).toBe("attested");
  });

  it("attests via ProgramArguments ending in 'host start'", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: ["/usr/local/bin/traycer", "host", "start"],
      contentTag: null,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "attested",
      signals: [
        {
          kind: "program-arguments",
          tokens: ["/usr/local/bin/traycer", "host", "start"],
        },
      ],
    });
  });

  it("attests the label-bound host-start invocation emitted by current registrations", () => {
    const result = attestTraycerRegistration({
      labelId: KNOWN.fallback,
      knownLabels: KNOWN,
      programArguments: [
        "/usr/local/bin/traycer",
        "host",
        "start",
        "--service-label",
        KNOWN.fallback,
      ],
      contentTag: null,
      sourceText: null,
    });
    expect(result.kind).toBe("attested");
  });

  it("attests the mixed-version-compatible shell registration only for its own label", () => {
    const result = attestTraycerRegistration({
      labelId: KNOWN.fallback,
      knownLabels: KNOWN,
      programArguments: [
        "/bin/sh",
        "-c",
        `"$0" "$@" host start --help 2>&1 | /usr/bin/grep -Fq -- '--service-label' && exec "$0" "$@" host start --service-label '${KNOWN.fallback}' || exec "$0" "$@" host start`,
        "/usr/local/bin/traycer",
      ],
      contentTag: null,
      sourceText: null,
    });
    expect(result.kind).toBe("attested");
  });

  it("does not treat a mismatched --service-label argument as a host invocation", () => {
    const result = attestTraycerRegistration({
      labelId: KNOWN.fallback,
      knownLabels: KNOWN,
      programArguments: [
        "/usr/local/bin/traycer",
        "host",
        "start",
        "--service-label",
        KNOWN.agent,
      ],
      contentTag: null,
      sourceText: null,
    });
    expect(result.kind).toBe("attested");
    if (result.kind === "attested") {
      expect(result.signals).toEqual([
        { kind: "label", value: KNOWN.fallback },
      ]);
    }
  });

  it("rejects non-empty ProgramArguments that do not end in 'host start' with no other signals", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: ["/usr/bin/some-other-binary", "--flag"],
      contentTag: null,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "not-traycer",
      reason:
        "ProgramArguments do not end with a recognised 'host start' invocation",
    });
  });

  it("does not reject mismatched ProgramArguments when a content-tag signal already exists", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: ["/usr/bin/some-other-binary", "--flag"],
      contentTag: TRAYCER_HOST_CONTENT_TAG,
      sourceText: null,
    });
    expect(result.kind).toBe("attested");
  });

  it("is indeterminate when no positive signal is found at all", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: null,
      contentTag: null,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "indeterminate",
      cause: "no positive Traycer identity signals found",
    });
  });

  it("is indeterminate when empty ProgramArguments produce no signal and nothing else does either", () => {
    const result = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: [],
      contentTag: null,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "indeterminate",
      cause: "no positive Traycer identity signals found",
    });
  });

  it("is indeterminate when label shape alone is the only signal (no eviction on shape alone)", () => {
    const result = attestTraycerRegistration({
      labelId: "ai.traycer.host.some-unknown-role",
      knownLabels: null,
      programArguments: null,
      contentTag: null,
      sourceText: null,
    });
    expect(result).toEqual({
      kind: "indeterminate",
      cause: "label shape alone is not positive identity for eviction",
    });
  });
});

describe("isEvictableTraycerIdentity", () => {
  it("is true only for an attested identity", () => {
    expect(isEvictableTraycerIdentity({ kind: "attested", signals: [] })).toBe(
      true,
    );
  });

  it("refuses eviction for not-traycer", () => {
    expect(
      isEvictableTraycerIdentity({ kind: "not-traycer", reason: "x" }),
    ).toBe(false);
  });

  it("refuses eviction for indeterminate", () => {
    expect(
      isEvictableTraycerIdentity({ kind: "indeterminate", cause: "x" }),
    ).toBe(false);
  });
});

/**
 * §2.1.2 — attestation must parse what launchd really emits, and the
 * label-suppresses-refutation rule is a **decision**, not an accident of the
 * order in which signals happen to be pushed.
 */
describe("identity attestation over real launchd bytes (annex §2.1.2)", () => {
  const KNOWN_LABELS = traycerLabelIdsForBase("ai.traycer.host");

  it("attests the live Traycer agent on its real, bare ProgramArguments", () => {
    const args = extractProgramArgumentsFromPrint(HEALTHY_TRAYCER_AGENT_PRINT);
    expect(args).not.toBeNull();

    const attestation = attestTraycerRegistration({
      labelId: KNOWN_LABELS.agent,
      knownLabels: KNOWN_LABELS,
      programArguments: args,
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("attested");
    if (attestation.kind === "attested") {
      // The finding was that this reduced to a label match alone, because the
      // args reader returned `null` for every real job. Invocation evidence
      // must actually be present.
      expect(attestation.signals.map((s) => s.kind)).toContain(
        "program-arguments",
      );
    }
  });

  it("refutes a foreign program on a label outside our namespace", () => {
    // Real bytes: a system agent whose program is /usr/libexec/enhancedloggingd.
    const args = extractProgramArgumentsFromPrint(
      SYSTEM_AGENT_BARE_ARGUMENTS_PRINT,
    );
    expect(args).toEqual(["/usr/libexec/enhancedloggingd"]);

    expect(
      attestTraycerRegistration({
        labelId: "com.apple.enhancedloggingd",
        knownLabels: KNOWN_LABELS,
        programArguments: args,
        contentTag: null,
        sourceText: null,
      }).kind,
    ).toBe("not-traycer");
  });

  it("refutes foreign arguments when there is no ownership signal at all", () => {
    expect(
      attestTraycerRegistration({
        labelId: null,
        knownLabels: KNOWN_LABELS,
        programArguments: ["/usr/libexec/enhancedloggingd"],
        contentTag: null,
        sourceText: null,
      }),
    ).toEqual({
      kind: "not-traycer",
      reason:
        "ProgramArguments do not end with a recognised 'host start' invocation",
    });
  });

  /**
   * DECISION, recorded and tested rather than left emergent: a squatter on one
   * of **our** labels, running a provably foreign program, still attests — the
   * label is the thing we own, and refusing to evict a squatter is how a
   * lockout survives its own repair.
   *
   * Previously this behaviour fell out of `if (signals.length === 0)`, so
   * moving the label block below the arguments block would have silently
   * reversed it with every test still green.
   */
  it("still attests a squatter on OUR label running a foreign program (intended)", () => {
    const attestation = attestTraycerRegistration({
      labelId: KNOWN_LABELS.agent,
      knownLabels: KNOWN_LABELS,
      programArguments: ["/usr/libexec/enhancedloggingd"],
      contentTag: null,
      sourceText: null,
    });
    expect(attestation.kind).toBe("attested");
    if (attestation.kind === "attested") {
      expect(attestation.signals.map((s) => s.kind)).toEqual(["label"]);
    }
  });

  it("a content-tag also suppresses argument refutation", () => {
    expect(
      attestTraycerRegistration({
        labelId: null,
        knownLabels: KNOWN_LABELS,
        programArguments: ["/usr/libexec/enhancedloggingd"],
        contentTag: TRAYCER_HOST_CONTENT_TAG,
        sourceText: null,
      }).kind,
    ).toBe("attested");
  });

  // The rule the suppression must NOT weaken: a label *shape* we do not own,
  // with no invocation evidence at all, is still not evictable.
  it("does not attest an in-namespace label shape with no invocation evidence", () => {
    expect(
      attestTraycerRegistration({
        labelId: "ai.traycer.host.someone-elses-env",
        knownLabels: KNOWN_LABELS,
        programArguments: null,
        contentTag: null,
        sourceText: null,
      }).kind,
    ).toBe("indeterminate");
  });
});
