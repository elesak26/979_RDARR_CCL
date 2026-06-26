export const SCORE_LABELS: Record<number, string> = {
  1: 'Non-compliant',
  2: 'Partially compliant',
  3: 'Largely compliant',
  4: 'Fully compliant',
};

export function scoreColor(score: number): string {
  if (score === 1) return '#ff0000';
  if (score === 2) return '#ffc000';
  if (score === 3) return '#81b848';
  return '#538135';
}
