import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { uploadFileFilter } from '../lib/uploadFilter';
import { persistUpload, sendDownload, removeFile, UPLOAD_DIR } from '../lib/fileStore';
import { encryptFile, decryptFileTo, fileEncryptionAvailable } from '../lib/fileEncryption';
import { scanFile } from '../lib/clamScan';
import { query } from '../db';
import { logAudit } from '../audit';

const router = Router();

try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { console.error('Could not create UPLOAD_DIR ' + UPLOAD_DIR, e); }

// Multer/busboy may deliver filenames as latin1-misread UTF-8 bytes.
// Only re-decode if every char is ≤ U+00FF (the latin1 fingerprint);
// if any char is already > U+00FF the string is already proper Unicode.
const decodeFilename = (name: string) => {
  const codePoints = Array.from(name).map(c => c.codePointAt(0) ?? 0);
  console.log('[decodeFilename] raw:', JSON.stringify(name), 'codePoints:', JSON.stringify(codePoints));
  if (codePoints.some(cp => cp > 0xff)) {
    console.log('[decodeFilename] already unicode, returning as-is');
    return name;
  }
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    console.log('[decodeFilename] re-decoded latin1->utf8:', JSON.stringify(decoded));
    return decoded;
  } catch { return name; }
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = decodeFilename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: uploadFileFilter,
});

// Resolve the bu_code that owns a given response, or null if it doesn't exist.
async function getResponseBuCode(responseId: string | string[], cycleId: string | string[]): Promise<string | null> {
  const r = await query<{ bu_code: string }>(
    `SELECT bu_code FROM responses WHERE id = $1 AND cycle_id = $2`,
    [String(responseId), String(cycleId)]
  );
  return r.rows[0]?.bu_code ?? null;
}

// Returns true if the user may access data belonging to buCode.
// Validators, Senior Validators, and Admins see all BUs.
// Responders are restricted to their assigned unit_codes.
function buAllowed(req: Request, buCode: string): boolean {
  const role = req.user?.role;
  if (role === 'Validator' || role === 'Senior Validator' || role === 'Admin') return true;
  const codes = req.user?.unit_codes ?? [];
  return codes.some(c => buCode === c || buCode.startsWith(c + '-'));
}

// GET /api/cycles/:cycleId/responses/:id/attachments
router.get(
  '/api/cycles/:cycleId/responses/:id/attachments',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: responseId, cycleId } = req.params;

      const buCode = await getResponseBuCode(responseId, cycleId);
      if (!buCode) {
        res.status(404).json({ error: 'Response not found' });
        return;
      }
      if (!buAllowed(req, buCode)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const result = await query(
        `SELECT id, response_id, file_name, file_path, uploaded_by, uploaded_at
         FROM response_attachments
         WHERE response_id = $1
         ORDER BY uploaded_at`,
        [responseId]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/cycles/:cycleId/responses/:id/attachments
router.post(
  '/api/cycles/:cycleId/responses/:id/attachments',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Responder') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const { id: responseId, cycleId } = req.params;

      // Ownership check: this Responder must own the BU of the response they're attaching to.
      const buCode = await getResponseBuCode(responseId, cycleId);
      if (!buCode) {
        fs.unlink(req.file.path, () => {});
        res.status(404).json({ error: 'Response not found' });
        return;
      }
      if (!buAllowed(req, buCode)) {
        fs.unlink(req.file.path, () => {});
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const file = req.file;
      const decodedName = decodeFilename(file.originalname);

      // Duplicate-file check
      const existing = await query<{ id: number }>(
        `SELECT id FROM response_attachments WHERE response_id = $1 AND file_name = $2`,
        [responseId, decodedName]
      );
      if (existing.rows.length > 0) {
        fs.unlink(file.path, () => {});
        res.status(409).json({ error: `A file named "${decodedName}" is already attached to this response.` });
        return;
      }

      // 1. Malware scan on the plaintext file (before encryption or Blob upload).
      //    Infected files are deleted; request rejected with 422.
      const scan = await scanFile(file.path);
      if (!scan.clean && !scan.unavailable) {
        fs.unlink(file.path, () => {});
        logAudit({
          action: 'attachment_blocked_malware',
          actor_id: req.user?.id,
          actor_name: req.user?.display_name,
          actor_role: req.user?.role,
          entity_type: 'response',
          entity_id: String(responseId),
          cycle_id: req.params.cycleId ? parseInt(String(req.params.cycleId), 10) : null,
          details: { file_name: decodedName, threat: scan.threat },
        });
        res.status(422).json({ error: `File rejected: malware detected (${scan.threat})` });
        return;
      }

      // 2. Encrypt in-place on disk (AES-256-GCM) before the file leaves the
      //    local temp path. In blob mode the encrypted bytes go into Blob Storage;
      //    in disk mode they stay on disk. Either way, plaintext never persists.
      if (fileEncryptionAvailable()) {
        try {
          await encryptFile(file.path, file.path);
        } catch (encErr) {
          fs.unlink(file.path, () => {});
          throw encErr;
        }
      }

      // 3. Move to the configured store (Blob in prod, no-op on disk).
      await persistUpload(file.path, file.filename, file.mimetype);

      const result = await query(
        `INSERT INTO response_attachments (response_id, file_name, file_path, uploaded_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [responseId, decodedName, file.filename, req.user?.display_name ?? null]
      );
      const saved = result.rows[0];

      logAudit({ action: 'attachment_uploaded', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'attachment', entity_id: String(saved.id), details: { response_id: responseId, file_name: decodedName } });
      res.status(201).json(saved);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/cycles/:cycleId/responses/:id/attachments/:attachId
router.delete(
  '/api/cycles/:cycleId/responses/:id/attachments/:attachId',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Responder') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { attachId: attachmentId, id: responseId, cycleId } = req.params;

      // Ownership check: verify the response belongs to the Responder's BU before deleting.
      const buCode = await getResponseBuCode(responseId, cycleId);
      if (!buCode) {
        res.status(404).json({ error: 'Response not found' });
        return;
      }
      if (!buAllowed(req, buCode)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const result = await query<{ file_path: string }>(
        `DELETE FROM response_attachments WHERE id = $1 AND response_id = $2 RETURNING file_path`,
        [attachmentId, responseId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      await removeFile(result.rows[0].file_path);
      logAudit({ action: 'attachment_deleted', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'attachment', entity_id: String(attachmentId), details: { response_id: String(responseId) } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/cycles/:cycleId/responses/:id/attachments/:attachId/download
router.get(
  '/api/cycles/:cycleId/responses/:id/attachments/:attachId/download',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { attachId, id: responseId, cycleId } = req.params;

      // Ownership: verify the response belongs to a BU this user may access.
      const buCode = await getResponseBuCode(responseId, cycleId);
      if (!buCode) {
        res.status(404).json({ error: 'Response not found' });
        return;
      }
      if (!buAllowed(req, buCode)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const result = await query<{ file_name: string; file_path: string }>(
        `SELECT file_name, file_path FROM response_attachments WHERE id = $1 AND response_id = $2`,
        [attachId, responseId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      const { file_name, file_path } = result.rows[0];
      // Decrypt (AES-256-GCM) while streaming to the response.
      // sendDownload handles Blob vs disk; decryptFileTo handles encrypted vs legacy plaintext.
      const fullPath = path.join(UPLOAD_DIR, file_path);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file_name)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      await decryptFileTo(fullPath, res);
      res.end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
