/**
 * Application-level AES-256-GCM encryption for uploaded files.
 *
 * Why application-level in addition to Azure Storage SSE?
 * Azure SSE protects against someone walking out with a disk image; it does NOT
 * protect against a misconfigured SAS URL or a future storage permission error,
 * because the data is transparent to anyone who can reach the blob. A second
 * layer ensures the files are unreadable even if the storage account is exposed.
 *
 * Format (binary):
 *   [4 bytes magic "RENC"] [1 byte version=1] [16 bytes IV] [16 bytes GCM tag]
 *   [remaining bytes: ciphertext]
 *
 * The magic header lets the decrypt path recognise legacy plaintext files (written
 * before this feature) and serve them transparently, so the feature is deployable
 * without a migration that re-encrypts all existing files.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

const MAGIC = Buffer.from('RENC');
const VERSION = 1;
const HEADER_LEN = 4 + 1 + 16 + 16; // magic + version + IV + tag

// ── Key derivation ────────────────────────────────────────────────────────────

let _cachedKey: Buffer | null = null;
let _cachedKeySource: string | undefined;

function getFileKey(): Buffer {
  const raw =
    (process.env.FILE_ENCRYPTION_KEY ?? '').trim() ||
    (process.env.OAUTH_CLIENT_SECRET ?? '').trim();

  if (!raw || raw.length < 16) {
    throw new Error(
      'FILE_ENCRYPTION_KEY (or OAUTH_CLIENT_SECRET as fallback) must be set and ' +
      'at least 16 characters long to enable file encryption.',
    );
  }

  if (_cachedKey && _cachedKeySource === raw) return _cachedKey;

  // scrypt: N=2^17 (OWASP recommendation for file-key derivation), r=8, p=1.
  // Result is cached — derivation is intentionally slow and must not run per request.
  const salt = Buffer.from('nbg-rdarr-file-enc-salt-v1');
  _cachedKey = scryptSync(raw, salt, 32, { N: 1 << 17, r: 8, p: 1 });
  _cachedKeySource = raw;
  return _cachedKey;
}

export function fileEncryptionAvailable(): boolean {
  const raw =
    (process.env.FILE_ENCRYPTION_KEY ?? '').trim() ||
    (process.env.OAUTH_CLIENT_SECRET ?? '').trim();
  return raw.length >= 16;
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypt `srcPath` with AES-256-GCM and write the result to `destPath`.
 * If src === dest the file is replaced atomically via a temp file.
 */
export async function encryptFile(srcPath: string, destPath: string): Promise<void> {
  const key = getFileKey();
  const iv = randomBytes(16);

  const useTmp = srcPath === destPath;
  const tmpPath = useTmp ? `${destPath}.enc.tmp` : destPath;

  await new Promise<void>((resolve, reject) => {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const src = fs.createReadStream(srcPath);
    const dst = fs.createWriteStream(tmpPath);

    // Reserve space for the header; we fill in the GCM tag after streaming.
    dst.write(Buffer.alloc(HEADER_LEN));

    src.pipe(cipher).pipe(dst);

    dst.on('finish', () => {
      try {
        const tag = cipher.getAuthTag();

        // Write the real header into the reserved space via a sync fd.
        const fd = fs.openSync(tmpPath, 'r+');
        const header = Buffer.alloc(HEADER_LEN);
        MAGIC.copy(header, 0);
        header.writeUInt8(VERSION, 4);
        iv.copy(header, 5);
        tag.copy(header, 21);
        fs.writeSync(fd, header, 0, HEADER_LEN, 0);
        fs.closeSync(fd);

        if (useTmp) fs.renameSync(tmpPath, destPath);
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    src.on('error', reject);
    dst.on('error', reject);
    cipher.on('error', reject);
  });
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

function isEncrypted(headerBuf: Buffer): boolean {
  return headerBuf.length >= HEADER_LEN && headerBuf.slice(0, 4).equals(MAGIC);
}

/**
 * Pipe the (possibly encrypted) file at `filePath` into `writeStream`.
 * If the file predates encryption (no RENC magic) it is piped as-is so existing
 * attachments continue to work without a migration.
 */
export async function decryptFileTo(
  filePath: string,
  writeStream: NodeJS.WritableStream,
): Promise<void> {
  const key = getFileKey();

  // Read only the header to decide whether the file is encrypted.
  const headerBuf = Buffer.alloc(HEADER_LEN);
  const fd = fs.openSync(filePath, 'r');
  const bytesRead = fs.readSync(fd, headerBuf, 0, HEADER_LEN, 0);
  fs.closeSync(fd);

  if (bytesRead < HEADER_LEN || !isEncrypted(headerBuf)) {
    // Legacy plaintext file — serve as-is.
    logger.warn({ filePath: path.basename(filePath) }, 'fileEncryption: serving unencrypted legacy file');
    return pipeLegacy(filePath, writeStream);
  }

  const iv = headerBuf.slice(5, 21);
  const tag = headerBuf.slice(21, 37);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  await new Promise<void>((resolve, reject) => {
    const src = fs.createReadStream(filePath, { start: HEADER_LEN });
    src.pipe(decipher).pipe(writeStream, { end: false });

    decipher.on('end', resolve);
    src.on('error', reject);
    decipher.on('error', reject);
    writeStream.on('error', reject);
  });
}

function pipeLegacy(filePath: string, writeStream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = fs.createReadStream(filePath);
    src.pipe(writeStream, { end: false });
    src.on('end', resolve);
    src.on('error', reject);
    writeStream.on('error', reject);
  });
}
