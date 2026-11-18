package com.traycer.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.function.Supplier;

import org.junit.Test;

/**
 * {@link ArtifactRequestRouter} decides, ahead of the WebViewClient's normal
 * resource loading, whether a request's host is the reserved artifact apex -
 * before anything about the request's mount or path is known. Getting this
 * wrong in either direction is a security bug: too loose intercepts an
 * innocent host; too strict lets a malformed-but-reserved request leak out to
 * the real network instead of failing locally. These tests exercise {@code
 * owns} directly against the host-matching rules (case, trailing dot,
 * credentials, port, scheme, decoding) and {@code intercept} to prove the
 * routing decision itself: an owned URL always reaches the artifact supplier
 * and never the fallback, and vice versa.
 */
public class ArtifactRequestRouterTest {

    private static final String VALID_RESERVED_URL =
            "https://artifact-myart--abc123def456.traycer-artifact.invalid/index.html";

    /** Fails the test if the fallback supplier is ever actually invoked. */
    private static <T> Supplier<T> neverCalled() {
        return () -> {
            throw new AssertionError("fallback supplier must not be called for an owned URL");
        };
    }

    /** Fails the test if the artifact supplier is ever actually invoked. */
    private static <T> Supplier<T> artifactNeverCalled() {
        return () -> {
            throw new AssertionError("artifact supplier must not be called for a non-owned URL");
        };
    }

    // --- owns(): reserved host, any scheme/port/credentials/case/trailing dot ---

    @Test
    public void owns_aPlainValidReservedUrl() {
        assertTrue(ArtifactRequestRouter.owns(VALID_RESERVED_URL));
    }

    @Test
    public void owns_theBareApexWithNoSubdomainAtAll() {
        assertTrue(ArtifactRequestRouter.owns("https://traycer-artifact.invalid/x"));
    }

    @Test
    public void owns_caseInsensitively_schemeHostAndPath() {
        assertTrue(ArtifactRequestRouter.owns(
                "HTTPS://ARTIFACT-MYART--ABC123.TRAYCER-ARTIFACT.INVALID/INDEX.HTML"));
    }

    @Test
    public void owns_regardlessOfScheme() {
        assertTrue(ArtifactRequestRouter.owns(
                "http://artifact-myart--abc123.traycer-artifact.invalid/x"));
        assertTrue(ArtifactRequestRouter.owns(
                "traycer-artifact://artifact-myart--abc123.traycer-artifact.invalid/x"));
        assertTrue(ArtifactRequestRouter.owns(
                "ftp://artifact-myart--abc123.traycer-artifact.invalid/x"));
        assertTrue(ArtifactRequestRouter.owns(
                "custom+scheme.v1://artifact-myart--abc123.traycer-artifact.invalid/x"));
    }

    @Test
    public void owns_withEmbeddedCredentials() {
        assertTrue(ArtifactRequestRouter.owns(
                "https://user:pass@artifact-myart--abc123.traycer-artifact.invalid/x"));
    }

    @Test
    public void owns_withAPort() {
        assertTrue(ArtifactRequestRouter.owns(
                "https://artifact-myart--abc123.traycer-artifact.invalid:8443/x"));
    }

    @Test
    public void owns_withCredentialsAndAPortTogether() {
        assertTrue(ArtifactRequestRouter.owns(
                "https://user:pass@artifact-myart--abc123.traycer-artifact.invalid:8443/x"));
    }

    @Test
    public void owns_withOneOrSeveralTrailingDots() {
        assertTrue(ArtifactRequestRouter.owns(
                "https://artifact-myart--abc123.traycer-artifact.invalid./x"));
        assertTrue(ArtifactRequestRouter.owns(
                "https://artifact-myart--abc123.traycer-artifact.invalid../x"));
    }

    @Test
    public void owns_withAPercentEncodedHost() {
        // %69 decodes to 'i': "artifact-..." spelled with its first letter encoded.
        assertTrue(ArtifactRequestRouter.owns(
                "https://art%69fact-myart--abc123.traycer-artifact.invalid/x"));
    }

    @Test
    public void owns_aNestedSubdomainUnderTheReservedApex() {
        assertTrue(ArtifactRequestRouter.owns(
                "https://foo.bar.traycer-artifact.invalid/x"));
    }

    // --- owns(): malformed-but-reserved addresses are still caught, never leaked ---

    @Test
    public void owns_aReservedHostWithNoArtifactPrefixAtAllOrGarbageSubdomain() {
        // owns() only inspects the host suffix; it never validates the
        // artifact-id/mount-id shape (that is the strict handler's job
        // downstream) - so a nonsense subdomain must still be caught.
        assertTrue(ArtifactRequestRouter.owns(
                "https://whatever-garbage-!!!.traycer-artifact.invalid/x"));
    }

