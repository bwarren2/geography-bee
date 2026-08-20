/**
 * Recall shading for the mastery choropleth: unseen stays neutral land, seen
 * countries sweep red → amber → green with recall probability. Saturation is
 * kept low enough that the wrong-answer red used during study still reads as
 * louder. Shared by the dashboard and the share card, which must agree.
 */
export function recallFill(recall: number, seen: boolean): string | undefined {
  if (!seen) return undefined
  const clamped = Math.max(0, Math.min(1, recall))
  const hue = 8 + clamped * 134 // red 8° → green 142°
  return `hsl(${Math.round(hue)}, 48%, 34%)`
}
