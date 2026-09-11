/**
 * The dark ground the brand surfaces are painted on.
 *
 * THREE SURFACES HAVE TO AGREE on this colour, and they are not all written in
 * the same language: the sign-in page and the mobile boot fallback are Tailwind
 * classes in this package, and the iOS launch image is an sRGB triple in
 * `clients/mobile/ios/App/App/Base.lproj/LaunchScreen.storyboard` plus a solid
 * PNG in `Splash.imageset`. A launch crosses all three in the first second, and
 * any disagreement between them reads as a flash.
 *
 * So the class is exported once and the hex is exported beside it, because the
 * hex is the half the storyboard can be checked against - `0.03529411764705882,
 * 0.03529411764705882, 0.043137254901960784` is exactly `#09090b`. Changing the
 * ground means changing this constant and that triple together.
 */
export const BRAND_DARK_GROUND_CLASS = "bg-zinc-950";

/**
 * The resolved value of {@link BRAND_DARK_GROUND_CLASS}, for the surfaces that
 * cannot use a class. Tailwind emits `--color-zinc-950: #09090b`, and
 * `brand-surface.test.ts` holds the two together so a palette change cannot
 * silently desync the native launch image.
 */
export const BRAND_DARK_GROUND_HEX = "#09090b";
