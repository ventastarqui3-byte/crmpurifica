// Respaldo manual para docker-compose (v5.3.26): pg_dump + gzip y, si
// BACKUP_ENCRYPTION_KEY está configurada y es válida, cifrado
// AES-256-GCM con el mismo formato que el respaldo del servidor
// ([IV 16B][cifrado][tag 16B]; scripts/decrypt-backup.js para leerlo).
// Sin clave, el respaldo queda SIN cifrar y se avisa (nunca en
// silencio), igual que runBackup del servidor.
//
// Uso:
//   docker compose --profile backup run --rm backup
//
// Variables (del .env a través de docker-compose.yml):
//   PGHOST, PGUSER, PGPASSWORD, PGDATABASE, BACKUP_DIR,
//   BACKUP_ENCRYPTION_KEY (64 caracteres hex), BACKUP_KEEP_DAYS.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';

const host = process.env.PGHOST || 'db';
const user = process.env.PGUSER || 'purifica';
const db = process.env.PGDATABASE || 'purifica';
const dir = process.env.BACKUP_DIR || '/backups';
const keepDays = Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || '7', 10) || 7);
const keyHex = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
const key = /^[0-9a-fA-F]{64}$/.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;
if (keyHex && !key) console.warn('BACKUP_ENCRYPTION_KEY inválida (debe ser 64 caracteres hex): el respaldo quedará SIN cifrar');

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const base = `crm-backup-${stamp}.sql.gz`;

fs.mkdirSync(dir, { recursive: true });
const filePath = path.join(dir, base);

// pg_dump sin shell (array de argumentos) -> gzip -> archivo.
await new Promise((resolve, reject) => {
  let settled = false;
  const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
  const dump = spawn('pg_dump', ['-h', host, '-U', user, '-d', db], {
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' },
  });
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(filePath);
  let errText = '';
  dump.stderr.on('data', (c) => { errText += String(c); });
  dump.on('error', (e) => done(reject, e));
  dump.stdout.pipe(gzip).pipe(out);
  dump.on('close', (code) => {
    if (code !== 0) {
      try { fs.unlinkSync(filePath); } catch { /* noop */ }
      done(reject, new Error(`pg_dump salió con código ${code}: ${errText.trim()}`));
    }
  });
  out.on('error', (e) => done(reject, e));
  out.on('finish', () => done(resolve));
});

let finalPath = filePath;
let encrypted = false;
if (key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encPath = `${filePath}.enc`;
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    const out = fs.createWriteStream(encPath);
    out.write(iv);
    input.pipe(cipher).pipe(out, { end: false });
    cipher.on('end', () => { try { out.write(cipher.getAuthTag()); } catch { /* noop */ } out.end(); });
    out.on('finish', resolve);
    out.on('error', reject);
    input.on('error', reject);
    cipher.on('error', reject);
  });
  try { fs.unlinkSync(filePath); } catch { /* noop */ }
  finalPath = encPath;
  encrypted = true;
} else {
  console.warn('Respaldo SIN cifrar: define BACKUP_ENCRYPTION_KEY en .env para cifrarlo');
}

// Retención: borra respaldos viejos (.sql.gz y .sql.gz.enc).
const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
for (const f of fs.readdirSync(dir)) {
  if (!/^crm-backup-.*\.sql\.gz(\.enc)?$/.test(f)) continue;
  const p = path.join(dir, f);
  try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* noop */ }
}

const size = fs.statSync(finalPath).size;
console.log(`Respaldo guardado en ${finalPath} (${size} bytes, ${encrypted ? 'cifrado' : 'SIN cifrar'}).${encrypted ? ' Descifrar con: BACKUP_ENCRYPTION_KEY=<clave> node scripts/decrypt-backup.js <archivo>' : ''}`);
