/**
 * Returns a clean, human-readable filename for display.
 * Strips the leading timestamp prefix (e.g. "1781147001486_") added by the server.
 * Does NOT replace underscores — the stored name is the original filename, which
 * may contain Greek characters or legitimate underscores.
 */
export function displayFileName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/^\d+_/, '');  // strip timestamp prefix only
}