    @Test
    public void owns_aReservedHostWithAMalformedPercentEncodedPath() {
        assertTrue(ArtifactRequestRouter.owns(
                "https://artifact-myart--abc123.traycer-artifact.invalid/%"));
    }

    @Test
    public void owns_aReservedHostWithNoPathAtAll() {
        assertTrue(ArtifactRequestRouter.owns(
                "https://artifact-myart--abc123.traycer-artifact.invalid"));
    }

    // --- owns(): ordinary hosts and lookalike suffixes fall through ---

    @Test
    public void refuses_anOrdinaryUnrelatedHost() {
        assertFalse(ArtifactRequestRouter.owns("https://example.com/x"));
    }

    @Test
    public void refuses_aLookalikeSuffixMissingItsLeadingDotSeparator() {
        assertFalse(ArtifactRequestRouter.owns(
                "https://eviltraycer-artifact.invalid/x"));
    }

    @Test
    public void refuses_aHostThatMerelyStartsWithTheReservedApex() {
        // The reserved string as a PREFIX of an attacker-controlled domain -
        // the real suffix (and thus the real authority) is theirs, not ours.
        assertFalse(ArtifactRequestRouter.owns(
                "https://traycer-artifact.invalid.evil.com/x"));
    }

    @Test
    public void refuses_aSuffixThatAddsExtraLabelsAfterInvalid() {
        assertFalse(ArtifactRequestRouter.owns(
                "https://artifact-myart--abc123.traycer-artifact.invalid.other/x"));
    }

    @Test
    public void refuses_aStringWithNoSchemeSeparatorAtAll() {
        assertFalse(ArtifactRequestRouter.owns(
                "artifact-myart--abc123.traycer-artifact.invalid/x"));
    }

    @Test
    public void refuses_anEmptyOrBlankUrl() {
        assertFalse(ArtifactRequestRouter.owns(""));
    }

    // --- intercept(): the routing decision itself ---

    @Test
    public void intercept_anOwnedUrl_alwaysReachesTheArtifactSupplierNeverTheFallback() {
        String result = ArtifactRequestRouter.intercept(
                VALID_RESERVED_URL, () -> "artifact-response", ArtifactRequestRouterTest.<String>neverCalled());
        assertEquals("artifact-response", result);
    }

    @Test
    public void intercept_anOwnedUrlForAnUnknownMount_returnsWhatTheNativeSupplierAnswers_andNeverFallsBack() {
        // ArtifactRequestRouter itself knows nothing about mounts - it only
        // decides OWNERSHIP. The real native bridge answers an unknown mount
        // with a 404; this proves that answer passes straight through and
        // the fallback supplier is never reached to produce a different one.
        String notFound = ArtifactRequestRouter.intercept(
                VALID_RESERVED_URL,
                () -> "404",
                ArtifactRequestRouterTest.<String>neverCalled());
        assertEquals("404", notFound);
    }

    @Test
    public void intercept_aMalformedButReservedUrl_stillReachesTheArtifactSupplier_neverTheFallback() {
        String result = ArtifactRequestRouter.intercept(
                "https://whatever-garbage.traycer-artifact.invalid/%",
                () -> "native-error",
                ArtifactRequestRouterTest.<String>neverCalled());
        assertEquals("native-error", result);
    }

    @Test
    public void intercept_anOrdinaryHost_usesTheFallbackSupplier_neverTheArtifactOne() {
        String result = ArtifactRequestRouter.intercept(
                "https://example.com/x",
                ArtifactRequestRouterTest.<String>artifactNeverCalled(),
                () -> "network-response");
        assertEquals("network-response", result);
    }

    @Test
    public void intercept_aSuffixLookalikeHost_usesTheFallbackSupplier() {
        String result = ArtifactRequestRouter.intercept(
                "https://traycer-artifact.invalid.evil.com/x",
                ArtifactRequestRouterTest.<String>artifactNeverCalled(),
                () -> "network-response");
        assertEquals("network-response", result);
    }

    @Test
    public void intercept_propagatesAFallbackFailureFaithfully_whenTheHostIsNotOwned() {
        try {
            ArtifactRequestRouter.intercept(
                    "https://example.com/x",
                    ArtifactRequestRouterTest.<Void>artifactNeverCalled(),
                    () -> {
                        throw new RuntimeException("network unreachable");
                    });
            fail("expected the fallback's exception to propagate");
        } catch (RuntimeException expected) {
            assertEquals("network unreachable", expected.getMessage());
        }
    }
}
