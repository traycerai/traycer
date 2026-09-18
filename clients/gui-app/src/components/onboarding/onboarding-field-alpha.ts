/* How bright the welcome field is allowed to get, and the one formula that
   says what its brightest dot does to the ground underneath. The shader
   (onboarding-field.tsx) reads these through uniforms and the contrast test
   reads them directly, so the numbers live here rather than in either. */

/**
 * Peak alpha of the brightest dot, by the ground's luminance band.
 *
 * A dark ground carries the whole field: the dots are the only light in the
 * frame and the copy on top is lighter still. A light ground needs less of it.
 * The mid band is the one the phone recording caught - a mid-luminance teal
 * ground is the case where a field is closest to the text sitting on it, so it
 * gets the least.
 */
export const ONBOARDING_FIELD_PEAK_ALPHA = {
  dark: 0.35,
  light: 0.22,
  mid: 0.14,
} as const;

/** Below this relative luminance the ground counts as dark. */
export const ONBOARDING_FIELD_DARK_GROUND_MAX = 0.25;
/** Above this relative luminance the ground counts as light. */
export const ONBOARDING_FIELD_LIGHT_GROUND_MIN = 0.75;

/** An sRGB colour with each channel in 0..1, the way the shader sees it. */
export type OnboardingFieldRgb = readonly [number, number, number];

/** WCAG relative luminance of an sRGB colour. */
export function onboardingFieldLuminance(rgb: OnboardingFieldRgb): number {
  const linear = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** The band the ground falls in, as a peak alpha for `uPeakAlpha`. */
export function onboardingFieldPeakAlpha(groundLuminance: number): number {
  if (groundLuminance < ONBOARDING_FIELD_DARK_GROUND_MAX)
    return ONBOARDING_FIELD_PEAK_ALPHA.dark;
  if (groundLuminance > ONBOARDING_FIELD_LIGHT_GROUND_MIN)
    return ONBOARDING_FIELD_PEAK_ALPHA.light;
  return ONBOARDING_FIELD_PEAK_ALPHA.mid;
}

/**
 * How far the worst dot on the screen pulls the ground toward `--primary`.
 *
 * The shader's two lines are
 *   `tint = mix(uPrimary, uBackground, 0.2 + 0.4 * lit)`
 *   `alpha = uPeakAlpha * lit * ink`
 * so a dot composited over the ground lands at
 *   `ground + (primary - ground) * peak * lit * (0.8 - 0.4 * lit)`
 * whose `lit` term peaks at `lit = 1` with a value of 0.4. Mixing toward the
 * BACKGROUND rather than the foreground is what bounds this at all: the old
 * mix converged on `--foreground` itself, which is why the copy disappeared
 * into the field on a mid-luminance ground.
 */
export function onboardingFieldWorstCaseMix(peakAlpha: number): number {
  return 0.4 * peakAlpha;
}
