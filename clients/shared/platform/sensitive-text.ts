/**
 * Credentials a message can quote, for text that is about to be written down.
 * The CLI's log and the last-attempt record both write error messages.
 */
const SENSITIVE_TEXT_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    // `Basic` beside `Bearer`: a base64 `user:password` is a credential as
    // much as a token is, and the second pattern below stops at the scheme
    // word, leaving the credential after it in place. Newly reachable once
    // error messages and stacks are written rather than counted.
    pattern: /(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "$1 [redacted]",
  },
  {
    pattern:
      /((?:access[_-]?token|accessToken|refresh[_-]?token|refreshToken|token|authorization|password|secret|cookie|code[_-]?verifier|codeVerifier|api[_-]?key|apiKey)\s*[:=]\s*)("[^"]*"|'[^']*'|[^&\s,}]+)/gi,
    replacement: "$1[redacted]",
  },
  // Credentials that travel INSIDE A URL. The registry fetcher quotes the
  // asset URL whole in every error it throws (`host registry: GET <url>
  // returned 503`), and those errors are now written with their message and
  // stack. A manifest that hands out a presigned URL, or a mirror configured
  // with userinfo, would put the secret in the log through that quote - the
  // field patterns above stop at `token=` and `key=` and would not see a
  // `X-Amz-Signature=` or a `https://user:pass@` (Codex, traycerai/traycer#1773
  // round 8). Two shapes: the `user:password@` userinfo, and the query values
  // cloud signers name (S3 / GCS `X-Amz-*` / `X-Goog-*`, Azure's `sig`, the
  // bare `Signature`).
  {
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@?#"']+@/gi,
    replacement: "$1[redacted]@",
  },
  {
    pattern:
      /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential|Signature|sig)=)[^&\s"']+/gi,
    replacement: "$1[redacted]",
  },
];

export function redactSensitiveText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    value,
  );
}
