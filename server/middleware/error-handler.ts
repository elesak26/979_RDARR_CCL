import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { logger } from '../logger';
import { UnsupportedFileTypeError } from '../lib/uploadFilter';

/**
 * Upload failures are the user's problem to fix, not ours, so they get a status
 * and a message that say what to do. Everything else stays a bare 500 with the
 * detail in the log only — an unexpected error is not something to describe to
 * whoever triggered it.
 *
 * Previously every error landed on 500 "Internal server error", which meant an
 * oversized attachment looked identical to a crashed server: the user retried
 * the same file, it failed the same way, and nothing on screen said 20 MB.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof UnsupportedFileTypeError) {
    logger.warn({ path: req.path, message: err.message }, 'Rejected upload: unsupported file type');
    res.status(400).json({ error: err.message });
    return;
  }

  if (err instanceof MulterError) {
    // LIMIT_FILE_SIZE is the one users actually hit; the rest are malformed
    // requests. Both are 4xx — the request was wrong, the server was not.
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. The maximum upload size is 20 MB (50 MB for cycle checklists).'
        : `Upload rejected: ${err.message}`;
    logger.warn({ path: req.path, code: err.code }, 'Rejected upload');
    res.status(status).json({ error: message });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
