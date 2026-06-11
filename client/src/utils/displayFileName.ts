/**
 * Returns a clean, human-readable filename for display.
 * Strips the leading timestamp prefix (e.g. "1781147001486_") added by the server
 * and restores spaces from underscores for legacy stored names.
 */
export function displayFileName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/^\d+_/, '')       // strip timestamp prefix
    .replace(/_/g, ' ');        // underscores → spaces for readability
}
