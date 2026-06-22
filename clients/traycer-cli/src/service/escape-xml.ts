// Escape a string value for safe interpolation into a service-manager
// manifest (LaunchAgent plist on macOS, Scheduled Task XML on Windows).
// Both formats are XML, so the same five-replacement set covers them.
//
// XML 1.0 forbids most C0 control characters (U+0000–U+001F) except
// TAB / LF / CR. A path or display name that smuggles one of those
// would silently corrupt the resulting manifest - schtasks rejects the
// XML with a confusing error and launchctl writes a half-valid plist.
// Throw rather than silently strip so the operator sees the actual
// failure mode at install time.
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
