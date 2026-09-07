// Escape a string value for safe interpolation into a service-manager manifest (LaunchAgent plist on macOS, Scheduled Task XML on Windows).
// Both formats are XML, so the same five-replacement set covers them.
export function escapeXml(value: string): string {
  const forbidden = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
  if (forbidden.test(value)) {
    const offset = value.search(forbidden);
    throw new Error(
      `escapeXml: input contains an XML 1.0 forbidden control character at offset ${offset} (codepoint U+${value
        .charCodeAt(offset)
        .toString(16)
        .padStart(4, "0")
        .toUpperCase()}); reject the install rather than emit an invalid manifest`,
    );
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
