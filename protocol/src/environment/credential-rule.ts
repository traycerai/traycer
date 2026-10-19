import {
  containsKnownTokenShape,
  isSensitiveKeyName,
} from "@traycer/protocol/utils/text/redaction";

/**
 * The credential rule: whether a variable's value looks like a credential, so
 * the person decides "Make it a secret" or "Keep as a variable" before it is
 * stored or distributed.
 *
 * ONE function, called by every surface that can put a value into the
 * environment: the host's migrator before anything leaves the host, the host's
 * Settings resolvers on a variable save, the dashboard's Variables page before
 * its PUT, and the desktop's Variables and shells page before its write. A save
 * and a migrated upload therefore never disagree about one value. It lives here
 * because `@traycer/protocol` is the one package all of them import; it is pure
 * and browser-safe (no Node imports), like the rest of it.
 *
 * Two tests, in order:
 *
 * 1. The FIELD. A name the product knows carries a credential (an API key
 *    field, a token header, a password) is classified by the name alone and
 *    never by entropy: a short or low-entropy password is still a password.
 *    The stems are the log redaction's (`isSensitiveKeyName`), so a name
 *    redacted in a log and a name held here are the same names, plus the
 *    header and key names below that the redaction matches by pattern.
 * 2. The VALUE, for every other name: a token with a real provider's published
 *    prefix (the redaction's token shapes), a URL carrying a password in its
 *    userinfo, or a long high-entropy run with no whitespace.
 *
 * It is a heuristic and says so where it matters: a value the rule does not
 * recognise is stored as a variable, and the person can move it to Secrets.
 */

export interface CredentialRuleInput {
  readonly name: string;
  readonly value: string;
}

export interface CredentialRuleAnswer {
  readonly credentialLike: boolean;
}

/**
 * Names the redaction recognises by header or key pattern rather than by its
 * stem list. Matched as substrings of the normalized name (lower case, `-`
 * folded to `_`), like the stems.
 */
const EXTRA_CREDENTIAL_NAME_STEMS = [
  "authorization",
  "cookie",
  "passwd",
  "private_key",
  "access_key",
  "signing_key",
  "encryption_key",
] as const;

/** Below this a value is too short for the entropy test to mean anything. */
const HIGH_ENTROPY_MIN_LENGTH = 24;

/**
 * Bits per character. Random mixed-case alphanumerics sit near 5; hex, of
 * which ids and digests are made, cannot exceed 4. So a hex id is never
 * flagged by entropy, which is the trade: a hex API key needs its field name
 * or a known prefix to be caught.
 */
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4.2;

/** The characters keys and tokens are written in. */
const TOKEN_ALPHABET = /^[A-Za-z0-9+/=_.~-]+$/;

const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

function normalizedName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

function isCredentialName(name: string): boolean {
  if (isSensitiveKeyName(name)) return true;
  const normalized = normalizedName(name);
  return EXTRA_CREDENTIAL_NAME_STEMS.some((stem) => normalized.includes(stem));
}

function shannonBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function isHighEntropyRun(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (!TOKEN_ALPHABET.test(value)) return false;
  // A path or a URL fragment is not a token, however random its segments.
  if (value.startsWith("/") || value.startsWith(".") || value.startsWith("~")) {
    return false;
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return shannonBitsPerChar(value) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR;
}

function isCredentialValue(value: string): boolean {
  if (containsKnownTokenShape(value)) return true;
  if (URL_WITH_PASSWORD.test(value)) return true;
  return isHighEntropyRun(value);
}

export function classifyCredential(
  input: CredentialRuleInput,
): CredentialRuleAnswer {
  const value = input.value.trim();
  if (value.length === 0) return { credentialLike: false };
  if (isCredentialName(input.name)) return { credentialLike: true };
  return { credentialLike: isCredentialValue(value) };
}
