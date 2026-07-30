import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { uploadFileFilter } from '../lib/uploadFilter';
import { encryptFile, decryptFileTo, fileEncryptionAvailable } from '../lib/fileEncryption';
import { scanFile } from '../lib/clamScan';
import { query } from '../db';
import { logAudit } from '../audit';

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { console.error('Could not create UPLOAD_DIR ' + UPLOAD_DIR, e); }

// Multer/busboy may deliver filenames as latin1-misread UTF-8 bytes.
// Only re-decode if every char is ≤ U+00FF (the latin1 fingerprint);
// if any char is already > U+00FF the string is already proper Unicode.
const decodeFilename = (name: string) => {
  const codePoints = Array.from(name).map(c => c.codePointAt(0) ?? 0);
  console.log('[decodeFilename] raw:', JSON.stringify(name), 'codePoints:', JSON.stringify(codePoints));
  // If any codepoint > 0xFF the string is already proper Unicode - leave it alone
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

// GET /api/cycles/:cycleId/responses/:id/attachments
router.get(
  '/api/cycles/:cycleId/responses/:id/attachments',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await query(
        `SELECT id, response_id, file_name, file_path, uploaded_by, uploaded_at
         FROM response_attachments
         WHERE response_id = $1
         ORDER BY uploaded_at`,
        [id]
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
      const { id: responseId } = req.params;
      const file = req.file;
      const decodedName = decodeFilename(file.originalname);

      // Duplicate-file check: same filename already attached to this response
      const existing = await query<{ id: number }>(
        `SELECT id FROM response_attachments WHERE response_id = $1 AND file_name = $2`,
        [responseId, decodedName]
      );
      if (existing.rows.length > 0) {
        fs.unlink(file.path, () => {});
        res.status(409).json({ error: `A file named "${decodedName}" is already attached to this response.` });
        return;
      }

      // Malware scan — runs on the plaintext file before DB insert or encryption.
      // Infected files are deleted immediately; the request is rejected with 422.
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

      const result = await query(
        `INSERT INTO response_attachments (response_id, file_name, file_path, uploaded_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [responseId, decodedName, file.filename, req.user?.display_name ?? null]
      );
      const saved = result.rows[0];

      const { cycleId } = req.params;
      const respMeta = await query<{ bu_code: string; question_id: number; item_number: number }>(
        `SELECT r.bu_code, r.question_id, q.item_number
         FROM responses r JOIN questions q ON q.id = r.question_id
         WHERE r.id = $1`,
        [responseId]
      );
      const meta = respMeta.rows[0];

      // Encrypt the file in-place after it has been persisted to the DB so a
      // failed encryption leaves the DB record intact and the error surfaces
      // cleanly; the file is removed on encrypt failure to avoid leaving a
      // plaintext copy on disk.
      if (fileEncryptionAvailable()) {
        try {
          await encryptFile(file.path, file.path);
        } catch (encErr) {
          fs.unlink(file.path, () => {});
          throw encErr;
        }
      }

      logAudit({
        action: 'attachment_uploaded',
        actor_id: req.user?.id,
        actor_name: req.user?.display_name,
        actor_role: req.user?.role,
        entity_type: 'response',
        entity_id: String(responseId),
        cycle_id: cycleId ? parseInt(String(cycleId), 10) : null,
        details: {
          attachment_id: saved.id,
          file_name: decodedName,
          bu_code: meta?.bu_code ?? null,
          question_id: meta?.question_id ?? null,
          item_number: meta?.item_number ?? null,
        },
      });
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
      const { attachId: attachmentId, id: responseId } = req.params;
      const delMeta = await query<{ file_path: string; file_name: string }>(
        `DELETE FROM response_attachments WHERE id = $1 RETURNING file_path, file_name`,
        [attachmentId]
      );
      if (delMeta.rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      // Best-effort file removal
      const filePath = path.join(UPLOAD_DIR, delMeta.rows[0].file_path);
      fs.unlink(filePath, () => {});

      const { cycleId: delCycleId } = req.params;
      const delRespMeta = await query<{ bu_code: string; question_id: number; item_number: number }>(
        `SELECT r.bu_code, r.question_id, q.item_number
         FROM responses r JOIN questions q ON q.id = r.question_id
         WHERE r.id = $1`,
        [responseId]
      );
      const delMeta2 = delRespMeta.rows[0];

      logAudit({
        action: 'attachment_deleted',
        actor_id: req.user?.id,
        actor_name: req.user?.display_name,
        actor_role: req.user?.role,
        entity_type: 'response',
        entity_id: String(responseId),
        cycle_id: delCycleId ? parseInt(String(delCycleId), 10) : null,
        details: {
          file_name: delMeta.rows[0].file_name,
          bu_code: delMeta2?.bu_code ?? null,
          question_id: delMeta2?.question_id ?? null,
          item_number: delMeta2?.item_number ?? null,
        },
      });
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
      const { attachId } = req.params;
      const result = await query<{ file_name: string; file_path: string }>(
        `SELECT file_name, file_path FROM response_attachments WHERE id = $1`,
        [attachId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      const { file_name, file_path } = result.rows[0];
      const full = path.join(UPLOAD_DIR, file_path);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file_name)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      await decryptFileTo(full, res);
      res.end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
