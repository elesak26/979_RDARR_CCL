/**
 * File storage abstraction: local disk or Azure Blob.
 *
 * RDARR uploads (response attachments, validation attachments, cycle checklists)
 * used to be written to the container filesystem under UPLOAD_DIR. On Azure that
 * is /home, which persists — but it is never scanned, so control #4 (malware
 * inspection) and #8 (Defender for Storage) cannot apply to it. Moving the files
 * to a Blob container lets Defender for Storage watch them.
 *
 * Backend is chosen by STORAGE_BACKEND: 'blob' or 'disk' (default 'disk', so
 * nothing changes until it is switched on). In blob mode authentication is by
 * managed identity (DefaultAzureCredential — no secret, the preferred path) or,
 * if STORAGE_CONNECTION_STRING is set, by that connection string.
 *
 * Reads fall back to disk when a blob is missing, so files uploaded before the
 * switch (already on /home/uploads) keep downloading without a migration step.
 */
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import type { Response } from 'express';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { logger } from '../logger';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');

function backend(): 'blob' | 'disk' {
  return (process.env.STORAGE_BACKEND || '').trim().toLowerCase() === 'blob' ? 'blob' : 'disk';
}
export const usingBlob = () => backend() === 'blob';

// ── Blob client (lazy) ───────────────────────────────────────────────────────
let _container: ContainerClient | null = null;
function container(): ContainerClient {
  if (_container) return _container;
  const name = process.env.STORAGE_CONTAINER || 'rdarr-container';
  const cs = process.env.STORAGE_CONNECTION_STRING?.trim();
  let svc: BlobServiceClient;
  if (cs) {
    svc = BlobServiceClient.fromConnectionString(cs);
  } else {
    const account = process.env.STORAGE_ACCOUNT?.trim();
    if (!account) throw new Error('STORAGE_BACKEND=blob needs STORAGE_ACCOUNT (or STORAGE_CONNECTION_STRING)');
    // Managed identity in Azure; az-login / env credential locally. No secret.
    svc = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
  }
  _container = svc.getContainerClient(name);
  return _container;
}

/** Fail fast at startup if blob mode is selected but unconfigured. */
export function assertStorageConfig(): void {
  if (!usingBlob()) return;
  if (!process.env.STORAGE_CONNECTION_STRING && !process.env.STORAGE_ACCOUNT) {
    throw new Error('STORAGE_BACKEND=blob but neither STORAGE_ACCOUNT nor STORAGE_CONNECTION_STRING is set');
  }
}

function diskPath(name: string): string {
  return path.join(UPLOAD_DIR, name);
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * Persist a just-uploaded temp file (written by multer to localTmpPath) under
 * `name`. In blob mode it is uploaded and the local temp removed; in disk mode
 * it is already where it belongs, so this is a no-op. Returns after the write is
 * durable.
 */
export async function persistUpload(localTmpPath: string, name: string, contentType?: string): Promise<void> {
  if (!usingBlob()) return; // multer already wrote it to UPLOAD_DIR
  await container().getBlockBlobClient(name).uploadFile(localTmpPath, {
    blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
  });
  fs.unlink(localTmpPath, () => {}); // best-effort temp cleanup
}

/** Read the whole file into a Buffer (used e.g. to parse a checklist's weights). */
export async function readFileBuffer(name: string): Promise<Buffer> {
  if (usingBlob()) {
    try {
      return await container().getBlockBlobClient(name).downloadToBuffer();
    } catch (err) {
      if (fs.existsSync(diskPath(name))) return fs.promises.readFile(diskPath(name)); // pre-switch file
      throw err;
    }
  }
  return fs.promises.readFile(diskPath(name));
}

/** Stream the file to an HTTP response as an attachment download. */
export async function sendDownload(res: Response, name: string, downloadName: string): Promise<void> {
  if (usingBlob()) {
    try {
      const dl = await container().getBlockBlobClient(name).download();
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
      if (dl.contentType) res.setHeader('Content-Type', dl.contentType);
      (dl.readableStreamBody as Readable).pipe(res);
      return;
    } catch (err) {
      if (fs.existsSync(diskPath(name))) { res.download(diskPath(name), downloadName); return; } // pre-switch file
      throw err;
    }
  }
  res.download(diskPath(name), downloadName);
}

/**
 * Give code that must read a file by local path (e.g. xlsx parsers) a real path.
 * In disk mode it is the file in place; in blob mode the blob is downloaded to a
 * temp file. Always call cleanup() when done — it removes the temp (no-op on disk).
 */
export async function localCopy(name: string): Promise<{ path: string; cleanup: () => void }> {
  if (!usingBlob()) return { path: diskPath(name), cleanup: () => {} };
  const tmp = path.join(UPLOAD_DIR, `.tmp-${Date.now()}-${path.basename(name)}`);
  try {
    await container().getBlockBlobClient(name).downloadToFile(tmp);
    return { path: tmp, cleanup: () => fs.unlink(tmp, () => {}) };
  } catch (err) {
    if (fs.existsSync(diskPath(name))) return { path: diskPath(name), cleanup: () => {} }; // pre-switch file
    throw err;
  }
}

/** Remove a stored file. Best-effort; a missing file is not an error. */
export async function removeFile(name: string): Promise<void> {
  if (usingBlob()) {
    try { await container().getBlockBlobClient(name).deleteIfExists(); } catch (err) { logger.warn({ err, name }, 'fileStore: blob delete failed'); }
    fs.unlink(diskPath(name), () => {}); // also clear any pre-switch copy
    return;
  }
  fs.unlink(diskPath(name), () => {});
}
