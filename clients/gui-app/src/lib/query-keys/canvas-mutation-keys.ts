export const canvasMutationKeys = {
  attach: (artifactId: string) => ["canvas.attach", artifactId] as const,
};
