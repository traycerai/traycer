/**
 * The handful of values the two onboarding dioramas must agree on.
 *
 * The desktop miniature (`onboarding-diorama.tsx`) and the phone frame
 * (`onboarding-phone-diorama.tsx`) are deliberately separate components — they
 * draw different chrome — but the tour reads as one piece of motion design only
 * while they share an easing curve, and the drawer teaches "these are your
 * tasks" only while it lists the same tasks the desktop tab strip does. Nothing
 * else belongs here: this is a move of two constants, not a layer.
 */

/** The tour's single easing curve. Every diorama transition uses it. */
export const EASE = [0.32, 0.72, 0, 1] as const;

/** The task names both miniatures list — desktop tab strip, phone drawer. */
export const TASKS = [
  "Team usage limits",
  "Billing service",
  "Usage sync audit",
] as const;
