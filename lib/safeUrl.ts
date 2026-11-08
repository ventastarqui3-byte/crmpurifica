// v5.3.25 (M13): URLs seguras para adjuntos, medios y logos. El backend
// genera attachmentUrl siempre como /uploads/wa-media/..., pero un valor
// que llegue por otro camino (campaña, seguimiento, logo) nunca debe
// poder ser un javascript: ni una ruta fuera del CRM.
// - isSafeUrl: para <a href> y <img>/<video src> con rutas del CRM o https.
// - isSafeImageSrc: igual, pero además admite data:image/* (el QR de
//   WhatsApp, que el servidor genera como data URL).
export function isSafeUrl(u: unknown): boolean {
  if (typeof u !== 'string' || !u.trim()) return false;
  const v = u.trim();
  if (v.startsWith('/uploads/')) return true;
  if (/^https:\/\//i.test(v)) return true;
  return false;
}

export function isSafeImageSrc(u: unknown): boolean {
  if (typeof u !== 'string' || !u.trim()) return false;
  const v = u.trim();
  if (v.startsWith('data:image/')) return true;
  return isSafeUrl(v);
}
