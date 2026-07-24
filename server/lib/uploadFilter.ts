/**
 * Shared multer file filter for every upload endpoint.
 *
 * This is an allowlist, not a blocklist. A blocklist of "dangerous" extensions
 * is a losing game — there are always more, and the interesting ones are the
 * ones nobody thought of. Everything here is a document format a respondent or
 * validator actually attaches as evidence; anything else is refused.
 *
 * What this is NOT: malware inspection. A .xlsx is still a .xlsx whatever is
 * inside it. Real content scanning needs the files in Blob Storage with Defender
 * for Storage in front of them; this only removes the trivially executable
 * formats and the macro-enabled Office variants, which is worth doing on its own
 * but is not a substitute for that work.
 */
import type { Request } from 'express';
import type { FileFilterCallback } from 'multer';

/** Extensions accepted on any upload endpoint. Lower-case, with the dot. */
export const ALLOWED_EXTENSIONS = new Set([
  // Documents
  '.pdf', '.doc', '.docx', '.rtf', '.odt',
  // Spreadsheets — note .xlsm/.xlsb are absent on purpose: macro-enabled
  // workbooks are the classic Office malware carrier and evidence never needs one.
  '.xls', '.xlsx', '.ods', '.csv',
  // Presentations — .pptm likewise absent.
  '.ppt', '.pptx', '.odp',
  // Plain text
  '.txt', '.md', '.log',
  // Images (screenshots of reports/dashboards are common evidence)
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp',
  // Mail exports — respondents attach approval threads
  '.msg', '.eml',
  // Archives. Kept because bundling evidence is a real workflow, but this is
  // exactly the case that most needs the AV scanning we do not yet have: the
  // filter cannot see what is inside.
  '.zip',
]);

/** MIME types refused regardless of extension — a mismatch here means the
 *  extension is lying, which is itself reason enough to reject. */
const DENIED_MIME = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-sh',
  'application/x-shellscript',
  'text/x-shellscript',
  'application/javascript',
  'text/javascript',
  'application/x-httpd-php',
];

export class UnsupportedFileTypeError extends Error {
  status = 400;
  constructor(extension: string) {
    super(
      `File type ${extension || '(none)'} is not accepted. Allowed types: ` +
      [...ALLOWED_EXTENSIONS].join(', ')
    );
    this.name = 'UnsupportedFileTypeError';
  }
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i).toLowerCase();
}

export function uploadFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void {
  const ext = extensionOf(file.originalname || '');

  // Reject double extensions where the *last* one is what matters but an earlier
  // one is executable (report.exe.pdf) — the name is at best confusing and at
  // worst a lure, and no legitimate evidence file is named that way.
  const parts = (file.originalname || '').toLowerCase().split('.');
  const hasHiddenExecutable = parts
    .slice(1, -1)
    .some((p) => ['exe', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'js', 'vbs', 'jar', 'msi'].includes(p));

  if (!ALLOWED_EXTENSIONS.has(ext) || hasHiddenExecutable) {
    cb(new UnsupportedFileTypeError(ext));
    return;
  }
  if (DENIED_MIME.includes((file.mimetype || '').toLowerCase())) {
    cb(new UnsupportedFileTypeError(ext));
    return;
  }
  cb(null, true);
}
