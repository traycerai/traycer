import { describe, expect, it } from "vitest";
import {
  attestTraycerRegistration,
  isEvictableTraycerIdentity,
  COMPATIBLE_HOST_START_SCRIPT_PREFIX,
  HOST_START_LAUNCHER_BASENAME,
} from "@traycer-clients/shared/host-lifecycle";
import { HOST_CAPABILITY_SERVICE_LABEL } from "../../../host/capabilities";
import {
  buildCompatibleHostStartScript,
  buildHostStartLauncherScript,
} from "../host-start-script";
import { serviceLauncherScriptPath } from "../../label";

/**
 * The emitter and the recognizer must agree on one string.
 *
 * They did not. `host-start-script.ts` moved the probe from
 * `host start --help | grep` to `host capabilities --has service-label`;
 * `host-lifecycle/identity.ts` carried its own copy of the old prefix and was
 * left behind. `attestTraycerRegistration` therefore stopped recognising the
 * `/bin/sh -c` program that this very repository writes into the plist.
 *
 * The consequence is not cosmetic. With no content tag and no exact
 * known-label match, the attestation degrades to `indeterminate`, and
 * `isEvictableTraycerIdentity` refuses to evict on `indeterminate` — so the
 * repair paths that exist to clear a wedged registration decline to touch a
 * registration that is unambiguously ours. That is a lockout surviving the
 * thing built to end it.
 *
 * These rows fail if either side moves alone.
 */
