/**
 * ClamAV malware scan for uploaded files.
 *
 * Uses clamdscan (communicates with the running clamd daemon via socket) rather
 * than the standalone clamscan binary. clamdscan does not load the virus database
 * per invocation — the daemon keeps it in memory — so a scan takes ~2ms instead
 * of ~2s, which is acceptable in the request path.
 *
 * Fail-open policy: if the daemon is unreachable (socket missing, timeout) the
 * upload is allowed through but the event is logged as a warning. This is
 * deliberate — the deployment has two additional layers (extension allowlist in
 * uploadFilter.ts and Azure Defender for Storage on the blob mount) and a
 * clamav daemon crash should not block the application entirely. Change
 * CLAM_BLOCK_ON_UNAVAILABLE=true to flip to fail-closed if required.
 */

import { execFile } from 'child_process';
import { logger } from '../logger';

const TIMEOUT_MS = parseInt(process.env.CLAM_SCAN_TIMEOUT ?? '15000', 10);
const BLOCK_ON_UNAVAILABLE = process.env.CLAM_BLOCK_ON_UNAVAILABLE === 'true';

export interface ScanResult {
  clean: boolean;
  /** Threat name reported by ClamAV, or null when clean. */
  threat: string | null;
  /** True when clamd was unreachable and the result is a best-effort pass-through. */
  unavailable?: boolean;
}

/**
 * Scan `filePath` with the running clamd daemon.
 *
 * Exit codes:
 *   0 → clean
 *   1 → infected (threat name appears in stdout as "<path>: <name> FOUND")
 *   2 → error (daemon unreachable, permission, etc.)
 */
export async function scanFile(filePath: string): Promise<ScanResult> {
  return new Promise((resolve) => {
    const args = [
      '--fdpass',      // pass the fd to clamd — works even if clamd runs as a different user
      '--no-summary',  // omit the summary block, only print infected lines
      filePath,
    ];

    const child = execFile('clamdscan', args, { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (!err) {
        // exit 0 — clean
        resolve({ clean: true, threat: null });
        return;
      }

      const code = (err as NodeJS.ErrnoException & { code?: number }).code;

      if (code === 1) {
        // exit 1 — infected; extract threat name from stdout
        // stdout line format: "/path/to/file: Eicar-Signature FOUND"
        const match = stdout.match(/:\s+(.+?)\s+FOUND/);
        const threat = match ? match[1] : 'Unknown';
        logger.warn({ filePath, threat }, 'clamScan: malware detected');
        resolve({ clean: false, threat });
        return;
      }

      // exit 2 or any other error — daemon unavailable / timeout / permission
      const isTimeout = !!(err as Error & { killed?: boolean }).killed;
      logger.warn(
        { filePath, errCode: code, timeout: isTimeout, msg: err.message },
        'clamScan: daemon unavailable or scan error',
      );

      if (BLOCK_ON_UNAVAILABLE) {
        resolve({ clean: false, threat: null, unavailable: true });
      } else {
        resolve({ clean: true, threat: null, unavailable: true });
      }
    });

    child.on('error', (spawnErr) => {
      // execFile itself failed (binary not found, etc.)
      logger.warn({ msg: spawnErr.message }, 'clamScan: clamdscan binary not found or failed to spawn');
      if (BLOCK_ON_UNAVAILABLE) {
        resolve({ clean: false, threat: null, unavailable: true });
      } else {
        resolve({ clean: true, threat: null, unavailable: true });
      }
    });
  });
}
