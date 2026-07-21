import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
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
      const { attachId: attachmentId, id: responseId } = req.params;
      const result = await query<{ file_path: string }>(
        `DELETE FROM response_attachments WHERE id = $1 RETURNING file_path`,
        [attachmentId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      // Best-effort file removal
      const filePath = path.join(UPLOAD_DIR, result.rows[0].file_path);
      fs.unlink(filePath, () => {});
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
      res.download(full, file_name);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