describe("host-start script / identity attestation lockstep", () => {
  const labelId = "ai.traycer.host.dev";
  const programArgumentsFor = (script: string): readonly string[] => [
    // Exactly `buildPlist`'s shape: the script, then the CLI command and its
    // leading args, which is why the `host start` tail check cannot see it.
    "/bin/sh",
    "-c",
    script,
    "/usr/local/bin/traycer",
    "--environment",
    "dev",
  ];

  it("emits a script whose head is the shared prefix, byte for byte", () => {
    expect(buildCompatibleHostStartScript(labelId)).toContain(
      COMPATIBLE_HOST_START_SCRIPT_PREFIX,
    );
    expect(
      buildCompatibleHostStartScript(labelId).startsWith(
        COMPATIBLE_HOST_START_SCRIPT_PREFIX,
      ),
    ).toBe(true);
  });

  it("names the capability token the CLI actually answers to", () => {
    // The other drift direction: renaming the capability without updating the
    // prefix would leave the emitted probe asking for a token `host
    // capabilities` does not know, so every registration falls back to the
    // legacy `host start` arm and `--service-label` is silently never passed.
    expect(COMPATIBLE_HOST_START_SCRIPT_PREFIX).toContain(
      HOST_CAPABILITY_SERVICE_LABEL,
    );
  });

  it("attests a registration built by the real emitter, on label shape alone", () => {
    // `knownLabels: null` and `contentTag: null` is the case that regressed:
    // the ONLY strong signal available is the program arguments, so a
    // recognizer that cannot read them produces `indeterminate` and blocks
    // eviction. Anything weaker than `attested` here is the bug.
    const attestation = attestTraycerRegistration({
      labelId,
      knownLabels: null,
      programArguments: programArgumentsFor(
        buildCompatibleHostStartScript(labelId),
      ),
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("attested");
    expect(isEvictableTraycerIdentity(attestation)).toBe(true);
  });

  it("still attests the pre-capability script every installed machine has on disk", () => {
    // Registrations are durable — only a reinstall rewrites them. Dropping the
    // legacy form would un-attest the entire existing install base, which is
    // the same defect as the drift, aimed at the field instead of at HEAD.
    const legacyScript = `"$0" "$@" host start --help 2>&1 | /usr/bin/grep -Fq -- '--service-label' && exec "$0" "$@" host start --service-label ${labelId} || exec "$0" "$@" host start`;

    const attestation = attestTraycerRegistration({
      labelId,
      knownLabels: null,
      programArguments: programArgumentsFor(legacyScript),
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("attested");
  });

  it("attests a launcher-file registration built by the real path helper, on label shape alone", () => {
    // The 2026-07 plist shape: ProgramArguments[0] is the launcher FILE
    // (`~/.traycer/service/<label>/traycer-host-start`), so there is no
    // inline script for the recognizer to read. The same regression class
    // as the inline-prefix drift applies: if the emitter's path layout and
    // the recognizer's basename/label matching moved apart, every
    // launcher-form plist would attest `indeterminate` and stop being
    // evictable. This row uses the REAL `serviceLauncherScriptPath` so the
    // two cannot drift silently.
    const launcherPath = serviceLauncherScriptPath({
      id: labelId,
      displayName: "Traycer Host (Dev)",
      environment: "dev",
      devSlot: null,
    });
    const attestation = attestTraycerRegistration({
      labelId,
      knownLabels: null,
      programArguments: [launcherPath, "/usr/local/bin/traycer"],
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("attested");
    expect(isEvictableTraycerIdentity(attestation)).toBe(true);
  });

  it("does not attest a launcher whose label sits ABOVE its immediate parent directory", () => {
    // The label id must be the launcher's immediate parent, not merely
    // present earlier in the path. A recognizer that used `.includes()`
    // here would attest this path - the label is present, just not as the
    // basename's parent - and treat an arbitrarily nested foreign launcher
    // as this label's own registration.
    const attestation = attestTraycerRegistration({
      labelId,
      knownLabels: null,
      programArguments: [
        `/Users/u/.traycer/service/${labelId}/nested/${HOST_START_LAUNCHER_BASENAME}`,
        "/usr/local/bin/traycer",
      ],
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("indeterminate");
    expect(isEvictableTraycerIdentity(attestation)).toBe(false);
  });

  it("does not attest a launcher-shaped path with no label context", () => {
    // `labelId: null` (no label known - e.g. a cross-environment scan) must
    // not treat ANY path ending in the launcher basename as a positive
    // signal. Requiring a label for this arm is what stops a foreign
    // `.../traycer-host-start` from attesting as ours merely because no
    // label was supplied to compare against. With no label signal and no
    // recognised invocation shape, this is a positive refutation
    // (`not-traycer`), not merely `indeterminate`.
    const attestation = attestTraycerRegistration({
      labelId: null,
      knownLabels: null,
      programArguments: [
        `/tmp/unrelated/${HOST_START_LAUNCHER_BASENAME}`,
        "/usr/local/bin/traycer",
      ],
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("not-traycer");
    expect(isEvictableTraycerIdentity(attestation)).toBe(false);
  });

  it("does not attest a launcher registered for a DIFFERENT label as this label's invocation", () => {
    // The label id lives in the launcher's parent directory. A launcher
    // path for another environment's label must not count as this label's
    // invocation signal - same rule as the inline arm, which requires the
    // script to name the label.
    const attestation = attestTraycerRegistration({
      labelId,
      knownLabels: null,
      programArguments: [
        `/Users/u/.traycer/service/ai.traycer.host.staging/${HOST_START_LAUNCHER_BASENAME}`,
        "/usr/local/bin/traycer",
      ],
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("indeterminate");
    expect(isEvictableTraycerIdentity(attestation)).toBe(false);
  });

  it("emits a launcher file whose basename macOS will surface, carrying the same capability probe", () => {
    expect(
      serviceLauncherScriptPath({
        id: labelId,
        displayName: "Traycer Host (Dev)",
        environment: "dev",
        devSlot: null,
      }).endsWith(`/${labelId}/${HOST_START_LAUNCHER_BASENAME}`),
    ).toBe(true);
    const script = buildHostStartLauncherScript(labelId);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(HOST_CAPABILITY_SERVICE_LABEL);
    expect(script).toContain(`--service-label '${labelId}'`);
  });

  it("still refuses to evict a foreign script on the same label shape", () => {
    // The negative control: without it, a recognizer that answered yes to
    // everything would pass every row above while the eviction gate stopped
    // discriminating at all.
    //
    // The verdict is `indeterminate`, not `not-traycer`, and that is the
    // designed behaviour rather than a weaker result — a Traycer-shaped label
    // is an ownership signal, and annex §2.1.2 has ownership deliberately
    // suppress argument-based refutation so a squatter on our label stays
    // evictable. Label *shape* alone is then caught by the strong-signal gate.
    // What must hold either way is the gate itself.
    const attestation = attestTraycerRegistration({
      labelId,
      knownLabels: null,
      programArguments: programArgumentsFor(
        '"$0" "$@" definitely not our launcher',
      ),
      contentTag: null,
      sourceText: null,
    });

    expect(attestation.kind).toBe("indeterminate");
    expect(isEvictableTraycerIdentity(attestation)).toBe(false);
  });
});
