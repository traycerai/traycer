package com.traycer.app;

import java.util.Locale;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A reserved host is always a native request, even if its mount or URL is bad.
 * This boundary must not depend on the manifest: a missing mount never goes to DNS. */
final class ArtifactRequestRouter {
    private static final String DOMAIN = "traycer-artifact.invalid";
    private static final Pattern AUTHORITY = Pattern.compile("^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)");

    static boolean owns(String url) {
        // Inspect only the authority. A malformed path must not route a reserved
        // host to the network. The handler validates the complete URL afterwards.
        Matcher match = AUTHORITY.matcher(url);
        if (!match.find()) return false;
        String host = decodeAuthority(match.group(1)).toLowerCase(Locale.ROOT);
        host = host.substring(host.lastIndexOf('@') + 1);
        int port = host.indexOf(':');
        if (port >= 0) host = host.substring(0, port);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        return host.equals(DOMAIN) || host.endsWith("." + DOMAIN);
    }

    private static String decodeAuthority(String authority) {
        StringBuilder decoded = new StringBuilder();
        for (int i = 0; i < authority.length(); i++) {
            char value = authority.charAt(i);
            if (value == '%' && i + 2 < authority.length()) {
                int high = Character.digit(authority.charAt(i + 1), 16);
                int low = Character.digit(authority.charAt(i + 2), 16);
                if (high >= 0 && low >= 0) {
                    value = (char) (high * 16 + low);
                    i += 2;
                }
            }
            decoded.append(value);
        }
        return decoded.toString();
    }

    static <T> T intercept(String url, Supplier<T> artifact, Supplier<T> fallback) {
        return owns(url) ? artifact.get() : fallback.get();
    }

    private ArtifactRequestRouter() {}
}
