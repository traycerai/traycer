import { describe, expect, it } from "vitest";
import { SANDBOX_EGRESS_REFUSAL_CODES } from "@traycer/protocol/host/sandbox-egress";
import {
  NO_EGRESS_REFUSAL_SUBJECT,
  sandboxEgressRefusalCopyFor,
  type SandboxEgressRefusalSubject,
} from "@/lib/sandboxes/sandbox-egress-refusal-copy";

const FULL_SUBJECT: SandboxEgressRefusalSubject = {
  secret: "PROD_DB",
  host: "db.internal",
  protocol: "postgres",
};

describe("sandboxEgressRefusalCopyFor", () => {
  it.each(SANDBOX_EGRESS_REFUSAL_CODES)("has non-empty copy for %s", (code) => {
    const copy = sandboxEgressRefusalCopyFor(code, FULL_SUBJECT);
    expect(copy).not.toBeNull();
    expect(copy?.headline.trim().length).toBeGreaterThan(0);
    expect(copy?.description.trim().length).toBeGreaterThan(0);
  });

  it.each(SANDBOX_EGRESS_REFUSAL_CODES)(
    "never renders null or undefined for %s, with or without a subject",
    (code) => {
      for (const subject of [FULL_SUBJECT, NO_EGRESS_REFUSAL_SUBJECT]) {
        const copy = sandboxEgressRefusalCopyFor(code, subject);
        expect(copy).not.toBeNull();
        expect(copy?.headline).not.toMatch(/null|undefined/);
        expect(copy?.description).not.toMatch(/null|undefined/);
      }
    },
  );

  it("names the secret, the host and the protocol on grant_missing", () => {
    const description = sandboxEgressRefusalCopyFor(
      "grant_missing",
      FULL_SUBJECT,
    )?.description;
    expect(description).toContain("PROD_DB");
    expect(description).toContain("db.internal");
    expect(description).toContain("postgres");
  });

  it("still reads as a sentence on grant_missing with no subject", () => {
    const description = sandboxEgressRefusalCopyFor(
      "grant_missing",
      NO_EGRESS_REFUSAL_SUBJECT,
    )?.description;
    expect(description).toContain("this destination");
    expect(description).not.toContain("null");
    expect(description).not.toContain("undefined");
  });

  it("asks for a grant on exactly one code, grant_missing", () => {
    const asking = SANDBOX_EGRESS_REFUSAL_CODES.filter(
      (code) =>
        sandboxEgressRefusalCopyFor(code, FULL_SUBJECT)?.asksForGrant === true,
    );
    expect(asking).toEqual(["grant_missing"]);
  });

  it("tells the user to retry on authorization_stale, never to grant anything", () => {
    const copy = sandboxEgressRefusalCopyFor(
      "authorization_stale",
      FULL_SUBJECT,
    );
    expect(copy?.headline).toBe("Authorization is stale, retry shortly");
    expect(copy?.asksForGrant).toBe(false);
    expect(copy?.description).toContain("retry shortly");
    expect(copy?.description).toContain("No grant is missing");
  });

  it("returns null for a code this build has no copy for", () => {
    expect(
      sandboxEgressRefusalCopyFor("ssh_flow_unknown", FULL_SUBJECT),
    ).toBeNull();
  });
});
