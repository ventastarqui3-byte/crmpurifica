// Descifra un respaldo .sql.gz.enc creado por el CRM (v5.3.25, M12).
// Uso:
//   BACKUP_ENCRYPTION_KEY=<clave> node scripts/decrypt-backup.js backups/<archivo>.sql.gz.enc [salida.sql.gz]
// Sin salida, escribe el mismo nombre sin .enc. La clave es la misma
// BACKUP_ENCRYPTION_KEY del .env (64 caracteres hex). Después, el .sql.gz
// se restaura con:  gunzip -c <archivo>.sql.gz | psql "$DATABASE_URL"
import fs from 'fs';
import crypto from 'crypto';

const file = process.argv[2];
const outFile = process.argv[3] || (file ? file.replace(/\.enc$/, '') : null);
const keyHex = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();

if (!file || !fs.existsSync(file)) {
  console.error('Uso: BACKUP_ENCRYPTION_KEY=<clave> node scripts/decrypt-backup.js <archivo>.sql.gz.enc [salida.sql.gz]');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
  console.error('BACKUP_ENCRYPTION_KEY debe ser 64 caracteres hex (la misma del .env).');
  process.exit(1);
}
const key = Buffer.from(keyHex, 'hex');
const buf = fs.readFileSync(file);
if (buf.length < 32) {
  console.error('El archivo es demasiado corto para ser un respaldo cifrado.');
  process.exit(1);
}
const iv = buf.subarray(0, 16);
const tag = buf.subarray(buf.length - 16);
const ciphertext = buf.subarray(16, buf.length - 16);
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
let plain;
try {
  plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
} catch (e) {
  console.error('No se pudo descifrar: clave incorrecta o archivo corrupto.', e.message);
  process.exit(1);
}
fs.writeFileSync(outFile, plain);
console.log(`Respaldo descifrado: ${outFile} (${plain.length} bytes). Restaura con: gunzip -c ${outFile} | psql "$DATABASE_URL"`);
