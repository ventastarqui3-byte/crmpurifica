
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import pg from 'pg';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import crypto from 'crypto';
import { spawn } from 'child_process';
import zlib from 'zlib';
import { Server } from 'socket.io';
import 'dotenv/config';
import pkgWA from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { createRequire } from 'module';

// El email es opcional y NO está instalado por defecto (nodemailer no está
// en package.json): si alguien lo instala, el estado lo refleja; si no,
// se informa como no configurado en vez de prometer alertas por email.
const _require = createRequire(import.meta.url);
let nodemailerAvailable = false;
try { _require.resolve('nodemailer'); nodemailerAvailable = true; } catch { /* opcional */ }

const { Client, LocalAuth, MessageMedia } = pkgWA;

// FORZAR ZONA HORARIA COLOMBIA A NIVEL PROCESO
process.env.TZ = 'America/Bogota';

const { Pool } = pg;

// Logger simple para eventos importantes
const logger = {
  info: (msg, data = '') => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, data),
  error: (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err),
  warn: (msg, data = '') => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, data)
};

// ---------- MONITOREO Y ALERTAS v3.1 ----------
// Los errores ya no viven solo en console.log: quedan en la tabla
// system_events (o en un buffer en memoria si no hay DB) y los críticos
// salen por Telegram, que es el único canal que sigue funcionando cuando
// WhatsApp está caído (avisar por WhatsApp de que WhatsApp está caído
// no tiene sentido).
const APP_VERSION = '5.3.11';
const SERVER_STARTED_AT = Date.now();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const BACKUP_ENABLED = (process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
const BACKUP_KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '7', 10) || 7;

// ---------- GOOGLE CALENDAR v5.3 ----------
// OAuth2 con refresh token (NO llave de API pública: esa solo lee, no
// puede crear eventos). Sin credenciales el CRM funciona igual que antes:
// el servicio se guarda y solo se registra el aviso, nunca un 500.
// El refresh token también se puede guardar en settings (solo admin) y
// tiene prioridad sobre el .env; NUNCA se devuelve al frontend.
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REFRESH_TOKEN_ENV = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
const GOOGLE_CALENDAR_ID_ENV = (process.env.GOOGLE_CALENDAR_ID || '').trim() || 'primary';
const GOOGLE_CALENDAR_DURATION_DEFAULT = 120; // minutos por servicio
// Último error de Google Calendar (para el semáforo de Estado del Sistema).
let lastGoogleCalendarError = null;

// Buffer en memoria con los últimos 200 eventos (se vuelca a la DB cuando
// vuelve, si es que la tabla system_events ya existe).
const eventBuffer = [];
let eventsTableReady = false;
let lastBackup = { at: null, ok: null, file: null, sizeBytes: null, error: null };
// Anti-spam de alertas: última vez que se avisó de cada clave (clave -> ms).
const lastAlertAt = {};
// Último estado conocido por el vigilante (para avisar solo al cambiar).
const watchdogState = { db: null, whatsapp: null };
// Intentos fallidos de login por correo (timestamps, últimos 10 min).
const loginFailures = new Map();
// Bloqueos de login en memoria: clave email|IP -> ms hasta el que está bloqueado
// (15 min tras 5 fallos en 10 min). Se resetea con un login exitoso.
const loginBlocks = new Map();

function pushEventBuffer(ev) {
  eventBuffer.push(ev);
  if (eventBuffer.length > 200) eventBuffer.shift();
}

async function recordEvent(level, component, message, details = {}) {
  const ev = {
    level, component, message,
    details: details && typeof details === 'object' ? details : { value: String(details ?? '') },
    created_at: new Date().toISOString(),
  };
  pushEventBuffer(ev);
  if (!eventsTableReady || !dbOk) return;
  try {
    await pool.query(
      'INSERT INTO system_events (level, component, message, details) VALUES ($1, $2, $3, $4)',
      [level, component, message, JSON.stringify(ev.details)]
    );
  } catch (e) {
    // La tabla puede no existir aún (base vieja sin migrar): no romper nada.
    console.error('[EVENTS] No se pudo guardar el evento en DB:', e.message);
  }
}

async function flushEventBuffer() {
  if (!eventsTableReady || !dbOk || eventBuffer.length === 0) return;
  const pending = [...eventBuffer];
  eventBuffer.length = 0;
  for (let i = 0; i < pending.length; i++) {
    const ev = pending[i];
    try {
      await pool.query(
        'INSERT INTO system_events (level, component, message, details, created_at) VALUES ($1, $2, $3, $4, $5)',
        [ev.level, ev.component, ev.message, JSON.stringify(ev.details), ev.created_at]
      );
    } catch (e) {
      // Re-encolar el fallido Y los que quedaban: antes se perdían.
      for (let j = i; j < pending.length; j++) pushEventBuffer(pending[j]);
      break;
    }
  }
}

function telegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function sendTelegramAlert(text) {
  if (!telegramConfigured()) return { configured: false, sent: false, reason: 'Telegram no configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID vacíos)' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configured: true, sent: false, reason: data.description || `Telegram respondió ${res.status}` };
    return { configured: true, sent: true };
  } catch (e) {
    return { configured: true, sent: false, reason: e.message };
  }
}

// Email opcional (preparado, no instalado): si en el futuro se instala
// nodemailer y se definen SMTP_HOST/PORT/USER/PASS/ALERT_EMAIL, esta
// función envía por ese canal. Hoy Telegram es el canal recomendado.
async function sendEmailAlert(subject, text) {
  const cfg = {
    host: (process.env.SMTP_HOST || '').trim(),
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: (process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    to: (process.env.ALERT_EMAIL || '').trim(),
  };
  if (!cfg.host || !cfg.user || !cfg.to) {
    return { configured: false, sent: false, reason: 'Email no configurado (SMTP_HOST/SMTP_USER/ALERT_EMAIL vacíos)' };
  }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host: cfg.host, port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await transporter.sendMail({ from: cfg.user, to: cfg.to, subject, text });
    return { configured: true, sent: true };
  } catch (e) {
    return { configured: true, sent: false, reason: e.message };
  }
}

// Alerta con anti-spam: la misma clave no se repite más de 1 vez cada 30 min,
// salvo que se fuerce (p. ej. el botón "Probar alerta"). lastAlertAt solo se
// marca cuando el envío tuvo éxito: antes se marcaba antes de enviar y un
// fallo de Telegram bloqueaba el reintento 30 min.
async function maybeAlert(key, text, { force = false } = {}) {
  const now = Date.now();
  if (!force && lastAlertAt[key] && now - lastAlertAt[key] < 30 * 60 * 1000) return { sent: false, reason: 'anti-spam: ya se avisó de esto hace menos de 30 min' };
  const r = await sendTelegramAlert(text);
  if (r.sent) lastAlertAt[key] = now;
  if (!r.sent) await recordEvent('warn', 'alerts', `No se pudo enviar la alerta (${key}): ${r.reason}`, { key });
  return r;
}

function waStatusSummary() {
  const instances = Object.keys(waClients).map((id) => ({
    id,
    name: waClients[id].name,
    status: waClients[id].status,
    channel: waClients[id].channel || 'qr',
    phone: waClients[id].phone || null,
    lastSeen: waClients[id].lastSeen || null,
    lastMessageAt: waClients[id].lastMessageAt || null,
  }));
  return {
    instances,
    total: instances.length,
    connected: instances.filter((i) => i.status === 'ready').length,
  };
}

// ---------- NORMALIZACIÓN DE TELÉFONOS (Colombia) v5 Parte 2B ----------
// MISMA lógica que lib/phone.ts en el frontend: si cambias una regla aquí,
// cambia la otra igual.
// - Se quitan espacios, guiones, paréntesis y puntos.
// - 10 dígitos que empiezan por 3 -> +57 + dígitos.
// - 12 dígitos que empiezan por 57 (con o sin +) Y cuyos 10 restantes
//   empiezan por 3 (móvil) -> +57 + últimos 10. Un 12 dígitos 57... con
//   resto fijo (p. ej. 576012345678) NO se toca: inventarle un +57
//   contradice la regla de no inventar prefijos para fijos.
// - Cualquier otro caso se deja tal cual (normalized: false): nunca se
//   inventa un +57 para un fijo (601...), un número corto o un extranjero.
// Ejemplos: '300 123 4567' -> '+573001234567'; '573001234567' -> '+573001234567';
// '+573001234567' -> '+573001234567'; '6012345678' -> '6012345678' (tal cual);
// '576012345678' -> '576012345678' (tal cual: fijo con prefijo país).
function normalizePhoneCO(raw) {
  const original = raw == null ? '' : String(raw).trim();
  if (!original) return { phone: '', normalized: false };
  const digits = original.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return { phone: `+57${digits}`, normalized: true };
  if (digits.length === 12 && digits.startsWith('57') && digits.slice(2).startsWith('3')) return { phone: `+57${digits.slice(2)}`, normalized: true };
  return { phone: original, normalized: false };
}
function normalizePhoneString(raw) {
  return normalizePhoneCO(raw).phone;
}
// Patrones LIKE para buscar un término en una columna de teléfono, cubriendo
// el valor tal cual se escribió y sus variantes normalizadas (con +57, sin +
// y solo los 10 dígitos). Así '3001234567' encuentra filas guardadas como
// '+573001234567' y viceversa.
function phoneSearchPatterns(term) {
  const pats = new Set([`%${escapeLike(term)}%`]);
  const { phone, normalized } = normalizePhoneCO(term);
  if (normalized) {
    pats.add(`%${phone}%`);
    pats.add(`%${phone.replace('+', '')}%`);
    pats.add(`%${phone.slice(3)}%`);
  }
  return [...pats];
}
// Añade a `params` un patrón por variante y devuelve la condición
// `(col ILIKE $n OR col ILIKE $m ...)` para esa columna.
function likeAny(params, column, patterns) {
  const parts = patterns.map((p) => { params.push(p); return `${column} ILIKE $${params.length}`; });
  return `(${parts.join(' OR ')})`;
}

// Escapa los comodines de LIKE (% _ \) en un término de búsqueda: sin esto,
// buscar '%' devuelve toda la tabla. Se aplica en los listados de clientes,
// leads y servicios (y en phoneSearchPatterns, que construye sus patrones
// con el término ya escapado).
function escapeLike(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// Paginación con tope, igual que /api/system/events: página >= 1 y
// límite 1–200 (page=0 daba OFFSET negativo -> 500; limit=1000000
// volcaba la tabla). Se usa en /api/clients, /api/leads y /api/services.
function clampPagination(query) {
  const page = Math.max(1, parseInt(query?.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(query?.limit, 10) || 50, 1), 200);
  return { page, limit, offset: (page - 1) * limit };
}

// ---------- WHATSAPP META CLOUD API v5 Parte 2B ----------
// Alternativa oficial a la conexión por QR (whatsapp-web.js): los mensajes
// salen por la API de Meta y entran por webhook, sin navegador ni QR.
// Configuración (el token NUNCA se devuelve al frontend):
// - META_WA_TOKEN y META_WA_PHONE_NUMBER_ID: en .env, o en Ajustes del CRM
//   (claves settings meta_wa_token / meta_wa_phone_number_id, solo admin).
//   Lo guardado en settings tiene prioridad sobre el .env.
// - META_WA_VERIFY_TOKEN y META_WA_APP_SECRET: solo en .env (el webhook los
//   necesita al arrancar y no hay UI para ellos).
// Sin token o sin phone number id, Meta se considera no configurado y todo
// sigue saliendo por QR como antes.
const META_WA_VERIFY_TOKEN = (process.env.META_WA_VERIFY_TOKEN || '').trim();
const META_WA_APP_SECRET = (process.env.META_WA_APP_SECRET || '').trim();

async function getMetaConfig() {
  let tokenFromSettings = '';
  let phoneFromSettings = '';
  if (dbOk) {
    try {
      tokenFromSettings = (await getSettingValue('meta_wa_token', '')) || '';
      phoneFromSettings = (await getSettingValue('meta_wa_phone_number_id', '')) || '';
    } catch { /* sin tabla settings aún: cae al .env */ }
  }
  const token = (tokenFromSettings || '').trim() || (process.env.META_WA_TOKEN || '').trim();
  const phoneNumberId = (phoneFromSettings || '').trim() || (process.env.META_WA_PHONE_NUMBER_ID || '').trim();
  return {
    token,
    phoneNumberId,
    verifyToken: META_WA_VERIFY_TOKEN,
    appSecret: META_WA_APP_SECRET,
    configured: Boolean(token && phoneNumberId),
    tokenSource: tokenFromSettings.trim() ? 'settings' : ((process.env.META_WA_TOKEN || '').trim() ? 'env' : 'none'),
    verifyTokenConfigured: Boolean(META_WA_VERIFY_TOKEN),
    appSecretConfigured: Boolean(META_WA_APP_SECRET),
  };
}

// v5.3.11 — Envío por ESCANEO de la lista de chats (en vez de buscar el
// chat por id). El log de v5.3.10 probó que TODA búsqueda por id falla para
// este contacto LID: `getChatById` LANZA "r" (pasa por getChatModel, que
// llama chat.serialize()/formattedTitle/Msg.get(lastReceivedKey)) y
// `sendMessage` devuelve undefined ("chat no encontrado") tanto para el
// @lid como para el @c.us. Pero el chat EXISTE: los eventos lo entregan y
// la propia librería escanea la colección en `getChats`
// (Utils.js:921: `Chat.getModelsArray()`). Así que el envío busca el chat
// ESCANEANDO la colección en la página y, si lo encuentra, envía con ESE
// objeto chat llamando a `window.WWebJS.sendMessage(chat, content,
// options)` en el mismo evaluate (replica el cuerpo del evaluate de
// Client.sendMessage, Client.js:1535-1555, sin el getChat ni el sendSeen,
// que son justo los pasos que fallan). Devuelve { ok, found, messageId,
// error }: found=false si el escaneo no encontró el chat (el llamador
// cae al camino por id de siempre); ok=false con found=true si el chat
// existe pero el envío falló (también se cae al camino por id).
async function sendWaByScan(client, target, { digits, lid, content, media }) {
  const lidDigits = String(lid || '').replace(/@lid$/, '').replace(/\D/g, '');
  let scan;
  try {
    scan = await client.pupPage.evaluate(async (args) => {
      const out = { found: false, totalChats: 0, matchedIds: [], sent: false, messageId: null, error: null };
      let chats = null;
      try {
        chats = window.require('WAWebCollections').Chat.getModelsArray();
      } catch (e) {
        out.error = 'escaneo de chats lanzó: ' + (e && e.message);
        return out;
      }
      out.totalChats = chats ? chats.length : 0;
      for (const c of chats || []) {
        try {
          const id = c && c.id;
          const ser = id && (id._serialized || id.$1);
          const user = id && id.user;
          if (!ser && !user) continue;
          if (ser === (args.lidDigits + '@lid') || user === args.lidDigits || ser === (args.phoneDigits + '@c.us') || user === args.phoneDigits) {
            out.matchedIds.push(ser || (user + '@' + (id.server || 'c.us')));
          }
        } catch (e) { /* un chat raro no tumba el escaneo */ }
      }
      if (!out.matchedIds.length) return out;
      out.found = true;
      let chat = null;
      for (const c of chats) {
        const ser = c && c.id && (c.id._serialized || c.id.$1);
        if (ser === out.matchedIds[0]) { chat = c; break; }
      }
      if (!chat) { out.error = 'chat no re-encontrado tras el escaneo'; return out; }
      try {
        const options = {};
        if (args.media) {
          options.media = args.media;
          options.caption = args.caption;
          if (args.sendMediaAsDocument) options.sendMediaAsDocument = true;
        }
        const msg = await window.WWebJS.sendMessage(chat, args.content || '', options);
        if (!msg) { out.error = 'WWebJS.sendMessage devolvió vacío'; return out; }
        out.sent = true;
        try {
          const model = window.WWebJS.getMessageModel(msg);
          const mid = model && model.id;
          out.messageId = typeof mid === 'string' ? mid : (mid && (mid._serialized || mid.$1)) || (msg.id && (msg.id._serialized || msg.id.$1)) || null;
        } catch (e) {
          out.messageId = (msg.id && (msg.id._serialized || msg.id.$1)) || null;
        }
        return out;
      } catch (e) {
        out.error = (e && e.message) || String(e);
        return out;
      }
    }, {
      lidDigits,
      phoneDigits: digits,
      content: content || '',
      media: media ? { data: media.data, mimetype: media.mimetype, filename: media.filename || 'archivo' } : null,
      caption: content || undefined,
      sendMediaAsDocument: media?.type === 'document',
    });
  } catch (e) {
    logger.warn(`WhatsApp (${target}): escaneo de chats falló: ${e?.message || e}`);
    return { found: false, ok: false, error: e?.message || String(e) };
  }
  logger.info(`WhatsApp (${target}): escaneo de chats: ${scan?.totalChats ?? '?'} chats en lista, ${scan?.matchedIds?.length || 0} coincidencias${scan?.matchedIds?.length ? ` (${scan.matchedIds.join(', ')})` : ''}`);
  if (!scan?.found) return { found: false, ok: false };
  if (scan.sent) {
    logger.info(`WhatsApp (${target}): mensaje enviado por escaneo al chat ${scan.matchedIds[0]}`);
    return { found: true, ok: true, messageId: scan.messageId || null };
  }
  logger.warn(`WhatsApp (${target}): envío por escaneo al chat ${scan.matchedIds[0]} falló: ${scan.error || 'sin error'}`);
  return { found: true, ok: false, error: scan.error || 'El envío por escaneo no devolvió mensaje' };
}

// Envío unificado de WhatsApp. Canal 'meta' -> API oficial de Meta;
// canal 'qr' -> cliente whatsapp-web.js de la instancia indicada (o la
// primera lista, si no se indica). Devuelve { ok, channel, ... } y nunca
// lanza: el llamador registra el error en system_events.
// v5.3.6: media opcional { type, mimetype, data (base64), filename,
// attachmentUrl (relativa, para Meta) }. Devuelve además messageId (id del
// mensaje enviado) para guardarlo como external_id y no duplicarlo cuando
// llegue el evento message_create.
async function sendWhatsAppMessage({ phone, content, channel = 'qr', instanceId = null, media = null }) {
  // El número debe normalizar a móvil colombiano (10 dígitos 3... o 12
  // dígitos 57... con móvil): antes bastaba con que hubiera dígitos y un
  // fijo o un número corto se intentaba enviar igual.
  const { phone: normPhone, normalized } = normalizePhoneCO(phone);
  const digits = normPhone.replace(/\D/g, '');
  if (!content && !media) return { ok: false, channel, error: 'Contenido vacío' };
  if (!normalized || !digits) return { ok: false, channel, error: 'Teléfono vacío o inválido (se esperaba un móvil colombiano)' };

  if (channel === 'meta') {
    const meta = await getMetaConfig();
    if (!meta.configured) {
      return { ok: false, channel: 'meta', error: 'Meta Cloud API no configurado: falta el token o el phone number id (Canales WhatsApp > Meta, o META_WA_TOKEN / META_WA_PHONE_NUMBER_ID en .env)' };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let payload;
      if (media) {
        // Meta solo acepta media por enlace público: el adjunto vive en
        // /uploads/... y la URL pública es la del dominio del servidor.
        const base = await getPublicBaseUrl();
        if (!base || !media.attachmentUrl) {
          clearTimeout(timer);
          return { ok: false, channel: 'meta', error: 'Multimedia por Meta no soportado todavía: falta la URL pública del servidor (PUBLIC_BASE_URL en .env o dominio de Railway)' };
        }
        const link = `${base}${media.attachmentUrl}`;
        const caption = content || undefined;
        const mtype = media.type === 'video' ? 'video' : media.type === 'audio' ? 'audio' : media.type === 'document' ? 'document' : media.type === 'sticker' ? 'sticker' : 'image';
        const mediaObj = mtype === 'document' ? { link, caption, filename: media.filename || 'documento' } : { link, ...(caption ? { caption } : {}) };
        payload = { messaging_product: 'whatsapp', to: digits, type: mtype, [mtype]: mediaObj };
      } else {
        payload = { messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: content } };
      }
      const res = await fetch(`https://graph.facebook.com/v19.0/${meta.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${meta.token}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, channel: 'meta', error: data?.error?.message || `Meta respondió ${res.status}` };
      return { ok: true, channel: 'meta', messageId: data?.messages?.[0]?.id || null };
    } catch (e) {
      return { ok: false, channel: 'meta', error: e.message };
    }
  }

  let target = null;
  if (instanceId && waClients[instanceId]?.status === 'ready' && waClients[instanceId].client) target = instanceId;
  else target = Object.keys(waClients).find((k) => waClients[k].status === 'ready' && waClients[k].channel !== 'meta' && waClients[k].client);
  if (!target) return { ok: false, channel: 'qr', error: 'Ninguna instancia de WhatsApp por QR lista' };
  // v5.3.9 — Envío por LID con fallback (texto Y media): el chat de un
  // contacto LID vive en WhatsApp Web bajo su @lid; enviar al @c.us revienta
  // en los getters internos ("Data passed to getter must include an id
  // property..."). La librería SÍ soporta chats @lid (su sendMessage usa
  // el usuario LID como remitente cuando chat.id.isLid()). Si se conoce el
  // LID se prueba primero y, si falla con ese error (o el chat no existe),
  // se reintenta UNA vez con el @c.us, y viceversa. Un error distinto es
  // final: no se prueba el otro id para no enmascarar el fallo real.
  // v5.3.10 — Orden de chatIds: [id canónico guardado del tráfico en
  // vivo, LID mapeado, @c.us]. El log de v5.3.9 probó que el LID solo no
  // bastó: getChat devolvió null tanto para el @lid como para el @c.us.
  // Por eso, antes de enviar se resuelve el chat con getChatById (método
  // público de la librería) y se registra si se encontró y con qué id
  // canónico; el envío se intenta igual (el getChat interno del envío
  // hace findOrCreateLatestChat), pero el log ya dice la verdad.
  const canonical = await getWaChatIdForDigits(digits).catch(() => null);
  const lid = await getWaLidForDigits(digits).catch(() => null);
  const chatIds = [...new Set([canonical, lid, `${digits}@c.us`].filter(Boolean))];
  const WA_GETTER_ERROR = /must include an id property/i;
  // v5.3.11 — PRIMERO el escaneo (sendWaByScan): si encuentra el chat en
  // la lista y envía, listo. Si no lo encuentra o el envío por escaneo
  // falla, se cae al camino por id de siempre (LID -> @c.us).
  const scanRes = await sendWaByScan(waClients[target].client, target, { digits, lid, content, media });
  if (scanRes?.ok) {
    return { ok: true, channel: 'qr', instance: target, messageId: scanRes.messageId ? waMsgSerializedId({ id: scanRes.messageId }) : null };
  }
  let lastError = null;
  for (const chatId of chatIds) {
    let sent;
    // Pre-chequeo diagnóstico: ¿existe el chat bajo este id?
    try {
      const chat = await waClients[target].client.getChatById(chatId);
      const foundId = chat?.id?._serialized || chat?.id?.$1 || null;
      logger.info(`WhatsApp (${target}): pre-chequeo del chat ${chatId}: ${chat ? `encontrado (canónico: ${foundId || chatId})` : 'NO encontrado por getChatById; se intenta el envío igual'}`);
    } catch (e) {
      logger.warn(`WhatsApp (${target}): pre-chequeo del chat ${chatId} falló: ${e?.message || e}; se intenta el envío igual`);
    }
    try {
      if (media) {
        const waMedia = new MessageMedia(media.mimetype, media.data, media.filename || 'archivo');
        sent = await waClients[target].client.sendMessage(chatId, waMedia, { caption: content || undefined, sendMediaAsDocument: media.type === 'document' });
      } else {
        sent = await waClients[target].client.sendMessage(chatId, content);
      }
    } catch (e) {
      lastError = e;
      const m = e?.message || String(e);
      logger.warn(`WhatsApp (${target}): envío al chat ${chatId} falló: ${m}`);
      if (!WA_GETTER_ERROR.test(m)) break; // otro error: probar el otro id no ayudaría
      continue; // error del getter: probar con el otro chatId
    }
    if (!sent) {
      // La librería devuelve undefined cuando getChat no encontró el chat:
      // antes se reportaba como enviado (ok:true, messageId null).
      lastError = new Error(`WhatsApp no encontró el chat ${chatId}`);
      logger.warn(`WhatsApp (${target}): la librería devolvió undefined al enviar al chat ${chatId} (chat no encontrado)`);
      continue; // probar con el otro chatId, si lo hay
    }
    logger.info(`WhatsApp (${target}): mensaje enviado al chat ${chatId}`);
    return { ok: true, channel: 'qr', instance: target, messageId: sent?.id ? waMsgSerializedId(sent) : null };
  }
  // Error final claro: si fue "chat no encontrado", listar todos los ids
  // que se probaron, para que el próximo log diga exactamente qué falló.
  if (lastError && /no encontró el chat/.test(lastError.message)) {
    return { ok: false, channel: 'qr', error: `WhatsApp no encontró el chat para ${phone} (se probaron: ${chatIds.join(', ')})` };
  }
  return { ok: false, channel: 'qr', error: lastError?.message || 'No se pudo enviar el mensaje' };
}

// Entrada de mensajes: la MISMA lógica para el QR (whatsapp-web.js) y para
// el webhook de Meta. Normaliza el teléfono, crea cliente/conversación si no
// existen y guarda el mensaje. El id de conversación es wa_<dígitos sin +>
// (sin el + para que no se rompa en la URL /api/chats/:id/messages); el
// teléfono guardado sí lleva el +57. externalId (wamid de Meta) evita
// duplicados: la columna messages.external_id es UNIQUE.
// v5.3.6: sender ('client' por defecto, 'agent' para los enviados desde el
// teléfono), type ('text', 'image', 'audio', 'video', 'document', 'sticker'),
// attachmentUrl y incrementUnread (false en los propios: no son no leídos).
async function handleIncomingWhatsApp({ phone: rawPhone, content, sourceName, channel = 'qr', externalId = null, senderName = null, sender = 'client', type = 'text', attachmentUrl = null, incrementUnread = true }) {
  const { phone } = normalizePhoneCO(rawPhone);
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  let conversationId = `wa_${digits}`;
  const displayName = (senderName || '').trim() || phone;
  const unreadDelta = incrementUnread ? 1 : 0;
  // Las 3 escrituras (cliente, conversación, mensaje) van en una
  // transacción: antes, si fallaba la tercera, quedaban cliente y
  // conversación huérfanos sin mensaje.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let clientRes = await client.query('SELECT * FROM clients WHERE phone = $1', [phone]);
    if (clientRes.rows.length === 0) {
      await client.query('INSERT INTO clients (phone, name, source) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING', [phone, displayName, sourceName]);
    }

    let convRes = await client.query('SELECT * FROM conversations WHERE client_phone = $1', [phone]);
    if (convRes.rows.length === 0) {
      await client.query(
        'INSERT INTO conversations (id, client_phone, client_name, source, status, last_message, last_message_time, unread_count, channel) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) ON CONFLICT (id) DO UPDATE SET last_message = EXCLUDED.last_message, last_message_time = NOW(), unread_count = conversations.unread_count + $7, channel = EXCLUDED.channel',
        [conversationId, phone, displayName, sourceName, 'open', content, unreadDelta, channel]
      );
    } else {
      conversationId = convRes.rows[0].id;
      await client.query(
        'UPDATE conversations SET last_message = $1, last_message_time = NOW(), unread_count = unread_count + $4, channel = $3 WHERE id = $2',
        [content, conversationId, channel, unreadDelta]
      );
    }

    // v5.3.11 — Dedup de ECOS propios: la librería emite message_create
    // DOS veces por el mismo mensaje enviado desde el teléfono (eco local
    // + versión del servidor, con 39 ms de diferencia en el log de
    // v5.3.10) y con external_id DISTINTO, así que el dedup por
    // external_id no los caza: 1 guardado fallido del CRM + 2 ecos = las
    // 3 burbujas que ve el usuario. Para sender 'agent', si en los últimos
    // 60 s ya se guardó un mensaje idéntico en esta conversación (mismo
    // type, content y adjunto), no se guarda otra copia. No toca el dedup
    // por external_id ni el de fallidos de 5 min.
    let skipEcho = false;
    if (sender === 'agent') {
      const echo = await client.query(
        `SELECT id FROM messages WHERE conversation_id = $1 AND sender = 'agent' AND type = $2 AND content = $3 AND attachment_url IS NOT DISTINCT FROM $4 AND timestamp > NOW() - INTERVAL '60 seconds' LIMIT 1`,
        [conversationId, type, content, attachmentUrl]
      );
      skipEcho = echo.rows.length > 0;
      if (skipEcho) logger.info(`Chat ${conversationId}: eco propio duplicado (mismo mensaje de agente en 60 s); no se guarda otra copia.`);
    }
    if (!skipEcho) {
      await client.query(
        'INSERT INTO messages (conversation_id, sender, type, content, attachment_url, timestamp, external_id) VALUES ($1, $2, $3, $4, $5, NOW(), $6) ON CONFLICT (external_id) DO NOTHING',
        [conversationId, sender, type, content, attachmentUrl, externalId]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
  }

  notifyUpdate('webhook_message');
  return conversationId;
}

// --- v5.3.6: MULTIMEDIA Y SINCRONIZACIÓN DE ENVIADOS ---
// Tope de 25 MB por archivo de media (entrante y saliente). WhatsApp Web
// acepta menos en foto/video/audio (~16 MB), así que un envío grande puede
// fallar en WhatsApp aunque el CRM lo guarde: el fallo queda en sent=false.
const WA_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
// --- v5.3.7: UN SOLO VOLUMEN PERSISTENTE (PERSIST_DIR) ---
// Railway permite UN solo volumen por servicio: la sesión de WhatsApp y
// los archivos (logo, multimedia) tienen que vivir en el MISMO volumen.
// PERSIST_DIR es la ruta de montaje de ese volumen (en Railway: /app/data).
//  - Con PERSIST_DIR: LocalAuth usa PERSIST_DIR como dataPath (NO
//    PERSIST_DIR/.wwebjs_auth): al remontar el volumen viejo en /app/data,
//    los archivos de sesión quedan en la raíz del volumen, o sea en
//    /app/data/session-wa-session-<id>/, justo donde LocalAuth los busca
//    (verificado en whatsapp-web.js 1.34.7: LocalAuth acepta dataPath y la
//    sesión es path.join(dataPath, 'session-' + clientId)). La sesión NO
//    se pierde y no hay que reescanear el QR. Los archivos van a
//    PERSIST_DIR/uploads.
//  - Sin PERSIST_DIR: todo igual que siempre (sesión en ./.wwebjs_auth
//    relativo al cwd, archivos en <app>/uploads). VPS/docker-compose no
//    cambia nada: sigue con sus dos volúmenes.
// Son funciones perezosas a propósito: __dirname se define más abajo en
// este módulo ES y una const evaluada aquí daría ReferenceError (ver v5.3.6).
function persistDir() {
  const d = (process.env.PERSIST_DIR || '').trim();
  return d || null;
}
function uploadsDir() {
  const p = persistDir();
  return p ? path.join(p, 'uploads') : path.join(__dirname, 'uploads');
}
function waDataDir() {
  const p = persistDir();
  return p || path.resolve('.wwebjs_auth');
}
function waMediaDir() { return path.join(uploadsDir(), 'wa-media'); }
const WA_MEDIA_LABELS = { image: '📷 Imagen', audio: '🎤 Nota de voz', video: '🎬 Video', document: '📎 Documento', sticker: '😀 Sticker' };
// Tipos de whatsapp-web.js que son media real (además de 'chat' = texto).
// 'ptt' es nota de voz y se guarda como 'audio', igual que el composer.
const WA_MEDIA_MSG_TYPES = ['image', 'audio', 'ptt', 'video', 'document', 'sticker'];
function waMediaTypeFromMessage(msg) {
  switch (msg.type) {
    case 'image': return 'image';
    case 'audio': case 'ptt': return 'audio';
    case 'video': return 'video';
    case 'document': return 'document';
    case 'sticker': return 'sticker';
    default: return null;
  }
}
const WA_MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'video/webm': 'webm', 'application/pdf': 'pdf',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};
function waMediaExtFromMime(mimetype, filename) {
  if (WA_MIME_EXT[mimetype]) return WA_MIME_EXT[mimetype];
  const fromName = String(filename || '').split('.').pop();
  if (fromName && /^[A-Za-z0-9]{2,5}$/.test(fromName)) return fromName.toLowerCase();
  return 'bin';
}
function waMediaTypeFromMime(mimetype) {
  const m = String(mimetype || '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}
// URL pública del servidor (para que Meta pueda bajar un adjunto por enlace).
// Railway la expone como RAILWAY_PUBLIC_DOMAIN; en VPS se pone
// PUBLIC_BASE_URL en .env. Sin URL pública, la media por Meta no se envía.
async function getPublicBaseUrl() {
  const envUrl = (process.env.PUBLIC_BASE_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/$/, '');
  const railwayDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railwayDomain) return `https://${railwayDomain}`;
  try {
    const v = await getSettingValue('public_base_url', '');
    if (v && String(v).trim()) return String(v).trim().replace(/\/$/, '');
  } catch { /* sin URL pública */ }
  return '';
}

// v5.3.10 — Normalización del id de mensaje de WhatsApp Web.
// En producción (log v5.3.9) el id NO trae `_serialized`: la forma
// serializada está en `$1`:
// {"fromMe":true,"remote":"265076942618676@lid","id":"AC426D0F43A9E3C1CEA515495A4EFC45",
//  "$1":"true_265076942618676@lid_AC426D0F43A9E3C1CEA515495A4EFC45"}.
// Por eso: (a) `msg.downloadMedia()` fallaba, porque la librería busca el
// mensaje por `this.id._serialized` (undefined) — el evaluate de puppeteer
// rechaza con el valor "r"; (b) el external_id quedaba NULL y el dedup por
// external_id nunca funcionaba (los NULL no chocan en el UNIQUE);
// (c) el messageId de los envíos también quedaba NULL.
// Orden: _serialized, $1, y como último recurso fromMe_remote_id.
function waMsgSerializedId(msg) {
  const id = msg?.id;
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (id._serialized) return String(id._serialized);
  if (id.$1) return String(id.$1);
  if (id.remote && id.id) return `${id.fromMe ? 'true' : 'false'}_${id.remote}_${id.id}`;
  return null;
}

// v5.3.10 — Id canónico del chat, persistido desde el tráfico en vivo.
// En la librería (whatsapp-web.js 1.34.7, Message.js:388 y _getChatId
// :347-349): `Message.getChat()` es `getChatById(this.fromMe ? this.to
// : this.from)` — o sea que el id canónico del chat 1:1 ES el id del
// interlocutor (msg.from en entrantes, msg.to en enviados desde el
// teléfono). Se guarda en settings (wa_chatid_<dígitos>) cada vez que
// llega un mensaje de esa conversación, para que el envío lo pruebe
// primero. Misma mecánica best-effort que el mapeo LID.
const waChatIdByDigits = new Map(); // dígitos -> '2650...@lid' o '57311...@c.us'
async function saveWaChatIdMapping(digits, chatId) {
  const d = String(digits || '').replace(/\D/g, '');
  const c = String(chatId || '').trim();
  if (!d || !/^(\d+@lid|\d+@c\.us)$/.test(c)) return;
  waChatIdByDigits.set(d, c);
  try {
    await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`wa_chatid_${d}`, c]);
  } catch { /* solo memoria: se re-aprende con el próximo mensaje */ }
}
async function getWaChatIdForDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return null;
  if (waChatIdByDigits.has(d)) return waChatIdByDigits.get(d);
  try {
    const v = await getSettingValue(`wa_chatid_${d}`, '');
    const c = String(v || '').trim();
    if (/^(\d+@lid|\d+@c\.us)$/.test(c)) { waChatIdByDigits.set(d, c); return c; }
  } catch { /* sin id guardado */ }
  return null;
}

// v5.3.9 — Mapeo LID→número persistido.
// En producción el chat de un contacto LID vive en WhatsApp Web bajo su
// @lid (265076942618676@lid) y abordarlo por el número (@c.us) revienta
// dentro de los getters internos de WhatsApp ("Data passed to getter must
// include an id property (it's how we memoize) but got undefined").
// Cada vez que un mensaje LID se resuelve a un número, el mapeo se guarda
// en settings (wa_lid_<dígitos> = <lid>@lid) y en memoria, para que el
// envío use el LID. La escritura es best-effort y nunca rompe el flujo de
// mensajes: si la DB no está disponible, queda solo en memoria y se
// re-aprende con el próximo mensaje del contacto.
const waLidByDigits = new Map(); // dígitos -> '2650...@lid'
async function saveWaLidMapping(digits, lid) {
  const d = String(digits || '').replace(/\D/g, '');
  const l = String(lid || '').trim();
  if (!d || !/^\d+@lid$/.test(l)) return;
  waLidByDigits.set(d, l);
  try {
    await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`wa_lid_${d}`, l]);
  } catch { /* solo memoria: se re-aprende con el próximo mensaje */ }
}
async function getWaLidForDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return null;
  if (waLidByDigits.has(d)) return waLidByDigits.get(d);
  try {
    const v = await getSettingValue(`wa_lid_${d}`, '');
    const l = String(v || '').trim();
    if (/^\d+@lid$/.test(l)) { waLidByDigits.set(d, l); return l; }
  } catch { /* sin mapeo guardado */ }
  return null;
}

// Resuelve el teléfono del interlocutor de un mensaje de WhatsApp Web.
// peerId es msg.from (entrante) o msg.to (enviado desde el teléfono).
// getContact es la forma de pedir el contacto: entrante usa msg.getContact()
// (probado en v5.3.5); saliente usa client.getContactById(msg.to), porque
// en message_create msg.getContact() devolvería el propio número.
// Devuelve { phone, senderName } o null (con el motivo en el log).
// La lógica LID es la de v5.3.5: 1º contact.id._serialized, 2º number.
async function resolveWaPeerPhone(peerId, getContact, name) {
  const raw = String(peerId || '');
  if (!raw) return null;
  if (raw.endsWith('@lid')) {
    const lidDigits = raw.split('@')[0];
    try {
      const contact = await getContact();
      const idSerialized = String(contact?.id?._serialized || '');
      const numberField = String(contact?.number || '');
      const senderName = (contact?.pushname || contact?.name || '').trim() || null;
      const candidates = [];
      if (idSerialized.endsWith('@c.us')) candidates.push(idSerialized.split('@')[0].replace(/\D/g, ''));
      candidates.push(numberField.replace(/\D/g, ''));
      const candidate = candidates.find((c) => c && c !== lidDigits && /^\d{7,15}$/.test(c));
      if (candidate) {
        logger.info(`WhatsApp ${name}: remitente LID ${raw} resuelto al número ${candidate}`);
        // v5.3.9: persistir el mapeo LID→número (también en mensajes de
        // solo texto) para que el envío use el LID. Sin await: best-effort,
        // la promesa nunca rechaza (el upsert lleva su propio try/catch).
        saveWaLidMapping(candidate, raw);
        return { phone: candidate, senderName };
      }
      logger.warn(`WhatsApp ${name}: no se pudo resolver el número del remitente LID ${raw} (contacto id=${idSerialized || 'desconocido'} number=${numberField || 'vacío'}); mensaje descartado.`);
      return null;
    } catch (e) {
      logger.warn(`WhatsApp ${name}: error resolviendo el remitente LID ${raw}; mensaje descartado.`, e?.message || e);
      return null;
    }
  }
  if (raw.endsWith('@c.us')) return { phone: raw.replace('@c.us', ''), senderName: null };
  return null;
}

// Descarga la media de un mensaje de WhatsApp Web y la guarda en
// v5.3.11 — Descarga DEFENSIVA de media, con evaluate propio (no usa
// `msg.downloadMedia()`). El log de v5.3.10 probó que la normalización del
// id de v5.3.10 SÍ funcionó (el id ya llega con `_serialized`), pero la
// descarga SIGUE fallando, ahora con error "t": en la librería
// (Message.js:513) la búsqueda es `Msg.get(msgId) ||
/// getMessagesById([msgId])` SIN try/catch alrededor del `Msg.get` — si
// `Msg.get` LANZA (en vez de devolver undefined), el fallback a
// `getMessagesById` nunca se ejecuta y todo el evaluate rechaza. Por eso
// cada paso aquí tiene SU PROPIO try/catch y su línea de log: (a) Msg.get,
// (b) getMessagesById, (c) escaneo de `Msg.getModelsArray()` buscando el
// id serializado (mismo patrón que usa la librería para los chats), y solo
// con el mensaje encontrado se intenta resolver la media y el
// downloadAndMaybeDecrypt (lógica copiada de Message.js:513-590).
// Devuelve { data, mimetype, filename, filesize, foundBy, steps } o
// { error, found, foundBy, steps, mediaStage, hasDirectPath }.
async function downloadWaMediaFromPage(client, name, idStr) {
  const pupPage = client?.pupPage;
  if (!pupPage) return { error: 'sin pupPage en el cliente' };
  let r;
  try {
    r = await pupPage.evaluate(async (msgId) => {
      const out = { found: false, foundBy: null, steps: [], mediaStage: null, hasDirectPath: false, mimetype: null, data: null, filename: null, filesize: null, error: null };
      const MsgCol = window.require('WAWebCollections').Msg;
      let msg = null;
      // (a) Msg.get con try/catch propio: si lanza, no mata el resto.
      try {
        msg = MsgCol.get(msgId) || null;
        if (msg) out.foundBy = 'get';
        else out.steps.push('get: null');
      } catch (e) { out.steps.push('get lanzó: ' + (e && e.message)); }
      // (b) getMessagesById con try/catch propio.
      if (!msg) {
        try {
          const res = await MsgCol.getMessagesById([msgId]);
          msg = (res && res.messages && res.messages[0]) || null;
          if (msg) out.foundBy = 'getMessagesById';
          else out.steps.push('getMessagesById: sin mensajes');
        } catch (e) { out.steps.push('getMessagesById lanzó: ' + (e && e.message)); }
      }
      // (c) Escaneo de la colección de mensajes por id serializado.
      if (!msg && typeof MsgCol.getModelsArray === 'function') {
        try {
          const arr = MsgCol.getModelsArray();
          out.steps.push('scan: ' + arr.length + ' mensajes en la colección');
          for (const m of arr) {
            const sid = m && m.id && (m.id._serialized || m.id.$1);
            if (sid === msgId) { msg = m; out.foundBy = 'scan'; break; }
          }
          if (!msg) out.steps.push('scan: sin coincidencia');
        } catch (e) { out.steps.push('scan lanzó: ' + (e && e.message)); }
      }
      if (!msg) { out.error = 'mensaje no encontrado en la colección'; return out; }
      out.found = true;
      out.mediaStage = (msg.mediaData && msg.mediaData.mediaStage) || null;
      out.hasDirectPath = !!msg.directPath;
      out.mimetype = msg.mimetype || null;
      if (!msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') { out.error = 'sin mediaData o REUPLOADING'; return out; }
      if (msg.mediaData.mediaStage !== 'RESOLVED') {
        try { await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 }); }
        catch (e) { out.steps.push('downloadMedia lanzó: ' + (e && e.message)); }
        out.mediaStage = (msg.mediaData && msg.mediaData.mediaStage) || null;
      }
      if ((msg.mediaData.mediaStage || '').includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') { out.error = 'mediaStage tras resolver: ' + msg.mediaData.mediaStage; return out; }
      try {
        const mockQpl = { addAnnotations: function () { return this; }, addPoint: function () { return this; } };
        const decrypted = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath,
          encFilehash: msg.encFilehash,
          filehash: msg.filehash,
          mediaKey: msg.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp,
          type: msg.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });
        out.data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
        out.filename = msg.filename || null;
        out.filesize = msg.size || null;
      } catch (e) {
        if (e && e.status === 404) { out.error = 'descarga 404'; return out; }
        out.error = 'downloadAndMaybeDecrypt lanzó: ' + (e && e.message);
      }
      return out;
    }, idStr);
  } catch (e) {
    return { error: 'evaluate lanzó: ' + (e?.message || e), steps: [] };
  }
  return r || { error: 'evaluate devolvió vacío', steps: [] };
}

// uploads/wa-media/. Devuelve { type, attachmentUrl } en éxito,
// { failed: true, type } si la descarga falló (el mensaje se guarda solo
// con la etiqueta, sin descartarse), { tooLarge: true } si el archivo
// supera 25 MB (ese sí se descarta, con constancia en el log), o null si
// no hay media. v5.3.9: el log de v5.3.6 solo mostraba "no se pudo
// descargar la media del mensaje : r" (id vacío, error de una letra) y era
// imposible diagnosticar nada; ahora se registra el error completo
// (mensaje + stack + id serializado como JSON + type + from) y se reintenta
// la descarga UNA vez tras 5 s, porque la librería devuelve undefined sin
// lanzar cuando la media aún está en FETCHING (tarda en resolverse).
// v5.3.11: la descarga ya no usa `msg.downloadMedia()` sino el evaluate
// defensivo `downloadWaMediaFromPage` (cada paso con su try/catch y su
// log: encontrado por get / getMessagesById / scan, mediaStage,
// directPath). El reintento a los 5 s y el tope de 25 MB se mantienen.
async function downloadWaMedia(msg, name, client) {
  if (!msg.hasMedia) return null;
  // v5.3.10 — La librería busca el mensaje por `this.id._serialized`
  // (Message.js:513) y en producción ese campo viene vacío (la forma
  // serializada está en `$1`): se normaliza ANTES de descargar para que
  // el evaluate encuentre el mensaje. Si el objeto id no se deja escribir,
  // se sigue igual y el log lo dirá.
  try { if (msg?.id && typeof msg.id === 'object') msg.id._serialized = waMsgSerializedId(msg); } catch { /* id no escribible */ }
  const idStr = waMsgSerializedId(msg) || '';
  const idJson = (() => { try { return JSON.stringify(msg.id); } catch { return 'no-serializable'; } })();
  const type = waMediaTypeFromMessage(msg) || 'document';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let media;
    try {
      const dl = await downloadWaMediaFromPage(client, name, idStr);
      logger.info(`WhatsApp ${name}: descarga defensiva intento ${attempt}/2 del mensaje ${idStr || '(sin id)'} (type=${msg.type}): encontrado=${dl?.found ? 'sí' : 'no'} por=${dl?.foundBy || '-'} mediaStage=${dl?.mediaStage || '-'} directPath=${dl?.hasDirectPath ? 'sí' : 'no'}${dl?.steps?.length ? ` pasos=[${dl.steps.join(' | ')}]` : ''}${dl?.error ? ` error=${dl.error}` : ''}`);
      if (dl?.data) media = { data: dl.data, mimetype: dl.mimetype, filename: dl.filename, filesize: dl.filesize };
      else media = null;
    } catch (e) {
      const stack = String(e?.stack || '').split('\n').slice(0, 3).join(' | ');
      logger.warn(`WhatsApp ${name}: no se pudo descargar la media del mensaje ${idStr || '(sin id)'} (type=${msg.type} from=${msg.from} id=${idJson}): ${e?.message || e}${stack ? ` | ${stack}` : ''}`);
      media = null;
    }
    if (media?.data) {
      const size = Math.ceil((media.data.length * 3) / 4);
      if (size > WA_MEDIA_MAX_BYTES) {
        logger.warn(`WhatsApp ${name}: media de ${Math.round(size / 1024 / 1024)} MB supera el tope de 25 MB; mensaje descartado.`);
        return { tooLarge: true };
      }
      const dlType = waMediaTypeFromMessage(msg) || waMediaTypeFromMime(media.mimetype);
      const ext = waMediaExtFromMime(media.mimetype, media.filename);
      const safeId = String(waMsgSerializedId(msg) || `${Date.now()}`).replace(/[^A-Za-z0-9]/g, '_');
      const filename = `${safeId}.${ext}`;
      try {
        fs.mkdirSync(waMediaDir(), { recursive: true });
        fs.writeFileSync(path.join(waMediaDir(), filename), Buffer.from(media.data, 'base64'));
      } catch (e) {
        logger.error(`WhatsApp ${name}: no se pudo guardar la media en disco`, e?.message || e);
        return { failed: true, type: dlType };
      }
      return { type: dlType, attachmentUrl: `/uploads/wa-media/${filename}` };
    }
    if (attempt === 1) {
      logger.info(`WhatsApp ${name}: descarga de media sin datos (intento 1/2, type=${msg.type}); reintentando en 5 s.`);
      await sleep(5000);
    }
  }
  logger.warn(`WhatsApp ${name}: la media del mensaje ${idStr || '(sin id)'} (type=${msg.type}) no se pudo descargar tras 2 intentos; el mensaje se guarda solo con la etiqueta.`);
  return { failed: true, type };
}

// Procesa UN mensaje de WhatsApp Web (entrante o enviado desde el teléfono)
// y lo guarda con handleIncomingWhatsApp. Devuelve true si se guardó
// (o ya estaba guardado por external_id) y false si se ignoró.
// opts: { id, name, sourceName, channel, sender ('client'|'agent'),
//   incrementUnread (bool), getContact (fn) }.
async function processWaMessage(msg, opts) {
  const { id, name, sourceName, channel, sender, incrementUnread, getContact } = opts;
  const peerId = sender === 'agent' ? msg.to : msg.from;
  const resolved = await resolveWaPeerPhone(peerId, getContact, name);
  if (!resolved) return false;
  const { phone, senderName } = resolved;
  // v5.3.10 — Persistir el id canónico del chat desde el tráfico en vivo:
  // en la librería, `Message.getChat()` es `getChatById(fromMe ? to :
  // from)`, así que el id canónico del chat 1:1 ES el peerId. Se guarda
  // para que el próximo envío lo pruebe primero. Best-effort, sin await.
  saveWaChatIdMapping(phone.replace(/\D/g, ''), peerId);
  let type = 'text';
  let content = (msg.body || '').trim();
  let attachmentUrl = null;
  const mediaType = waMediaTypeFromMessage(msg);
  if (mediaType) {
    const dl = await downloadWaMedia(msg, name, waClients[id]?.client);
    // v5.3.9: un archivo mayor de 25 MB se sigue descartando con
    // constancia; pero una descarga fallida YA NO descarta el mensaje:
    // se guarda con su type y la etiqueta (📷 Imagen, 🎤 Nota de voz...)
    // para que la conversación muestre al menos que llegó algo.
    if (dl && dl.tooLarge) return false;
    if (!dl) {
      type = mediaType;
      attachmentUrl = null;
    } else if (dl.failed) {
      type = dl.type;
      attachmentUrl = null;
    } else {
      type = dl.type;
      attachmentUrl = dl.attachmentUrl;
    }
    if (!content) content = WA_MEDIA_LABELS[type] || '📎 Archivo';
  } else if (msg.type !== 'chat') {
    return false;
  }
  if (!content) return false;
  waClients[id].lastSeen = new Date().toISOString();
  waClients[id].lastMessageAt = new Date().toISOString();
  logger.info(`Mensaje recibido en ${name} de ${phone}: ${content}`);
  try {
    await handleIncomingWhatsApp({ phone, content, type, attachmentUrl, sender, incrementUnread, sourceName, channel, externalId: waMsgSerializedId(msg), senderName });
  } catch (err) {
    logger.error('Error procesando mensaje de WhatsApp', err);
  }
  return true;
}

// Lee un adjunto ya subido a uploads/wa-media/ para enviarlo por WhatsApp.
// Devuelve { mimetype, data (base64), filename, size } o { error }.
// Solo acepta rutas dentro de uploads/wa-media (nunca fuera de uploads).
function readWaAttachmentFile(attachmentUrl) {
  if (!attachmentUrl || !String(attachmentUrl).startsWith('/uploads/wa-media/')) return { error: 'Adjunto fuera de la carpeta de media' };
  // La URL es /uploads/wa-media/<archivo>: se quita el prefijo /uploads/
  // y se cuelga del uploadsDir() real (con PERSIST_DIR es /app/data/uploads).
  const rel = String(attachmentUrl).replace(/^\/uploads\//, '');
  const full = path.join(uploadsDir(), rel);
  const base = waMediaDir();
  if (!full.startsWith(base + path.sep)) return { error: 'Adjunto fuera de la carpeta de media' };
  if (!fs.existsSync(full)) return { error: 'Archivo adjunto no encontrado en el servidor' };
  const buf = fs.readFileSync(full);
  if (buf.length > WA_MEDIA_MAX_BYTES) return { error: 'El archivo supera 25 MB' };
  const ext = path.extname(full).toLowerCase().slice(1);
  const mimeByExt = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
  };
  return { mimetype: mimeByExt[ext] || 'application/octet-stream', data: buf.toString('base64'), filename: path.basename(full), size: buf.length };
}

// --- CONFIGURACIÓN DE MULTI-WHATSAPP ---
const waClients = {}; // Almacén de instancias activas

// v5.3.2 — Vigilante de "ready" y parada centralizada.
// En producción (Railway) una instancia QR se autenticaba por QR pero NUNCA
// llegaba a 'ready': sin error en el log, sin mensajes entrantes, y Estado
// del Sistema en Roto. Las causas que se corrigieron aquí:
//  (1) el flag de proceso único en puppeteer colgaba la carga de WhatsApp Web;
//  (2) al reconectar/borrar, el cliente viejo no siempre se destruía y dos
//      Chrome compartían la misma sesión LocalAuth (el 'authenticated' se
//      registró DOS veces en el log al mismo segundo);
//  (3) el servidor no restauraba las instancias al arrancar.
const waReadyAutoRetried = new Set(); // 1 reintento automático por instancia y arranque
let waWatchdogSeq = 0; // generación del vigilante: ignora temporizadores viejos

// v5.3.8 — Reintento automático por error TRANSITORIO de arranque.
// En producción (log real v5.3.7, 23:47:55 UTC) el arranque falló con
// "ProtocolError: Protocol error (Runtime.callFunctionOn): Execution
// context was destroyed" en Client.inject: la página de WhatsApp Web
// navegó/recargó mientras la librería inyectaba su JS y el contexto de
// ejecución murió. Es transitorio: reintentando, la sesión guardada se
// restaura sin pedir QR nuevo. Se reintenta hasta 3 veces con espera
// creciente (10 s, 30 s, 60 s). El contador vive fuera de initWhatsApp
// porque cada reintento recrea la instancia (nuevo closure); se reinicia
// en cada arranque "fresco" (restaurar al boot, Reconectar manual, cambio
// de canal, reintento del vigilante) y al llegar a 'ready'. Los errores NO
// transitorios (p. ej. fallos de autenticación) no reintentan.
const WA_TRANSIENT_RETRY_DELAYS = [10000, 30000, 60000];
const WA_TRANSIENT_ERROR = /Execution context was destroyed|Target closed|Session closed|Protocol error|Failed to launch|Navigation failed|net::ERR|Timeout/i;
const waTransientAttempts = {}; // id -> reintentos transitorios hechos en la cadena actual
function isTransientWaError(detail) {
  return WA_TRANSIENT_ERROR.test(String(detail || ''));
}

function clearWaWatchdog(id) {
  const t = waClients[id]?.readyWatchdog;
  if (t) { clearTimeout(t); if (waClients[id]) waClients[id].readyWatchdog = null; }
}

// v5.3.4 — Limpieza del bloqueo de perfil de Chrome (SingletonLock).
// Causa raíz del "Failed to launch the browser process: Code: 21" en
// producción (log real de Railway, deploy v5.3.3): al reemplazar el
// contenedor, el Chrome viejo muere sin liberar el bloqueo del perfil y
// el Chrome nuevo se niega a arrancar con:
// "The profile appears to be in use by another Chromium process (54) on
// another computer (600f0cb2d288). Chromium has locked the profile..."
// NO era la versión de puppeteer. LocalAuth guarda la sesión en
// .wwebjs_auth/session-wa-session-<id>/ y ese directorio ES el perfil
// (userDataDir) de Chrome, así que los bloqueos viven ahí. Borrarlos es
// seguro en este despliegue porque solo hay un contenedor a la vez: un
// bloqueo presente al arrancar es, por definición, de un Chrome muerto
// de un contenedor ya reemplazado (el propio Chrome lo delata diciendo
// "on another computer"). Se llama antes de crear el Client y, si el
// arranque falla por perfil en uso, una vez más antes de reintentar.
// Nunca lanza: si la carpeta no existe o no se puede leer, no pasa nada.
const WA_SESSION_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
function clearWaSessionLocks(id) {
  let removed = 0;
  try {
    const sessionDir = path.join(waDataDir(), `session-wa-session-${id}`);
    const stack = [[sessionDir, 0]];
    while (stack.length > 0) {
      const [dir, depth] = stack.pop();
      if (depth > 3) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            // Solo se baja a subcarpetas de perfil conocidas; el bloqueo
            // vive en la raíz del perfil, pero se busca por si acaso.
            if (entry.name === 'Default' || entry.name.startsWith('Profile ')) stack.push([full, depth + 1]);
          } else if (WA_SESSION_LOCK_FILES.includes(entry.name)) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch { /* un archivo que no se deja borrar no bloquea el arranque */ }
      }
    }
  } catch { /* carpeta inexistente o ilegible: no hay nada que limpiar */ }
  if (removed > 0) {
    logger.warn(`WhatsApp (${id}): se eliminaron ${removed} archivo(s) de bloqueo de perfil de Chrome obsoletos (SingletonLock) de una sesión anterior.`);
  }
  return removed;
}

// Detiene una instancia: limpia el vigilante, destruye el cliente (con tope
// de 10 s: un destroy colgado no puede bloquear un reconectar ni dejar un
// Chrome zombi con la sesión abierta) y borra la entrada de memoria.
// Nunca lanza.
async function stopWaInstance(id) {
  const inst = waClients[id];
  if (!inst) return;
  clearWaWatchdog(id);
  if (inst.client) {
    try {
      await Promise.race([
        inst.client.destroy(),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    } catch { /* ya estaba muerto */ }
  }
  delete waClients[id];
}

// Si una instancia QR lleva más de 120 s en 'authenticated' o
// 'initializing' sin llegar a 'ready', avisa en log y system_events e
// intenta UNA sola re-inicialización automática por arranque. Después de
// ese reintento, solo deja el estado visible para que el admin reconecte
// a mano. El token de generación evita que un temporizador viejo actúe
// sobre una instancia nueva con el mismo id.
// v5.3.8: el vigilante también actúa sobre 'error' por arranque fallido
// (tras agotar los 3 reintentos transitorios, el catch ya no lo cancela):
// un fallo de arranque no es nunca un callejón sin salida. Los errores
// NO transitorios siguen cancelando el vigilante en el catch, así que
// sobre esos no hay reintento.
function armReadyWatchdog(id, name) {
  const entry = waClients[id];
  if (!entry || (entry.channel || 'qr') !== 'qr') return;
  clearWaWatchdog(id);
  const seq = ++waWatchdogSeq;
  entry.watchdogSeq = seq;
  entry.readyWatchdog = setTimeout(async () => {
    const cur = waClients[id];
    if (!cur || cur.watchdogSeq !== seq) return; // instancia reemplazada o borrada
    if (!['authenticated', 'initializing', 'error'].includes(cur.status)) return;
    const msg = cur.status === 'error'
      ? `WhatsApp ${name} quedó en error tras fallar el arranque. Se intenta una re-inicialización automática.`
      : `WhatsApp ${name} autenticado pero sin quedar listo después de 120 s (estado: ${cur.status}). Se intenta una re-inicialización automática.`;
    logger.warn(msg);
    await recordEvent('warn', 'whatsapp', msg, { instance: id, status: cur.status });
    if (waReadyAutoRetried.has(id)) {
      logger.warn(`WhatsApp ${name}: ya se hizo el reintento automático de este arranque; queda en estado visible (${cur.status}). Usa Reconectar en Estado del Sistema.`);
      await recordEvent('warn', 'whatsapp', `WhatsApp ${name} sigue sin quedar listo tras el reintento automático. Reconecta a mano en Estado del Sistema.`, { instance: id, status: cur.status });
      return;
    }
    waReadyAutoRetried.add(id);
    try {
      await stopWaInstance(id);
      await initWhatsApp(id, name, 'qr');
    } catch (e) {
      logger.error(`WhatsApp ${name}: falló la re-inicialización automática`, e);
    }
  }, 120000);
  if (entry.readyWatchdog.unref) entry.readyWatchdog.unref();
}

// Restaura las instancias guardadas (settings wa_channel_<id>) al arrancar
// el servidor: tras un redespliegue el cliente QR vuelve a levantarse solo
// con la sesión guardada en el volumen, sin pedir QR nuevo; las instancias
// Meta son entradas virtuales sin navegador. Nunca rompe el arranque:
// cada fallo se registra y se sigue con la siguiente instancia.
async function restoreWhatsAppInstances() {
  if (!dbOk) return;
  let rows = [];
  try {
    const r = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'wa_channel_%'");
    rows = r.rows || [];
  } catch (e) {
    logger.warn('No se pudieron leer las instancias de WhatsApp guardadas para restaurarlas', e);
    return;
  }
  for (const row of rows) {
    const id = String(row.key || '').replace(/^wa_channel_/, '');
    const channel = row.value === 'meta' ? 'meta' : 'qr';
    if (!id || waClients[id]) continue;
    let name = id;
    try { name = (await getSettingValue(`wa_name_${id}`, id)) || id; } catch { /* nombre = id */ }
    try {
      logger.info(`Restaurando instancia de WhatsApp: ${name} (ID: ${id}, canal ${channel})`);
      await initWhatsApp(id, name, channel);
      // Levantar los Chrome de uno en uno: varios a la vez saturan la
      // memoria del contenedor en Railway.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e) {
      logger.error(`No se pudo restaurar la instancia de WhatsApp ${name}`, e);
      await recordEvent('error', 'whatsapp', `No se pudo restaurar la instancia ${name} al arrancar: ${e?.message || e}`, { instance: id });
    }
  }
}

const initWhatsApp = async (id, name = 'Sin Nombre', channel = 'qr', isAutoRetry = false) => {
  // v5.3.4: si ya existe una instancia en memoria, se ignora la llamada
  // pero se deja constancia de quién la hizo (el 'authenticated' x5 del
  // log de producción se investigó y NO era esto: es la librería, que
  // emite 'authenticated' en cada cambio de hasSynced del socket; ver
  // el handler de 'authenticated' más abajo).
  if (waClients[id]) {
    logger.warn(`initWhatsApp(${id}): ya existe una instancia en memoria (estado: ${waClients[id].status}, canal: ${waClients[id].channel || 'qr'}); se ignora la llamada.`);
    return;
  }
  // v5.3.8: un arranque fresco (restaurar al boot, Reconectar manual,
  // cambio de canal, reintento del vigilante) abre una cadena nueva de
  // reintentos transitorios. El reintento automático NO reinicia el
  // contador, o la cadena no terminaría nunca.
  if (!isAutoRetry) waTransientAttempts[id] = 0;
  channel = channel === 'meta' ? 'meta' : 'qr';

  // Instancia Meta (Cloud API): no hay navegador ni QR que escanear, solo
  // una entrada virtual. Su estado es 'ready' si Meta está configurado y
  // 'disconnected' si falta el token o el phone number id.
  if (channel === 'meta') {
    logger.info(`Instancia Meta registrada: ${name} (ID: ${id})`);
    const meta = await getMetaConfig();
    waClients[id] = {
      client: null,
      status: meta.configured ? 'ready' : 'disconnected',
      qr: null,
      name,
      phone: null,
      lastSeen: new Date().toISOString(),
      lastMessageAt: null,
      channel: 'meta',
    };
    recordEvent('info', 'whatsapp', `Instancia Meta registrada: ${name} (${meta.configured ? 'lista para enviar' : 'sin configurar: falta token o phone number id'})`, { instance: id });
    return;
  }

  logger.info(`Inicializando WhatsApp para: ${name} (ID: ${id})`);

  // v5.3.4: limpiar bloqueos de perfil obsoletos ANTES de arrancar Chrome
  // (ver clearWaSessionLocks): sin esto, un SingletonLock heredado del
  // contenedor anterior hace fallar el lanzamiento con Code: 21.
  clearWaSessionLocks(id);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `wa-session-${id}`, dataPath: waDataDir() }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
        // v5.3.3: '--single-process' VUELVE. En v5.3.2 se quitó pensando
        // que colgaba la página tras autenticar, pero en producción la
        // v5.3.2 no pudo ni arrancar Chrome ("Failed to launch the
        // browser process: Code: 21"), mientras que la v5.3.1 CON este
        // flag sí generaba el QR y se autenticaba. Se restaura la
        // configuración exacta que lanzaba bien en v5.3.1.
      ]
    }
  });

  waClients[id] = {
    client,
    status: 'initializing',
    qr: null,
    name,
    phone: null,
    lastSeen: new Date().toISOString(),
    lastMessageAt: null,
    channel: 'qr',
    readyWatchdog: null, // temporizador del vigilante de 'ready' (v5.3.2)
    watchdogSeq: 0, // generación del vigilante (ignora temporizadores viejos)
  };

  // v5.3.2: cada handler ignora eventos de un cliente que ya no es el
  // vigente para este id. Sin este guardia, un Chrome zombi (cliente viejo
  // no destruido del todo) podía pisar el estado de la instancia nueva y
  // dejarla en 'authenticated' para siempre, o romper el flujo interno de
  // la librería con un TypeError al escribir sobre una entrada borrada.
  const isCurrent = () => waClients[id] && waClients[id].client === client;

  client.on('qr', async (qr) => {
    if (!isCurrent()) return;
    logger.info(`QR recibido para ${name}`);
    const qrDataUrl = await qrcode.toDataURL(qr);
    waClients[id].qr = qrDataUrl;
    waClients[id].status = 'qr_ready';
    waClients[id].lastSeen = new Date().toISOString();
    io.emit('wa_qr', { id, qr: qrDataUrl, status: 'qr_ready' });
    recordEvent('info', 'whatsapp', `QR generado para ${name}: escanea el código en Canales WhatsApp`, { instance: id });
  });

  client.on('ready', () => {
    if (!isCurrent()) return;
    logger.info(`WhatsApp ${name} está listo!`);
    clearWaWatchdog(id);
    waTransientAttempts[id] = 0; // v5.3.8: cadena de reintentos cerrada con éxito
    waClients[id].status = 'ready';
    waClients[id].qr = null;
    waClients[id].lastSeen = new Date().toISOString();
    try { waClients[id].phone = client.info?.wid?.user || waClients[id].phone; } catch { /* sin número aún */ }
    io.emit('wa_status', { id, status: 'ready' });
    recordEvent('info', 'whatsapp', `WhatsApp conectado: ${name}`, { instance: id, phone: waClients[id].phone });
    if (watchdogState.whatsapp === 'error') {
      maybeAlert(`whatsapp-${id}`, `✅ WhatsApp recuperado: ${name} volvió a conectarse.`);
      watchdogState.whatsapp = 'ok';
    }
  });

  client.on('authenticated', () => {
    if (!isCurrent()) return;
    // v5.3.4 — Hallazgo del log real de producción: 'authenticated' se
    // registró CINCO veces en 4 ms con UN SOLO cliente. No eran varios
    // clientes ni varias llamadas a initWhatsApp: es la librería
    // (whatsapp-web.js 1.34.7, Client.js): el evento se emite en
    // 'onAppStateHasSyncedEvent', que la página dispara en CADA cambio
    // de 'hasSynced' del socket de WhatsApp Web, y tras escanear el QR
    // la sincronización inicial lo dispara en ráfaga. Por eso el handler
    // solo actúa en la TRANSICIÓN a 'authenticated': si ya estaba en ese
    // estado, solo refresca lastSeen y no vuelve a registrar nada (antes
    // dejaba 5 líneas de log y 5 filas en system_events por cada QR).
    if (waClients[id].status === 'authenticated') {
      waClients[id].lastSeen = new Date().toISOString();
      return;
    }
    logger.info(`WhatsApp ${name} autenticado`);
    waClients[id].status = 'authenticated';
    waClients[id].lastSeen = new Date().toISOString();
    recordEvent('info', 'whatsapp', `WhatsApp autenticado: ${name}`, { instance: id });
  });

  client.on('auth_failure', (msg) => {
    if (!isCurrent()) return;
    clearWaWatchdog(id);
    logger.error(`Error de autenticación en ${name}`, msg);
    waClients[id].status = 'auth_failure';
    waClients[id].lastSeen = new Date().toISOString();
    io.emit('wa_status', { id, status: 'auth_failure' });
    recordEvent('critical', 'whatsapp', `WhatsApp: fallo de autenticación en ${name}. Hay que volver a escanear el QR.`, { instance: id, detail: String(msg || '') });
    maybeAlert(`whatsapp-auth-${id}`, `🚨 WhatsApp (${name}): fallo de autenticación. Hay que escanear el QR de nuevo en el CRM.`);
  });

  client.on('disconnected', (reason) => {
    if (!isCurrent()) return;
    clearWaWatchdog(id);
    logger.warn(`WhatsApp ${name} desconectado: ${reason}`);
    waClients[id].status = 'disconnected';
    waClients[id].lastSeen = new Date().toISOString();
    io.emit('wa_status', { id, status: 'disconnected' });
    recordEvent('critical', 'whatsapp', `WhatsApp desconectado: ${name} (${reason || 'sin motivo'}). Los mensajes no salen hasta reconectar.`, { instance: id, reason: String(reason || '') });
    maybeAlert(`whatsapp-down-${id}`, `🚨 WhatsApp desconectado (${name}): ${reason || 'sin motivo'}. Revisa Estado del Sistema en el CRM.`);
  });

  // v5.3.6 — Multimedia entrante: además de texto ('chat') se aceptan
  // image, audio, ptt (nota de voz), video, document y sticker. La media se
  // descarga y se guarda en uploads/wa-media/ (tope 25 MB). Los grupos
  // (@g.us), estados (@broadcast) y mensajes de sistema (e2e_notification,
  // notification_template) se siguen ignorando; la resolución LID y el
  // diagnóstico de entrada viven en processWaMessage.
  client.on('message', async (msg) => {
    if (!isCurrent()) return;
    // v5.3.4 — Diagnóstico de entrada: se registra UNA línea ANTES de
    // cualquier filtro, sin el contenido del mensaje. Antes, un mensaje
    // filtrado (grupo, estado, LID, no-texto) no dejaba ningún rastro y
    // era imposible saber si llegó o no. Con esta línea, el log de
    // Railway muestra cada mensaje que WhatsApp Web entrega al CRM.
    logger.info(`WhatsApp ${name}: mensaje entrante from=${msg.from} type=${msg.type} hasMedia=${!!msg.hasMedia} fromMe=${!!msg.fromMe}`);
    if (msg.from.includes('@g.us') || msg.from.includes('@broadcast') || msg.from.includes('@bot')) return;
    if (msg.type === 'e2e_notification' || msg.type === 'notification_template') return;
    await processWaMessage(msg, { id, name, sourceName: `WhatsApp Directo (${name})`, channel: 'qr', sender: 'client', incrementUnread: true, getContact: () => msg.getContact() });
  });

  // v5.3.6 — Sincronización de enviados desde el teléfono: 'message_create'
  // dispara por cada mensaje que crea el cliente, incluidos los que se
  // envían DESDE el celular vinculado. Sin esto, lo que el asesor responde
  // desde el teléfono nunca aparecía en el CRM y nadie sabía qué se había
  // contestado. Solo se procesan los propios (fromMe): los entrantes ya
  // los guarda client.on('message'). El interlocutor es msg.to (con la
  // misma resolución LID). Se guarda como sender 'agent' (así lo pinta el
  // inbox como propio), sin sumar no leídos, y con dedup por external_id:
  // los enviados DESDE el CRM ya quedan guardados con su external_id en
  // POST /api/chats/:id/messages, así que el evento los ignora.
  client.on('message_create', async (msg) => {
    if (!isCurrent()) return;
    if (!msg.fromMe) return;
    logger.info(`WhatsApp ${name}: mensaje propio desde el teléfono to=${msg.to} type=${msg.type} hasMedia=${!!msg.hasMedia}`);
    if (String(msg.to || '').includes('@g.us') || String(msg.to || '').includes('@broadcast') || String(msg.to || '').includes('@bot')) return;
    if (msg.type === 'e2e_notification' || msg.type === 'notification_template') return;
    await processWaMessage(msg, { id, name, sourceName: `WhatsApp Directo (${name})`, channel: 'qr', sender: 'agent', incrementUnread: false, getContact: () => client.getContactById(msg.to) });
  });

  // v5.3.4: si el arranque falla porque el perfil está bloqueado por un
  // Chrome muerto (SingletonLock heredado del contenedor anterior), se
  // limpian los bloqueos y se reintenta UNA sola vez. Sin este reintento,
  // un bloqueo que aparezca después de la limpieza previa (o que la
  // limpieza no alcanzara) dejaría la instancia en 'error' hasta que el
  // admin reconecte a mano.
  let lockRetried = false;
  const startClient = () => {
    client.initialize().catch(err => {
      if (!isCurrent()) return;
      // v5.3.3: registrar el error COMPLETO (mensaje + stack + stderr de
      // Chrome). En v5.3.2 el log solo mostró "Failed to launch the browser
      // process: Code: 21" cortado, sin el stderr de Chrome, y no se pudo
      // saber si faltaba una librería o fallaba la creación de procesos.
      const detail = (err && err.stack) || (err && err.message) || String(err);
      if (!lockRetried && /profile appears to be in use/i.test(detail)) {
        lockRetried = true;
        const removed = clearWaSessionLocks(id);
        logger.warn(`WhatsApp ${name}: Chrome rechazó el perfil por un bloqueo de un proceso muerto (se limpiaron ${removed} archivo(s)); se reintenta el arranque una vez.`);
        startClient();
        return;
      }
      // v5.3.8 — Reintento por error TRANSITORIO de arranque. Log real de
      // producción (v5.3.7, 23:47:55 UTC): "ProtocolError: Protocol error
      // (Runtime.callFunctionOn): Execution context was destroyed" en
      // Client.inject durante Client.initialize — la página de WhatsApp
      // Web navegó/recargó mientras la librería inyectaba su JS y el
      // contexto de ejecución murió. Antes, cualquier error que no fuera
      // de perfil bloqueado ponía la instancia en 'error' y cancelaba el
      // vigilante: nada reintentaba jamás y solo quedaba el Reconectar
      // manual. Ahora se reintenta hasta 3 veces con espera creciente
      // (10 s, 30 s, 60 s), recreando el cliente con stopWaInstance +
      // initWhatsApp; los archivos de sesión en disco no se tocan en un
      // inject fallido, así que el reintento restaura la sesión sin pedir
      // QR nuevo. Mientras quedan reintentos, el estado sigue en
      // 'initializing' y el vigilante NO se cancela. Solo al agotar los 3
      // intentos la instancia pasa a 'error' — y el vigilante (que ahora
      // también actúa sobre 'error') intentará una re-inicialización más.
      if (isTransientWaError(detail)) {
        const done = waTransientAttempts[id] || 0;
        if (done < WA_TRANSIENT_RETRY_DELAYS.length) {
          const delay = WA_TRANSIENT_RETRY_DELAYS[done];
          waTransientAttempts[id] = done + 1;
          logger.warn(`WhatsApp ${name}: arranque fallido por error transitorio (${err?.message || err}); reintento ${done + 1}/3 en ${delay / 1000} s.`);
          const timer = setTimeout(async () => {
            const cur = waClients[id];
            if (!cur || cur.client !== client) return; // borrada o reemplazada entretanto (p. ej. Reconectar manual)
            try {
              await stopWaInstance(id);
              await initWhatsApp(id, name, 'qr', true);
            } catch (e) {
              logger.error(`WhatsApp ${name}: falló el reintento automático de arranque`, e);
            }
          }, delay);
          if (timer.unref) timer.unref();
          return;
        }
        logger.warn(`WhatsApp ${name}: se agotaron los 3 reintentos automáticos por error transitorio; queda en 'error' y el vigilante intentará una re-inicialización más.`);
        // NO se cancela el vigilante: con estado 'error' el vigilante de
        // v5.3.8 dispara su único reintento automático por arranque.
      } else {
        // Error NO transitorio (p. ej. fallo de autenticación): se mantiene
        // el comportamiento de siempre — 'error' + evento, sin reintento.
        clearWaWatchdog(id);
      }
      logger.error(`Error inicializando cliente ${name}: ${detail}`);
      waClients[id].status = 'error';
      recordEvent('error', 'whatsapp', `No se pudo iniciar WhatsApp (${name}): ${err?.message || err}`, { instance: id });
    });
  };
  startClient();

  // v5.3.2: si el cliente se queda colgado en 'authenticated' o
  // 'initializing' sin llegar a 'ready', el vigilante avisa y reintenta
  // una sola vez por arranque (ver armReadyWatchdog).
  armReadyWatchdog(id, name);
};

// --- FIN CONFIGURACIÓN WHATSAPP ---

const app = express();
const server = http.createServer(app);
// CORS del socket: mismo origen salvo CORS_ORIGIN. La autenticación real del
// socket se hace con JWT en el handshake (io.use más abajo).
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN || false,
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));


let dbUrl = (process.env.DATABASE_URL || '').trim();
// En Docker Compose, DATABASE_URL viene vacío y la base se arma con
// POSTGRES_* (con la clave URL-escapada: antes se construía en el compose
// sin escapar y una clave con @, # o / rompía la conexión).
if (!dbUrl && process.env.POSTGRES_USER) {
  const u = encodeURIComponent(process.env.POSTGRES_USER);
  const p = encodeURIComponent(process.env.POSTGRES_PASSWORD || '');
  const h = process.env.POSTGRES_HOST || 'db';
  const d = encodeURIComponent(process.env.POSTGRES_DB || 'purifica');
  dbUrl = `postgres://${u}:${p}@${h}:5432/${d}`;
}
const pool = new Pool({
  connectionString: dbUrl || undefined,
  ssl: dbUrl?.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
});
// Sin este handler, un error del pool (p. ej. DB caída) tumba todo el proceso.
pool.on('error', (err) => {
  logger.error('Error del pool de Postgres (no fatal)', err);
  dbOk = false;
  recordEvent('critical', 'db', `La base de datos falló: ${err?.message || err}`, {});
  maybeAlert('db-down', `🚨 El CRM perdió la conexión con la base de datos: ${err?.message || err}`);
});
// Red de seguridad: una promesa rechazada sin catch (alguna ruta sin try/catch)
// no debe tumbar todo el CRM; se registra y el proceso sigue vivo.
process.on('unhandledRejection', (err) => {
  logger.error('Promesa rechazada sin catch (el servidor sigue vivo)', err);
  recordEvent('error', 'server', `Promesa rechazada sin catch: ${err?.message || err}`, {});
});
process.on('uncaughtException', (err) => {
  logger.error('Excepción no capturada (el servidor sigue vivo)', err);
  recordEvent('critical', 'server', `Excepción no capturada: ${err?.message || err}`, {});
});
let dbOk = false;

// JWT: si no hay JWT_SECRET, se genera uno efímero y se avisa (los tokens no
// sobreviven a un reinicio). En producción define JWT_SECRET en .env.
const jwtSecret = process.env.JWT_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) logger.warn('JWT_SECRET no definido: usando secreto efímero (define uno fijo en .env)');

// Asegurar que cada cliente de la base de datos use la hora de Colombia
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'America/Bogota'");
});

// CORS: mismo origen por defecto; solo se abre otro origen si CORS_ORIGIN está definido.
app.use(cors({ origin: CORS_ORIGIN || false }));
app.use(helmet({ contentSecurityPolicy: false })); // CSP desactivada: el frontend usa Tailwind CDN e importmap con scripts inline.
// El webhook de Meta verifica la firma HMAC sobre el body CRUDO
// (X-Hub-Signature-256): express.json lo parsea, así que se guarda el
// buffer crudo en req.rawBody solo para esa ruta, sin tocar las demás.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { if (req.url.startsWith('/api/webhooks/meta')) req.rawBody = buf; } }));
// Logos subidos (marca blanca): públicos, solo imágenes estáticas.
fs.mkdirSync(uploadsDir(), { recursive: true });
// v5.3.6: adjuntos de WhatsApp (fotos, audios, videos, documentos).
fs.mkdirSync(waMediaDir(), { recursive: true });
app.use('/uploads', express.static(uploadsDir()));

// v5.3.10 — Diagnóstico de arranque en UNA línea: el PERSIST_DIR
// efectivo, las rutas reales de sesión y archivos, y cuántas sesiones
// guardadas hay en el volumen (solo el conteo, nunca el contenido).
// Sirve para probar en el próximo log si la sesión sobrevive al
// despliegue y si PERSIST_DIR sigue puesto.
try {
  const bootDataDir = waDataDir();
  let savedSessions = 0;
  try { savedSessions = fs.readdirSync(bootDataDir).filter((f) => String(f).startsWith('session-wa-session-')).length; } catch { savedSessions = 0; }
  logger.info(`Arranque: PERSIST_DIR=${process.env.PERSIST_DIR || '(no definido)'} waDataDir=${bootDataDir} uploadsDir=${uploadsDir()} sesionesGuardadas=${savedSessions}`);
} catch (e) { logger.warn('Arranque: no se pudo leer el diagnóstico de persistencia', e?.message || e); }

// Middleware de Logs de peticiones
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    logger.info(`${req.method} ${req.path}`);
  }
  next();
});

// ---------- SEGURIDAD v3: JWT ----------
const PUBLIC_API = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/settings/branding' },
  // Webhooks de pasarelas de pago: públicos por diseño (los verifica la
  // firma de cada proveedor, no el JWT del CRM). Ver sección v5 Facturación.
  { method: 'POST', path: '/api/webhooks/wompi' },
  { method: 'POST', path: '/api/webhooks/payu' },
  // Webhook de WhatsApp Meta Cloud API: público por diseño. El GET se
  // verifica con META_WA_VERIFY_TOKEN y el POST con la firma HMAC
  // X-Hub-Signature-256 (META_WA_APP_SECRET). Ver sección v5 Parte 2B.
  { method: 'GET', path: '/api/webhooks/meta' },
  { method: 'POST', path: '/api/webhooks/meta' },
];
const isPublicApi = (req) => PUBLIC_API.some(r => r.method === req.method && r.path === req.path);
// Rutas que NO necesitan base de datos (estado en memoria de WhatsApp / health
// y los endpoints de estado del sistema, que deben poder decir "la DB está
// caída" aunque la DB esté caída).
const DB_FREE = [/^\/api\/health$/, /^\/api\/wa\//, /^\/api\/system\//];
const needsDb = (req) => !DB_FREE.some(rx => rx.test(req.path));

async function authMiddleware(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  if (isPublicApi(req)) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, jwtSecret);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  if (needsDb(req) && !dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  // v5.3 El token no basta: el empleado puede haber sido desactivado o
  // cambiado de rol después de emitirlo (el token dura 24 h). Si no existe
  // o está inactivo -> 401; si cambió de rol, el JWT se actualiza al rol
  // actual para que los permisos sigan la realidad. Si la consulta falla
  // (DB caída) se deja pasar: los endpoints fallarán después con 500.
  if (dbUrl && req.user?.id != null) {
    try {
      const r = await pool.query('SELECT active, role FROM employees WHERE id = $1', [req.user.id]);
      if (!r.rows[0] || r.rows[0].active === false) return res.status(401).json({ error: 'Cuenta desactivada o inexistente' });
      if (r.rows[0].role) req.user.role = String(r.rows[0].role).toLowerCase();
    } catch { /* DB caída: dejar pasar */ }
  }
  next();
}
app.use(authMiddleware);

function requireAdmin(req, res, next) {
  if ((req.user?.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Solo administradores' });
  }
  next();
}

// v5 Parte 2C — Permisos finos de equipo. Admin: todo. Sales_Agent
// ("director"/líder): solo sus subordinados directos, es decir empleados
// con employees.parent_id = su propio id. El campo real de jerarquía es
// parent_id (no existe manager_id ni supervisor en employees; el JWT
// trae id como string, así que se compara con String()). Cualquier otro
// rol (advisor, operator) -> 403. Para POST /api/staff (upsert por
// email): si el correo ya existe, el objetivo es ese empleado; si no,
// el parentId del body. Un líder tampoco puede cambiar el director de
// un empleado ni ascenderlo a Admin.
async function requireAdminOrLeader(req, res, next) {
  const role = (req.user?.role || '').toLowerCase();
  if (role === 'admin') return next();
  if (role !== 'sales_agent') {
    return res.status(403).json({ error: 'Solo administradores o el director del empleado' });
  }
  const leaderId = req.user?.id;
  if (!leaderId) return res.status(403).json({ error: 'Solo administradores o el director del empleado' });
  try {
    let targetParentId = null;
    let found = false;
    if (req.params?.id) {
      const r = await pool.query('SELECT parent_id FROM employees WHERE id = $1', [req.params.id]);
      if (r.rows[0]) { found = true; targetParentId = r.rows[0].parent_id; }
    } else if (req.body?.email) {
      const r = await pool.query('SELECT parent_id FROM employees WHERE email = $1', [req.body.email]);
      if (r.rows[0]) { found = true; targetParentId = r.rows[0].parent_id; }
      else if (req.body.parentId !== undefined && req.body.parentId !== null && req.body.parentId !== '') {
        found = true; targetParentId = Number(req.body.parentId);
      }
    } else if (req.body?.parentId !== undefined && req.body.parentId !== null && req.body.parentId !== '') {
      found = true; targetParentId = Number(req.body.parentId);
    }
    if (!found || targetParentId === null || targetParentId === undefined || String(targetParentId) !== String(leaderId)) {
      return res.status(403).json({ error: 'Solo puedes gestionar a tus subordinados directos' });
    }
    if (req.body?.parentId !== undefined && req.body.parentId !== null && req.body.parentId !== '' && String(req.body.parentId) !== String(leaderId)) {
      return res.status(403).json({ error: 'No puedes cambiar el director de un empleado' });
    }
    if (typeof req.body?.role === 'string' && req.body.role.toLowerCase() === 'admin') {
      return res.status(403).json({ error: 'Solo un administrador puede crear administradores' });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ---------- ROLES UNIFICADOS v5.2 ----------
// Antes había dos verdades: en BD se guardaba 'Admin'/'Advisor'/
// 'Sales_Agent' con mayúscula (el formulario de Equipo mandaba el valor
// de la pestaña tal cual) y en el JWT/login en minúscula, y los endpoints
// confiaban en el rol que el CLIENTE mandaba por query (?role=admin...):
// cualquiera podía pedirse el rol que quisiera. Ahora hay UNA sola
// verdad, en minúscula, y el alcance sale SIEMPRE del JWT verificado
// (req.user), nunca de la query. Los params role/userName/userId de la
// query se ignoran para el alcance (se mantienen en la URL solo por
// compatibilidad con el frontend viejo; el servidor no los usa).
const VALID_ROLES = ['admin', 'advisor', 'operator', 'sales_agent'];
function normalizeRoleValue(v) {
  const r = String(v ?? '').toLowerCase().trim();
  return VALID_ROLES.includes(r) ? r : null;
}
// Alcance por rol desde el JWT. Admin: todo (names null). advisor:
// solo lo suyo, por nombre exacto (los servicios/leads guardan el
// asesor por nombre). sales_agent (líder de ventas): lo suyo + su red
// (subordinados directos, employees.parent_id = su id). operator: solo
// sus servicios asignados (su nombre en services.operators).
async function getRoleScope(req) {
  const role = normalizeRoleValue(req.user?.role) || 'operator';
  const userId = req.user?.id != null ? String(req.user.id) : null;
  const userName = (req.user?.name || '').trim() || null;
  if (role === 'admin') return { role, userId, userName, names: null, teamNames: [] };
  if (role === 'sales_agent') {
    let teamNames = [];
    if (userId) {
      const t = await pool.query('SELECT name FROM employees WHERE parent_id = $1 AND active = true', [userId]);
      teamNames = t.rows.map((r) => r.name);
    }
    return { role, userId, userName, names: [userName, ...teamNames].filter(Boolean), teamNames };
  }
  return { role, userId, userName, names: userName ? [userName] : [], teamNames: [] };
}
// Añade el filtro de alcance a cláusulas WHERE con params. advisorCol:
// columna del asesor (p. ej. 'advisor'); operatorsCol: columna array de
// operadores (p. ej. 'operators') o null si el recurso no la tiene
// (entonces el operador no ve nada de ese recurso).
function applyRoleScopeClauses(scope, clauses, params, { advisorCol = 'advisor', operatorsCol = null } = {}) {
  if (!scope || scope.role === 'admin') return;
  if (scope.role === 'operator') {
    if (!operatorsCol) { clauses.push('1 = 0'); return; }
    params.push(scope.userName);
    clauses.push(`$${params.length} = ANY(${operatorsCol})`);
    return;
  }
  if (scope.names && scope.names.length) {
    params.push(scope.names);
    clauses.push(`${advisorCol} = ANY($${params.length})`);
  } else { clauses.push('1 = 0'); }
}
// Variantes de un teléfono para comparar en SQL (tal cual, normalizado
// +57 y solo los 10 dígitos): cubre filas viejas guardadas en otro formato.
function phoneVariantsFor(phone) {
  const out = new Set();
  const raw = String(phone || '').trim();
  if (!raw) return [];
  out.add(raw);
  const { phone: norm } = normalizePhoneCO(raw);
  out.add(norm);
  out.add(norm.replace('+', ''));
  if (norm.startsWith('+57')) out.add(norm.slice(3));
  return [...out];
}
// Teléfonos (normalizados) de los clientes de los servicios asignados a
// un operador, para acotar chats/leads/totales a lo suyo.
async function operatorServicePhones(userName) {
  if (!userName) return [];
  const r = await pool.query('SELECT DISTINCT client_phone FROM services WHERE $1 = ANY(operators)', [userName]);
  const phones = new Set();
  for (const row of r.rows) for (const v of phoneVariantsFor(row.client_phone)) phones.add(v);
  return [...phones];
}
// Facturación (B6): admin o asesor (vendedor). El asesor factura y cobra,
// pero NO anula (eso sigue siendo solo admin) ni toca la configuración
// DIAN ni el tipo por defecto.
function requireBilling(req, res, next) {
  const role = normalizeRoleValue(req.user?.role);
  if (role === 'admin' || role === 'advisor') return next();
  return res.status(403).json({ error: 'Solo administradores o vendedores pueden facturar' });
}

// Salud del sistema: nunca rompe sin DB. Es la ruta que miran los monitores
// externos (UptimeRobot / Better Stack) cada 5 min.
app.get('/api/health', async (req, res) => {
  let db = false;
  if (dbUrl) {
    try { await pool.query('SELECT 1'); db = true; } catch (e) { db = false; }
  }
  const waInstances = Object.keys(waClients).length;
  const waConnected = Object.values(waClients).filter((w) => w.status === 'ready').length;
  res.json({
    ok: !dbUrl || db, version: APP_VERSION, db,
    uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    whatsapp: { instances: waInstances, connected: waConnected },
  });
});

// ---------- ESTADO DEL SISTEMA v3.1 (solo admin) ----------

async function checkDb() {
  const t0 = Date.now();
  if (!dbUrl) return { status: 'red', ok: false, ms: 0, detail: 'DATABASE_URL no configurada' };
  try {
    // Tope de 10 s: sin él, un pool colgado deja al vigilante esperando
    // para siempre y dos chequeos se solapan.
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout verificando la base de datos (10 s)')), 10000)),
    ]);
    return { status: 'green', ok: true, ms: Date.now() - t0, detail: 'SELECT 1 correcto' };
  } catch (e) {
    return { status: 'red', ok: false, ms: Date.now() - t0, detail: e.message };
  }
}

async function getLastBackupInfo() {
  // El último respaldo se guarda en settings (clave last_backup) al terminar
  // cada respaldo, así sobrevive a reinicios. En memoria queda lo de la sesión.
  if (lastBackup.at) return lastBackup;
  if (!dbUrl) return lastBackup;
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'last_backup'");
    if (r.rows[0]?.value) return JSON.parse(r.rows[0].value);
  } catch { /* sin tabla settings aún */ }
  return lastBackup;
}

async function getSystemStatus() {
  const db = await checkDb();
  const wa = waStatusSummary();
  const waStatus = wa.total === 0 ? 'yellow'
    : wa.connected === wa.total ? 'green'
    : wa.connected > 0 ? 'yellow' : 'red';
  const mem = process.memoryUsage();
  let disk = null;
  try {
    const s = await fs.promises.statfs(uploadsDir());
    disk = { freeMB: Math.round(s.bfree * s.bsize / 1024 / 1024), totalMB: Math.round(s.blocks * s.bsize / 1024 / 1024) };
  } catch { disk = null; }
  // Cola de mensajes: la tabla messages de crm6 NO tiene columna status
  // (no hay "en cola" persistente), así que se informa lo que sí se sabe:
  // mensajes recientes y conversaciones sin leer. Si WhatsApp no está listo,
  // los mensajes salientes no pueden salir: eso es lo que marca el semáforo.
  let queue = { status: 'green', detail: 'Sin columna status en messages; se mide por actividad reciente', recentMessages1h: null, unreadConversations: null };
  if (db.ok) {
    try {
      const r1 = await pool.query("SELECT COUNT(*) FROM messages WHERE timestamp >= NOW() - INTERVAL '1 hour'");
      const r2 = await pool.query('SELECT COUNT(*) FROM conversations WHERE unread_count > 0');
      queue.recentMessages1h = parseInt(r1.rows[0].count);
      queue.unreadConversations = parseInt(r2.rows[0].count);
      queue.detail = `${queue.recentMessages1h} mensajes en la última hora, ${queue.unreadConversations} conversaciones sin leer`;
      queue.status = wa.total > 0 && wa.connected === 0 ? 'red' : 'green';
    } catch (e) { queue = { status: 'red', detail: `No se pudo leer la cola: ${e.message}`, recentMessages1h: null, unreadConversations: null }; }
  } else {
    queue.status = 'red';
    queue.detail = 'Sin base de datos no se puede medir la cola';
  }
  const gcal = await (async () => {
    const st = await googleCalendarStatus();
    if (!st.configured) return { status: 'yellow', detail: `No configurado: ${st.reason}`, configured: false, lastError: st.lastError };
    if (st.lastError) return { status: 'red', detail: `Configurado, último error: ${st.lastError.message}`, configured: true, lastError: st.lastError };
    return { status: 'green', detail: `Configurado (${st.calendarId}, eventos de ${st.durationMinutes} min)`, configured: true, lastError: null };
  })();
  const backup = await getLastBackupInfo();
  const backupStatus = !backup.at ? 'yellow'
    : backup.ok ? (Date.now() - new Date(backup.at).getTime() < 48 * 3600 * 1000 ? 'green' : 'yellow')
    : 'red';
  let critical = [];
  if (db.ok) {
    try {
      const r = await pool.query("SELECT id, level, component, message, created_at FROM system_events WHERE level IN ('error','critical') ORDER BY created_at DESC LIMIT 10");
      critical = r.rows;
    } catch { critical = eventBuffer.filter((e) => e.level === 'error' || e.level === 'critical').slice(-10).reverse(); }
  } else {
    critical = eventBuffer.filter((e) => e.level === 'error' || e.level === 'critical').slice(-10).reverse();
  }
  return {
    version: APP_VERSION,
    uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    alerts: { telegramConfigured: telegramConfigured(), emailConfigured: nodemailerAvailable && Boolean((process.env.SMTP_HOST || '').trim() && (process.env.ALERT_EMAIL || '').trim()) },
    components: [
      { key: 'db', label: 'Base de datos', status: db.status, detail: db.detail, latencyMs: db.ms },
      { key: 'whatsapp', label: 'WhatsApp por QR', status: waStatus, detail: wa.total === 0 ? 'Sin instancias configuradas' : `${wa.connected} de ${wa.total} instancias conectadas`, instances: wa.instances },
      { key: 'server', label: 'Servidor', status: 'green', detail: `Activo desde hace ${Math.floor((Date.now() - SERVER_STARTED_AT) / 60000)} min`, memoryMB: Math.round(mem.rss / 1024 / 1024), disk },
      { key: 'queue', label: 'Cola de mensajes', status: queue.status, detail: queue.detail, recentMessages1h: queue.recentMessages1h, unreadConversations: queue.unreadConversations },
      { key: 'backup', label: 'Último respaldo', status: backupStatus, detail: backup.at ? `${backup.ok ? 'OK' : 'FALLÓ'} el ${new Date(backup.at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}${backup.file ? ` (${backup.file})` : ''}` : 'Nunca se ha hecho un respaldo', backup },
      { key: 'google-calendar', label: 'Google Calendar', status: gcal.status, detail: gcal.detail, configured: gcal.configured, lastError: gcal.lastError },
    ],
    criticalEvents: critical,
  };
}

app.get('/api/system/status', requireAdmin, async (req, res) => {
  try { res.json(await getSystemStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/system/events', requireAdmin, async (req, res) => {
  const level = (req.query.level || '').toString();
  const component = (req.query.component || '').toString();
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  if (!dbUrl || !eventsTableReady) {
    let rows = [...eventBuffer].reverse();
    if (level) rows = rows.filter((e) => e.level === level);
    if (component) rows = rows.filter((e) => e.component === component);
    return res.json({ source: 'memory', events: rows.slice(0, limit) });
  }
  try {
    const params = [];
    let where = '';
    if (level) { params.push(level); where += `level = $${params.length}`; }
    if (component) { params.push(component); where += (where ? ' AND ' : '') + `component = $${params.length}`; }
    const r = await pool.query(
      `SELECT id, level, component, message, details, created_at FROM system_events ${where ? 'WHERE ' + where : ''} ORDER BY created_at DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    res.json({ source: 'db', events: r.rows });
  } catch (err) {
    res.json({ source: 'memory', events: [...eventBuffer].reverse().slice(0, limit), warning: err.message });
  }
});

app.post('/api/system/self-test', requireAdmin, async (req, res) => {
  const tests = [];
  const run = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      tests.push({ name, ok: true, ms: Date.now() - t0, detail: detail || 'OK' });
    } catch (e) {
      tests.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    }
  };
  await run('Base de datos (SELECT 1)', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL no configurada');
    await pool.query('SELECT 1');
    return 'Conexión y SELECT 1 correctos';
  });
  await run('Leer servicios', async () => {
    const r = await pool.query('SELECT COUNT(*) FROM services');
    return `${r.rows[0].count} servicios en total`;
  });
  await run('Leer plantillas', async () => {
    const r = await pool.query('SELECT COUNT(*) FROM templates');
    return `${r.rows[0].count} plantillas`;
  });
  await run('Leer equipo', async () => {
    const r = await pool.query('SELECT COUNT(*) FROM employees WHERE active = true');
    return `${r.rows[0].count} empleados activos`;
  });
  await run('WhatsApp por QR', async () => {
    const wa = waStatusSummary();
    if (wa.total === 0) throw new Error('Sin instancias de WhatsApp configuradas');
    if (wa.connected === 0) throw new Error(`${wa.total} instancia(s), ninguna conectada (hay que escanear el QR)`);
    return `${wa.connected} de ${wa.total} instancias conectadas`;
  });
  await run('Escritura en uploads/', async () => {
    const tmp = path.join(uploadsDir(), `.selftest-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, 'self-test');
    fs.unlinkSync(tmp);
    return 'Se pudo escribir y borrar un archivo temporal';
  });
  await run('Alertas de Telegram', async () => {
    if (!telegramConfigured()) throw new Error('Telegram no configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID vacíos)');
    return 'Token y chat configurados (no se envió ningún mensaje en esta prueba)';
  });
  await run('Google Calendar', async () => {
    const st = await googleCalendarStatus();
    if (!st.configured) throw new Error(`Google Calendar no configurado: ${st.reason}`);
    return `Configurado (${st.calendarId}, eventos de ${st.durationMinutes} min)`;
  });
  const failed = tests.filter((t) => !t.ok).length;
  const summary = { ok: failed === 0, passed: tests.length - failed, failed, total: tests.length };
  recordEvent(summary.ok ? 'info' : 'warn', 'server', `Autoprueba del sistema: ${summary.passed}/${summary.total} correctas`, summary);
  res.json({ summary, tests });
});

app.post('/api/system/whatsapp/reconnect', requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  // Si se pide una instancia concreta que no existe ni en memoria ni
  // guardada en settings (wa_channel_<id>), 404: antes se creaba una
  // instancia nueva de la nada.
  if (id && !waClients[id] && dbOk) {
    try {
      const saved = await getSettingValue(`wa_channel_${id}`, '');
      if (saved !== 'qr' && saved !== 'meta') return res.status(404).json({ error: 'Instancia no encontrada' });
    } catch { return res.status(404).json({ error: 'Instancia no encontrada' }); }
  }
  if (id && !waClients[id] && !dbOk) return res.status(404).json({ error: 'Instancia no encontrada' });
  const targets = id ? [id] : Object.keys(waClients);
  if (targets.length === 0) return res.status(400).json({ error: 'No hay instancias de WhatsApp para reconectar. Crea una en Canales WhatsApp.' });
  const results = [];
  for (const tid of targets) {
    const inst = waClients[tid];
    const name = inst?.name || tid;
    // El canal es el guardado (settings wa_channel_<id>) o el de la
    // instancia en memoria. Antes se llamaba a initWhatsApp sin canal:
    // una instancia Meta se recreaba como QR, y una instancia Meta en
    // memoria (client null) ni siquiera se recreaba porque initWhatsApp
    // retorna si waClients[id] ya existe.
    let channel = inst?.channel || 'qr';
    if (dbOk) {
      try {
        const saved = await getSettingValue(`wa_channel_${tid}`, '');
        if (saved === 'qr' || saved === 'meta') channel = saved;
      } catch { /* se queda el canal en memoria */ }
    }
    try {
      // v5.3.2: parada centralizada (limpia el vigilante de ready y
      // destruye el cliente viejo con tope de 10 s) ANTES de recrear:
      // initWhatsApp retorna sin hacer nada si waClients[tid] ya existe.
      await stopWaInstance(tid);
      await initWhatsApp(tid, name, channel);
      results.push({ id: tid, ok: true, detail: channel === 'meta' ? 'Instancia Meta reconectada' : 'Reconectando: escanea el QR nuevo en Canales WhatsApp si aparece' });
      recordEvent('info', 'whatsapp', `Reconexión manual de WhatsApp: ${name} (${channel})`, { instance: tid });
    } catch (e) {
      results.push({ id: tid, ok: false, detail: e.message });
      recordEvent('error', 'whatsapp', `No se pudo reconectar WhatsApp (${name}): ${e.message}`, { instance: tid });
    }
  }
  res.json({ results });
});

app.post('/api/system/alerts/test', requireAdmin, async (req, res) => {
  const text = `🔔 Prueba de alertas del CRM Purifica (v${APP_VERSION}): si lees esto en Telegram, las alertas funcionan. ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`;
  const r = await sendTelegramAlert(text);
  recordEvent(r.sent ? 'info' : 'warn', 'alerts', r.sent ? 'Prueba de alerta Telegram enviada' : `Prueba de alerta Telegram falló: ${r.reason}`, {});
  res.json({ ...r, text });
});

app.post('/api/system/backup', requireAdmin, async (req, res) => {
  try {
    const r = await runBackup('manual');
    if (!r.ok) return res.status(r.code || 500).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- GOOGLE CALENDAR v5.3 (pedido del cliente) ----------
// Al agendar un servicio (crear o reprogramar) se crea/actualiza el evento
// en Google Calendar; al cancelar o eliminar, se borra. API oficial con
// OAuth2 + refresh token (googleapis). Sin credenciales el CRM funciona
// EXACTAMENTE igual: el servicio se guarda y solo se registra el aviso.
// Colombia no tiene horario de verano: siempre UTC-5, así que la hora del
// servicio se construye con offset fijo -05:00 (sin depender de la zona
// del servidor).
let googleapisModule = null;
async function loadGoogleApis() {
  if (googleapisModule) return googleapisModule;
  googleapisModule = await import('googleapis');
  return googleapisModule;
}

async function getGoogleCalendarConfig() {
  const enabledSetting = await getSettingValue('google_calendar_enabled', null);
  const enabled = enabledSetting === null
    ? (process.env.GOOGLE_CALENDAR_ENABLED || 'true').toLowerCase() !== 'false'
    : String(enabledSetting).toLowerCase() !== 'false';
  const refreshToken = (await getSettingValue('google_refresh_token', ''))?.trim() || GOOGLE_REFRESH_TOKEN_ENV;
  const calendarId = (await getSettingValue('google_calendar_id', ''))?.trim() || GOOGLE_CALENDAR_ID_ENV;
  const durationRaw = await getSettingValue('google_calendar_duration_minutes', '');
  const durationMinutes = Math.min(Math.max(parseInt(durationRaw || process.env.GOOGLE_CALENDAR_DURATION_MINUTES || String(GOOGLE_CALENDAR_DURATION_DEFAULT), 10) || GOOGLE_CALENDAR_DURATION_DEFAULT, 15), 1440);
  const clientId = GOOGLE_CLIENT_ID;
  const clientSecret = GOOGLE_CLIENT_SECRET;
  if (!enabled) return { configured: false, reason: 'Google Calendar apagado (google_calendar_enabled=false)', enabled, calendarId, durationMinutes };
  if (!clientId || !clientSecret) return { configured: false, reason: 'Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en .env', enabled, calendarId, durationMinutes };
  if (!refreshToken) return { configured: false, reason: 'Falta el refresh token (GOOGLE_REFRESH_TOKEN o settings google_refresh_token). Ver README, sección "Google Calendar".', enabled, calendarId, durationMinutes };
  return { configured: true, reason: '', enabled, clientId, clientSecret, refreshToken, calendarId, durationMinutes };
}

async function getGoogleCalendarClient() {
  const cfg = await getGoogleCalendarConfig();
  if (!cfg.configured) return { client: null, cfg };
  try {
    const { google } = await loadGoogleApis();
    const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
    oauth2.setCredentials({ refresh_token: cfg.refreshToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    return { client: calendar, cfg };
  } catch (e) {
    return { client: null, cfg, error: `No se pudo cargar googleapis: ${e.message}` };
  }
}

function googleCalendarServiceDate(service) {
  const raw = service.date;
  const dateStr = raw instanceof Date ? raw.toISOString().split('T')[0] : String(raw || '').slice(0, 10);
  // La hora puede venir con un dígito ('9:00'): se normaliza a HH:MM en vez
  // de asumir 08:00 en silencio (antes el regex /^\d{2}:\d{2}/ no casaba y
  // un servicio de las 9 se agendaba a las 8).
  const m = String(service.time || '').match(/^(\d{1,2}):(\d{2})/);
  const timeStr = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '08:00';
  return { dateStr, timeStr };
}

function buildGoogleCalendarEvent(service, durationMinutes) {
  const { dateStr, timeStr } = googleCalendarServiceDate(service);
  const start = new Date(`${dateStr}T${timeStr}:00-05:00`);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const address = [service.address, service.neighborhood, service.city].filter(Boolean).join(', ');
  const lines = [
    `Cliente: ${service.client_name || service.clientName || 'Sin nombre'}`,
    `Teléfono: ${service.client_phone || service.clientPhone || ''}`,
    service.address ? `Dirección: ${address}` : null,
    service.advisor ? `Asesor: ${service.advisor}` : null,
    service.operators?.length ? `Operadores: ${service.operators.join(', ')}` : null,
    service.service_performed || service.servicePerformed ? `Servicio: ${service.service_performed || service.servicePerformed}` : null,
    service.total_value != null || service.totalValue != null ? `Valor total: $${Number(service.total_value ?? service.totalValue ?? 0).toLocaleString('es-CO')}` : null,
    `Estado: ${service.deal_status || service.dealStatus || 'AGENDADO'}`,
    `Servicio CRM: ${service.id}`,
  ].filter(Boolean);
  return {
    summary: `Limpieza — ${service.client_name || service.clientName || 'Sin nombre'} (${service.service_performed || service.servicePerformed || 'Servicio de limpieza'})`,
    description: lines.join('\n'),
    location: address || undefined,
    start: { dateTime: start.toISOString(), timeZone: 'America/Bogota' },
    end: { dateTime: end.toISOString(), timeZone: 'America/Bogota' },
  };
}

// Crea o actualiza el evento del servicio. NUNCA lanza: devuelve
// {ok:false, error} y registra el fallo, para que un fallo de Google
// jamás rompa el guardado del servicio (ni un 500, ni un cuelgue: hay
// un tope de 20 s por intento, con AbortController para que la llamada a
// Google se cancele de verdad al expirar; antes el Promise.race dejaba
// la petición viva y podía insertar el evento después, duplicándolo en
// el siguiente sync porque el id no se había persistido).
async function syncServiceToCalendar(service) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado hablando con Google Calendar (20 s)')), ms));
  try {
    const result = await Promise.race([
      (async () => {
        const { client, cfg, error } = await getGoogleCalendarClient();
        if (!client) return { ok: false, skipped: true, error: error || cfg.reason };
        // Fecha inválida: no se construye el evento (antes new Date con
        // fecha mala daba Invalid Date y el insert fallaba o, peor, se
        // guardaba un evento en fecha absurda).
        const { dateStr } = googleCalendarServiceDate(service);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || Number.isNaN(Date.parse(`${dateStr}T00:00:00-05:00`))) {
          return { ok: false, skipped: true, error: `Fecha de servicio inválida para Google Calendar: ${service.date}` };
        }
        const resource = buildGoogleCalendarEvent(service, cfg.durationMinutes);
        const eventId = service.google_calendar_event_id || service.googleCalendarEventId;
        if (eventId) {
          try {
            await client.events.patch({ calendarId: cfg.calendarId, eventId, requestBody: resource }, { signal: ctrl.signal });
            return { ok: true, eventId, action: 'updated' };
          } catch (e) {
            // El evento ya no existe en Calendar (borrado a mano): crearlo
            // de nuevo en vez de fallar siempre.
            if (e?.code !== 404 && e?.response?.status !== 404) throw e;
          }
        }
        const created = await client.events.insert({ calendarId: cfg.calendarId, requestBody: resource }, { signal: ctrl.signal });
        const newId = created.data.id;
        try { await pool.query('UPDATE services SET google_calendar_event_id = $1 WHERE id = $2', [newId, service.id]); } catch { /* sin DB: el id no se persiste */ }
        return { ok: true, eventId: newId, action: 'created' };
      })(),
      timeout(20000),
    ]);
    if (!result.ok) {
      lastGoogleCalendarError = { at: new Date().toISOString(), message: result.error };
      if (!result.skipped) await recordEvent('warn', 'google-calendar', `No se pudo sincronizar el servicio ${service.id} con Google Calendar: ${result.error}`, { serviceId: service.id });
    } else {
      lastGoogleCalendarError = null;
    }
    return result;
  } catch (e) {
    lastGoogleCalendarError = { at: new Date().toISOString(), message: e.message };
    await recordEvent('error', 'google-calendar', `Error sincronizando el servicio ${service.id} con Google Calendar: ${e.message}`, { serviceId: service.id });
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Borra el evento del servicio en Calendar (best-effort, nunca lanza).
// Con el mismo tope de 20 s que el sync (antes no tenía tope).
async function deleteServiceFromCalendar(serviceId, eventId) {
  if (!eventId) return { ok: true, skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const { client, cfg } = await getGoogleCalendarClient();
    if (!client) return { ok: false, skipped: true, error: cfg.reason };
    await client.events.delete({ calendarId: cfg.calendarId, eventId }, { signal: ctrl.signal });
    return { ok: true, action: 'deleted' };
  } catch (e) {
    // 404/410 = el evento ya no estaba: no es un error real.
    if (e?.code === 404 || e?.code === 410 || e?.response?.status === 404 || e?.response?.status === 410) return { ok: true, action: 'already-gone' };
    await recordEvent('warn', 'google-calendar', `No se pudo borrar el evento de Google Calendar del servicio ${serviceId}: ${e.message}`, { serviceId });
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function googleCalendarStatus() {
  const cfg = await getGoogleCalendarConfig();
  return {
    configured: cfg.configured,
    enabled: cfg.enabled,
    calendarId: cfg.configured ? cfg.calendarId : null,
    durationMinutes: cfg.durationMinutes,
    reason: cfg.configured ? '' : cfg.reason,
    lastError: lastGoogleCalendarError,
  };
}

// ---------- NORMALIZACIÓN DE TELÉFONOS v5 Parte 2B ----------
// Normaliza los teléfonos ya guardados (leads, services, employees y
// conversations) a +57... con la misma regla de normalizePhoneCO. NO borra
// duplicados: si dos valores distintos normalizan al mismo número (o el
// número normalizado ya existe en la tabla), se reportan en `collisions`
// como { table, phone, count } y esas filas NO se tocan, para que el admin
// las revise y fusione a mano. El id de las conversaciones (wa_<dígitos>)
// no se toca: renombrarlo rompería la FK de messages. El resultado queda
// en system_events.
app.post('/api/system/normalize-phones', requireAdmin, async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  const targets = [
    { table: 'leads', column: 'client_phone' },
    { table: 'services', column: 'client_phone' },
    { table: 'employees', column: 'phone' },
    { table: 'conversations', column: 'client_phone' },
    // clients.phone también: si no se normaliza, handleIncomingWhatsApp
    // busca el cliente por el teléfono normalizado, no lo encuentra y
    // crea un duplicado.
    { table: 'clients', column: 'phone' },
  ];
  let updated = 0;
  const collisions = [];
  const perTable = {};
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    for (const { table, column } of targets) {
      const r = await dbClient.query(`SELECT DISTINCT ${column} AS phone FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`);
      const allValues = new Set(r.rows.map((row) => row.phone));
      const groups = new Map();
      for (const row of r.rows) {
        const { phone: norm, normalized } = normalizePhoneCO(row.phone);
        if (!normalized || norm === row.phone) continue;
        if (!groups.has(norm)) groups.set(norm, []);
        groups.get(norm).push(row.phone);
      }
      let tableUpdated = 0;
      for (const [norm, originals] of groups) {
        const alreadyThere = allValues.has(norm) ? 1 : 0;
        if (originals.length > 1 || alreadyThere) {
          collisions.push({ table, phone: norm, count: originals.length + alreadyThere });
          continue;
        }
        const u = await dbClient.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [norm, originals[0]]);
        tableUpdated += u.rowCount;
        updated += u.rowCount;
      }
      perTable[table] = tableUpdated;
    }
    await dbClient.query('COMMIT');
    const summary = { updated, collisions, perTable };
    await recordEvent('info', 'system', `Normalización de teléfonos: ${updated} filas actualizadas, ${collisions.length} colisiones sin tocar`, summary);
    res.json(summary);
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch { /* noop */ }
    res.status(500).json({ error: err.message });
  } finally {
    dbClient.release();
  }
});

// Respaldo con pg_dump (sin shell: pg_dump recibe la URL como argumento y
// su salida se comprime con gzip en Node). Devuelve 501 si no hay pg_dump.
async function runBackup(trigger = 'manual') {
  if (!dbUrl) return { ok: false, code: 503, error: 'Base de datos no configurada' };
  const backupsDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const file = `purifica-${stamp}.sql.gz`;
  const filePath = path.join(backupsDir, file);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let dump;
    try {
      dump = spawn('pg_dump', [dbUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const r = { ok: false, code: 501, error: `No se pudo lanzar pg_dump: ${e.message}` };
      lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
      recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
      return done(r);
    }
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(filePath);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    // El éxito solo se decide cuando pg_dump TERMINÓ (evento 'close') y el
    // archivo quedó escrito y con contenido: antes se miraba dump.exitCode
    // en el 'finish' de gzip, que podía ser null si pg_dump aún no había
    // terminado, y un respaldo corrupto se marcaba OK.
    let dumpCode = null;
    let dumpClosed = false;
    let outFinished = false;
    const finishBackup = async () => {
      if (!dumpClosed || !outFinished || settled) return;
      if (dumpCode !== 0) {
        const r = { ok: false, code: 500, error: `pg_dump terminó con error (código ${dumpCode}): ${stderr.slice(0, 500)}` };
        try { fs.unlinkSync(filePath); } catch { /* noop */ }
        lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
        recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
        return done(r);
      }
      const sizeBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      if (sizeBytes <= 0) {
        const r = { ok: false, code: 500, error: 'pg_dump terminó OK pero el respaldo quedó vacío (0 bytes)' };
        try { fs.unlinkSync(filePath); } catch { /* noop */ }
        lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
        recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
        return done(r);
      }
      lastBackup = { at: new Date().toISOString(), ok: true, file, sizeBytes, error: null };
      try {
        await pool.query("INSERT INTO settings (key, value) VALUES ('last_backup', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(lastBackup)]);
      } catch { /* sin settings aún, queda en memoria */ }
      // Retención: borrar respaldos de más de BACKUP_KEEP_DAYS días. Solo
      // archivos con el prefijo purifica-: antes borraba CUALQUIER archivo
      // viejo de backups/ (igual que scripts/backup.sh).
      try {
        const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 3600 * 1000;
        for (const f of fs.readdirSync(backupsDir)) {
          if (!f.startsWith('purifica-')) continue;
          const p = path.join(backupsDir, f);
          if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        }
      } catch { /* limpieza opcional */ }
      recordEvent('info', 'backup', `Respaldo OK (${trigger}): ${file} (${Math.round(sizeBytes / 1024)} KB)`, { file, sizeBytes });
      done({ ok: true, file, sizeBytes, at: lastBackup.at });
    };
    dump.on('close', (code) => { dumpCode = code; dumpClosed = true; finishBackup(); });
    dump.on('error', (e) => {
      const r = { ok: false, code: 501, error: `pg_dump no disponible en este contenedor/servidor: ${e.message}. Instala postgresql-client o usa scripts/backup.sh en el host.` };
      try { fs.unlinkSync(filePath); } catch { /* no existe aún */ }
      lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
      recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
      done(r);
    });
    // Si gzip falla, el archivo nunca termina de escribirse: fallar de
    // inmediato (sin esperar al 'finish' de out, que no llegaría).
    gzip.on('error', (e) => {
      if (settled) return;
      const r = { ok: false, code: 500, error: `No se pudo comprimir el respaldo: ${e.message}` };
      try { fs.unlinkSync(filePath); } catch { /* noop */ }
      lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
      recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
      done(r);
    });
    dump.stdout.pipe(gzip).pipe(out);
    out.on('finish', () => { outFinished = true; finishBackup(); });
    out.on('error', (e) => {
      const r = { ok: false, code: 500, error: `No se pudo escribir el respaldo: ${e.message}` };
      lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
      recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
      done(r);
    });
  });
}

// Vigilante: cada 5 min comprueba DB y WhatsApp. Solo avisa cuando algo
// CAMBIA de bien a mal (o de mal a bien), y nunca repite el mismo aviso
// antes de 30 min (anti-spam en maybeAlert). El primer chequeo se hace al
// arrancar: antes watchdogState empezaba en null y la primera caída
// (null -> error) NO disparaba alerta; ahora el estado inicial se trata
// como 'ok' para la transición, así que si el servidor arranca ya con la
// DB o WhatsApp caídos, avisa de inmediato.
async function watchdogCheck() {
  try {
    const db = await checkDb();
    const prevDb = watchdogState.db ?? 'ok';
    if (prevDb === 'ok' && !db.ok) {
      recordEvent('critical', 'db', `La base de datos dejó de responder: ${db.detail}`, {});
      maybeAlert('db-down', `🚨 El CRM perdió la base de datos: ${db.detail}`);
    } else if (watchdogState.db === 'error' && db.ok) {
      recordEvent('info', 'db', 'La base de datos volvió a responder', {});
      maybeAlert('db-down', '✅ La base de datos del CRM volvió a responder.', { force: true });
    }
    watchdogState.db = db.ok ? 'ok' : 'error';
    const wa = waStatusSummary();
    const waOk = wa.total === 0 || wa.connected > 0;
    const prevWa = watchdogState.whatsapp ?? 'ok';
    if (prevWa === 'ok' && !waOk && wa.total > 0) {
      recordEvent('critical', 'whatsapp', 'WhatsApp: ninguna instancia conectada', { total: wa.total });
      maybeAlert('whatsapp-down', '🚨 WhatsApp: ninguna instancia conectada. Hay que escanear el QR en el CRM.');
    } else if (watchdogState.whatsapp === 'error' && waOk && wa.total > 0) {
      recordEvent('info', 'whatsapp', 'WhatsApp volvió a conectarse', {});
      maybeAlert('whatsapp-down', '✅ WhatsApp volvió a conectarse.', { force: true });
    }
    if (wa.total > 0) watchdogState.whatsapp = waOk ? 'ok' : 'error';
  } catch (e) {
    recordEvent('error', 'server', `El vigilante falló: ${e.message}`, {});
  }
}
setInterval(watchdogCheck, 5 * 60 * 1000);
watchdogCheck();

// Respaldo diario a las 02:00 (America/Bogota). Si pg_dump no existe en la
// imagen, el intento queda registrado como evento de error y no tumba nada.
function scheduleDailyBackup() {
  if (!BACKUP_ENABLED) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    await runBackup('automático diario 02:00');
    scheduleDailyBackup();
  }, next.getTime() - now.getTime());
}
scheduleDailyBackup();

// MODIFICACIÓN: notifyUpdate ahora siempre incluye a la sala de administradores para omnisciencia
const notifyUpdate = (type = 'general', targetIds = []) => {
  const timestamp = new Date().toISOString();
  // Siempre notificamos a los administradores en tiempo real
  io.to('global_admin').emit('data_update', { type, timestamp });

  if (targetIds && targetIds.length > 0) {
    targetIds.forEach(id => {
      if (id) io.to(id.toString()).emit('data_update', { type, timestamp });
    });
  } else {
    // Si no hay objetivos específicos, emitimos a todos (incluyendo anónimos)
    io.emit('data_update', { type, timestamp });
  }
  logger.info(`Notificación enviada: ${type}`, { targetIds });
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const initDB = async () => {
  if (!dbUrl) { logger.warn('DATABASE_URL no configurada: la API devolverá 503 y WhatsApp QR seguirá disponible en memoria'); return; }
  let client;
  try {
    client = await pool.connect();
    await client.query("SET TIME ZONE 'America/Bogota'");

    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        phone VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100),
        source VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS commission_tiers (
        id SERIAL PRIMARY KEY,
        role VARCHAR(20),
        min_value NUMERIC(15,2),
        max_value NUMERIC(15,2),
        percentage NUMERIC(5,2)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(50) PRIMARY KEY,
        account_id INTEGER,
        client_name VARCHAR(100) DEFAULT 'Cliente Nuevo',
        client_phone VARCHAR(50),
        source VARCHAR(50),
        inbox_name VARCHAR(100),
        last_message TEXT,
        last_message_time TIMESTAMP DEFAULT NOW(),
        unread_count INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'open',
        channel VARCHAR(10) DEFAULT 'qr',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS client_notes (
        client_phone VARCHAR(50) PRIMARY KEY,
        content TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS client_reminders (
        id SERIAL PRIMARY KEY,
        client_phone VARCHAR(50),
        client_name VARCHAR(100),
        title TEXT,
        alert_at TIMESTAMP,
        is_processed BOOLEAN DEFAULT FALSE,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(50) UNIQUE,
        client_name VARCHAR(100) DEFAULT 'Cliente Nuevo',
        client_phone VARCHAR(50),
        status VARCHAR(30) DEFAULT 'NUEVO',
        items_to_clean TEXT,
        location TEXT,
        address TEXT,
        estimated_value NUMERIC(12,2) DEFAULT 0,
        advisor VARCHAR(100),
        lost_reason TEXT,
        technical_images TEXT[] DEFAULT '{}',
        source VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        assigned_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(50) REFERENCES conversations(id) ON DELETE CASCADE,
        sender VARCHAR(20),
        type VARCHAR(20) DEFAULT 'text',
        content TEXT,
        attachment_url TEXT,
        external_id VARCHAR(100) UNIQUE,
        timestamp TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS services (
        id VARCHAR(50) PRIMARY KEY,
        date DATE,
        time VARCHAR(10),
        client_name VARCHAR(100) DEFAULT 'Sin Nombre',
        client_phone VARCHAR(50),
        city VARCHAR(50),
        neighborhood VARCHAR(100),
        address TEXT,
        advisor VARCHAR(100),
        operators TEXT[],
        items_to_clean TEXT,
        service_performed TEXT,
        observations TEXT,
        initial_value NUMERIC(12,2) DEFAULT 0,
        additional_items TEXT,
        additional_value NUMERIC(12,2) DEFAULT 0,
        total_value NUMERIC(12,2) DEFAULT 0,
        payment_method VARCHAR(50),
        expenses NUMERIC(12,2) DEFAULT 0,
        expenses_note TEXT,
        operator_payment NUMERIC(12,2) DEFAULT 0,
        advances NUMERIC(12,2) DEFAULT 0,
        net_profit NUMERIC(12,2) DEFAULT 0,
        is_warranty BOOLEAN DEFAULT FALSE,
        deal_status VARCHAR(20) DEFAULT 'AGENDADO',
        technical_images TEXT[] DEFAULT '{}',
        after_images TEXT[] DEFAULT '{}',
        client_signature TEXT,
        cancellation_reason TEXT,
        source VARCHAR(50),
        reschedule_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE,
        password TEXT,
        role VARCHAR(20),
        phone VARCHAR(50),
        active BOOLEAN DEFAULT TRUE,
        commission_pct NUMERIC(5,2) DEFAULT 0,
        parent_id INTEGER REFERENCES employees(id),
        is_online BOOLEAN DEFAULT TRUE,
        last_assigned_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100),
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(50) REFERENCES conversations(id) ON DELETE CASCADE,
        title TEXT,
        due_date DATE,
        completed BOOLEAN DEFAULT FALSE,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );
      -- v3.1 Monitoreo: qué se rompió y cuándo, para no depender de los logs.
      CREATE TABLE IF NOT EXISTS system_events (
        id SERIAL PRIMARY KEY,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        message TEXT NOT NULL,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_events_level ON system_events(level);
      -- v5 Parte 2A Facturación y cobros (Colombia). La numeración sale de
      -- settings.invoice_next_number (empieza en 1 -> FAC-0001). NO es
      -- facturación electrónica DIAN: ver README, sección v5 Facturación.
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        number TEXT UNIQUE NOT NULL,
        -- v5.1 Tipo de factura: 'normal' (factura de venta sin DIAN, por
        -- defecto) o 'electronica' (DIAN-ready). El consecutivo FAC-XXXX es
        -- compartido por ambos tipos.
        type TEXT DEFAULT 'normal' CHECK (type IN ('normal', 'electronica')),
        service_id VARCHAR(50) REFERENCES services(id) ON DELETE SET NULL,
        client_name TEXT,
        client_phone VARCHAR(50),
        client_nit TEXT,
        subtotal NUMERIC(12,2) DEFAULT 0,
        advances NUMERIC(12,2) DEFAULT 0,
        total NUMERIC(12,2) DEFAULT 0,
        balance NUMERIC(12,2) DEFAULT 0,
        status TEXT DEFAULT 'pendiente',
        payment_method VARCHAR(50),
        payment_link TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        method TEXT,
        reference TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_service ON invoices(service_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(type);
      CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
    `);
    // v5.1 Migración segura: las bases creadas en v5.0 tienen la tabla
    // invoices sin la columna type. Se añade aquí; las facturas viejas
    // quedan como 'normal' (factura de venta sin DIAN).
    await client.query(`
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'normal' CHECK (type IN ('normal', 'electronica'));
    `);

    // INICIALIZAR ESCALAFONES BASADOS EN CONTRATOS (Si están vacíos)
    const tierCheck = await client.query('SELECT COUNT(*) FROM commission_tiers');
    if (parseInt(tierCheck.rows[0].count) === 0) {
      // Tiers Asesores
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 0, 10000000, 3)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 10000001, 20000000, 3.5)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 20000001, 30000000, 4)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 30000001, 40000000, 4.5)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 40000001, 999999999, 5)");
      
      // Tiers Directores
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 0, 20000000, 2)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 20000001, 50000000, 3)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 50000001, 80000000, 3.5)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 80000001, 999999999, 4)");
    }

    // v5.2 Unificación de roles a minúscula: las instalaciones viejas
    // guardaban 'Admin'/'Advisor'/'Sales_Agent' en employees y
    // commission_tiers. Se normalizan las filas existentes (sin borrar
    // usuarios); los nuevos registros ya se guardan en minúscula.
    try {
      await client.query("UPDATE employees SET role = LOWER(role) WHERE role IS NOT NULL AND role <> LOWER(role)");
      await client.query("UPDATE commission_tiers SET role = LOWER(role) WHERE role IS NOT NULL AND role <> LOWER(role)");
    } catch (e) { logger.warn('No se pudo normalizar roles existentes a minúscula', e); }
    // Admin inicial SOLO si ADMIN_EMAIL y ADMIN_PASSWORD están definidos en el
    // entorno. Sin ellos NO se crea ningún usuario (antes se creaba un admin
    // con una clave débil por defecto; eso se eliminó).
    const employeeCount = await client.query('SELECT COUNT(*) FROM employees');
    if (parseInt(employeeCount.rows[0].count) === 0) {
      const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
      const adminPassword = process.env.ADMIN_PASSWORD || '';
      if (adminEmail && adminPassword) {
        const hashedPw = await bcrypt.hash(adminPassword, 10);
        await client.query(
          'INSERT INTO employees (name, email, password, role, phone, active) VALUES ($1, $2, $3, $4, $5, $6)',
          ['Administrador', adminEmail, hashedPw, 'admin', '0000000000', true]
        );
        logger.info(`Admin inicial creado: ${adminEmail} (cambia la contraseña tras entrar)`);
      } else {
        logger.warn('Sin empleados y sin ADMIN_EMAIL/ADMIN_PASSWORD: no se creó admin inicial');
      }
    }
    
    await client.query("INSERT INTO settings (key, value) VALUES ('daily_capacity', '15') ON CONFLICT DO NOTHING");
    // v5 Facturación: consecutivo de facturas. Empieza en 1 -> FAC-0001.
    await client.query("INSERT INTO settings (key, value) VALUES ('invoice_next_number', '1') ON CONFLICT DO NOTHING");
    // v5.1 Tipo de factura por defecto: 'normal' (factura de venta sin DIAN).
    await client.query("INSERT INTO settings (key, value) VALUES ('invoice_default_type', 'normal') ON CONFLICT DO NOTHING");
    // v5.3 Google Calendar: duración por defecto de los eventos (minutos).
    await client.query("INSERT INTO settings (key, value) VALUES ('google_calendar_duration_minutes', '120') ON CONFLICT DO NOTHING");
    await client.query("INSERT INTO settings (key, value) VALUES ('google_calendar_enabled', 'true') ON CONFLICT DO NOTHING");
    // v5.3 Google Calendar: id del evento en Calendar para actualizarlo o
    // borrarlo al reprogramar/cancelar. Las bases viejas no tienen la columna.
    await client.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS google_calendar_event_id TEXT');

    // --- OPTIMIZACIÓN: ÍNDICES PARA VELOCIDAD ---
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_services_client_phone ON services(client_phone);
      CREATE INDEX IF NOT EXISTS idx_services_date ON services(date);
      CREATE INDEX IF NOT EXISTS idx_services_advisor ON services(advisor);
      CREATE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_phone);
      CREATE INDEX IF NOT EXISTS idx_leads_advisor ON leads(advisor);
      CREATE INDEX IF NOT EXISTS idx_conversations_client_phone ON conversations(client_phone);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      -- v5 Parte 2B: canal por conversación ('qr' | 'meta'). Las bases
      -- creadas antes de la v5 Parte 2B no tienen la columna: se añade aquí.
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel VARCHAR(10) DEFAULT 'qr';
    `);
    // v5.3 Migraciones seguras (solo warning si fallan, sin romper el
    // arranque): una factura por servicio (el chequeo de existente no tiene
    // bloqueo y dos creaciones concurrentes duplicaban la factura) y
    // escalafones sin duplicar el mismo tramo (role, min, max).
    try {
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_service_unique ON invoices(service_id)');
    } catch (e) { logger.warn('No se pudo crear el índice único de invoices.service_id (puede haber facturas duplicadas previas)', e); }
    try {
      const c = await client.query("SELECT 1 FROM pg_constraint WHERE conname = 'uq_commission_tier_range'");
      if (!c.rows.length) {
        await client.query('ALTER TABLE commission_tiers ADD CONSTRAINT uq_commission_tier_range UNIQUE (role, min_value, max_value)');
      }
    } catch (e) { logger.warn('No se pudo crear la restricción única de commission_tiers (puede haber tramos duplicados previos)', e); }
    // El flag SOLO al final de initDB: antes se ponía antes del seed y, si
    // el seed fallaba después, el servidor quedaba con la DB a medias
    // pero anunciando que la tabla de eventos estaba lista.
    eventsTableReady = true;
    await flushEventBuffer();
    dbOk = true;
    // v5.3.2: levantar las instancias de WhatsApp guardadas (QR con la
    // sesión del volumen y Meta virtuales). Antes no se hacía: tras cada
    // redespliegue había que darle a Reconectar a mano. No bloquea el
    // arranque si falla.
    try { await restoreWhatsAppInstances(); } catch (e) { logger.warn('No se pudieron restaurar las instancias de WhatsApp al arrancar', e); }
  } catch (err) { console.error('DB Init Error:', err); } finally { if (client) client.release(); }
};
initDB();

// Endpoints Escalafones
// --- ENDPOINTS DE WHATSAPP ---

app.get('/api/wa/instances', (req, res) => {
  const instances = Object.keys(waClients).map(id => ({
    id,
    name: waClients[id].name,
    status: waClients[id].status,
    channel: waClients[id].channel || 'qr',
    hasQr: !!waClients[id].qr
  }));
  res.json(instances);
});

// Estado de Meta Cloud API (JWT; el token NUNCA sale del servidor, solo
// booleanos: configurado o no, y el phone number id, que no es secreto).
app.get('/api/wa/meta/status', async (req, res) => {
  try {
    const meta = await getMetaConfig();
    res.json({
      configured: meta.configured,
      hasToken: Boolean(meta.token),
      tokenSource: meta.tokenSource,
      phoneNumberId: meta.phoneNumberId || null,
      verifyTokenConfigured: meta.verifyTokenConfigured,
      appSecretConfigured: meta.appSecretConfigured,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wa/instances', async (req, res) => {
  try {
    const { id, name, channel } = req.body;
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    // La instancia ya existe en memoria: no se sobrescribe su canal en
    // settings ni se responde success (para cambiar de canal está
    // PATCH /api/wa/instances/:id/channel).
    if (waClients[id]) return res.status(409).json({ error: 'La instancia ya existe' });

    // Canal: el del body, o el guardado antes en settings (wa_channel_<id>),
    // o 'qr' por defecto. Se guarda para que sobreviva a reinicios.
    let wanted = channel === 'meta' || channel === 'qr' ? channel : null;
    if (!wanted && dbOk) {
      try { wanted = (await getSettingValue(`wa_channel_${id}`, '')) || null; } catch { /* sin settings aún */ }
    }
    wanted = wanted === 'meta' ? 'meta' : 'qr';
    if (dbOk) {
      try { await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`wa_channel_${id}`, wanted]); } catch { /* solo memoria */ }
      // v5.3.2: guardar también el nombre, para que la restauración al
      // arrancar muestre el mismo nombre y no solo el id.
      try { await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`wa_name_${id}`, name || id]); } catch { /* solo memoria */ }
    }

    await initWhatsApp(id, name || id, wanted);
    res.json({ success: true, message: wanted === 'meta' ? 'Instancia Meta registrada (sin QR)' : 'Instancia inicializándose', channel: wanted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cambiar el canal de una instancia (QR <-> Meta). Re-inicializa la
// instancia: al pasar a Meta se destruye el cliente de WhatsApp Web; al
// volver a QR se genera un QR nuevo para escanear.
app.patch('/api/wa/instances/:id/channel', async (req, res) => {
  const { id } = req.params;
  const { channel } = req.body || {};
  if (channel !== 'qr' && channel !== 'meta') return res.status(400).json({ error: "channel debe ser 'qr' o 'meta'" });
  const inst = waClients[id];
  if (!inst) return res.status(404).json({ error: 'Instancia no encontrada' });
  if ((inst.channel || 'qr') === channel) return res.json({ success: true, channel, message: 'La instancia ya usaba ese canal' });
  const name = inst.name || id;
  try {
    await stopWaInstance(id); // v5.3.2: parada centralizada (vigilante + destroy con tope)
    if (dbOk) {
      try { await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`wa_channel_${id}`, channel]); } catch { /* solo memoria */ }
    }
    await initWhatsApp(id, name, channel);
    recordEvent('info', 'whatsapp', `Canal de ${name} cambiado a ${channel === 'meta' ? 'Meta Cloud API' : 'QR'}`, { instance: id, channel });
    res.json({ success: true, channel });
  } catch (e) {
    recordEvent('error', 'whatsapp', `No se pudo cambiar el canal de ${name}: ${e.message}`, { instance: id });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wa/qr/:id', (req, res) => {
  const instance = waClients[req.params.id];
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  if ((instance.channel || 'qr') === 'meta') return res.status(400).json({ error: 'Esta instancia usa Meta Cloud API y no tiene QR' });
  res.json({ qr: instance.qr, status: instance.status });
});

app.delete('/api/wa/instances/:id', async (req, res) => {
  const { id } = req.params;
  if (waClients[id]) {
    try {
      // v5.3.2: logout primero (cierra la sesión en el teléfono) y luego
      // parada centralizada; antes, si logout() fallaba, destroy() nunca se
      // llamaba y el Chrome quedaba vivo como zombi con la sesión abierta.
      if (waClients[id].client) {
        try { await waClients[id].client.logout(); } catch { /* sin sesión que cerrar */ }
      }
      await stopWaInstance(id);
      if (dbOk) {
        try { await pool.query('DELETE FROM settings WHERE key = $1', [`wa_channel_${id}`]); } catch { /* noop */ }
        try { await pool.query('DELETE FROM settings WHERE key = $1', [`wa_name_${id}`]); } catch { /* noop */ }
      }
      res.json({ success: true });
    } catch (e) {
      clearWaWatchdog(id);
      delete waClients[id];
      res.json({ success: true, warning: 'Error al cerrar sesión, pero instancia removida' });
    }
  } else {
    res.status(404).json({ error: 'No encontrada' });
  }
});

// POST /api/wa/send eliminado en v4: ningún componente lo llamaba; el envío
// desde el inbox va por POST /api/chats/:id/messages (que además guarda el
// mensaje y lo manda por la instancia de WhatsApp por QR o por Meta, según
// el canal de la conversación).

// --- FIN ENDPOINTS WHATSAPP ---

// ---------- WEBHOOK WHATSAPP META CLOUD API v5 Parte 2B ----------
// GET: verificación del webhook (lo llama Meta al guardar la URL).
// Sin META_WA_VERIFY_TOKEN configurado, o si el token no coincide, 403.
// POST: mensajes entrantes. Si META_WA_APP_SECRET está configurado, se
// verifica X-Hub-Signature-256 (HMAC SHA256 del body crudo, guardado en
// req.rawBody antes de que express.json lo parseara); si no coincide, 401.
// Sin secreto, se acepta y se registra un aviso en system_events (una vez
// por arranque, para no llenar la tabla con un evento por mensaje).
let metaNoSecretWarned = false;

app.get('/api/webhooks/meta', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const meta = await getMetaConfig();
  if (mode === 'subscribe' && token && meta.verifyToken && token === meta.verifyToken) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.status(403).json({ error: 'Verificación de webhook Meta fallida: verify token no coincide o META_WA_VERIFY_TOKEN no está configurado' });
});

app.post('/api/webhooks/meta', async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const meta = await getMetaConfig();
    if (meta.appSecret) {
      const sig = req.headers['x-hub-signature-256'] || '';
      const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const expected = `sha256=${crypto.createHmac('sha256', meta.appSecret).update(raw).digest('hex')}`;
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) {
        await recordEvent('warn', 'whatsapp', 'Webhook Meta rechazado: firma X-Hub-Signature-256 inválida', {});
        return res.status(401).json({ error: 'Firma de webhook inválida' });
      }
    } else if (!metaNoSecretWarned) {
      metaNoSecretWarned = true;
      await recordEvent('warn', 'whatsapp', 'Webhook Meta sin META_WA_APP_SECRET: la firma no se verificó (evento aceptado). Configura el secreto en .env para verificar que los eventos vienen de Meta.', {});
    }

    // Solo se procesan mensajes de texto. Los estados (entregado/leído) y
    // los mensajes multimedia se ignoran por ahora (no hay visor de media
    // en el inbox); el texto es lo que el CRM guarda y muestra.
    let received = 0;
    let stored = 0;
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const msg of value.messages || []) {
          received++;
          if (msg.type !== 'text' || !msg.text?.body) continue;
          const dup = await pool.query('SELECT 1 FROM messages WHERE external_id = $1', [msg.id]);
          if (dup.rows.length > 0) continue;
          const senderName = (value.contacts || []).find((c) => c.wa_id === msg.from)?.profile?.name || null;
          const convId = await handleIncomingWhatsApp({
            phone: msg.from,
            content: msg.text.body,
            sourceName: 'WhatsApp Meta',
            channel: 'meta',
            externalId: msg.id || null,
            senderName,
          });
          if (convId) stored++;
        }
      }
    }
    res.json({ ok: true, received, stored });
  } catch (err) {
    logger.error('Error procesando webhook Meta', err);
    res.status(500).json({ error: err.message });
  }
});

// v5 Parte 2C: los escalafones solo los ve y los toca el admin. El
// Dashboard ya no los lee (usa /api/stats/commissions) y la pestaña
// "CommissionTiers" de Equipo solo existe para admin.
app.get('/api/commission-tiers', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM commission_tiers ORDER BY role, min_value ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/commission-tiers', requireAdmin, async (req, res) => {
  const { min_value, max_value, percentage } = req.body;
  const role = normalizeRoleValue(req.body?.role);
  if (!role || !['advisor', 'sales_agent'].includes(role)) return res.status(400).json({ error: "role debe ser 'advisor' o 'sales_agent'" });
  const min = Number(min_value);
  const max = max_value === null || max_value === undefined || max_value === '' ? null : Number(max_value);
  const pct = Number(percentage);
  if (!Number.isFinite(min) || min < 0) return res.status(400).json({ error: 'min_value debe ser un número >= 0' });
  if (max !== null && (!Number.isFinite(max) || max <= min)) return res.status(400).json({ error: 'max_value debe ser mayor que min_value' });
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'percentage debe estar entre 0 y 100' });
  try {
    await pool.query('INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ($1, $2, $3, $4)', [role, min, max, pct]);
    await recordEvent('info', 'staff', `Escalafón creado: ${role} ${min}-${max} al ${pct}%`, { role, min_value: min, max_value: max, percentage: pct });
    notifyUpdate('settings');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/commission-tiers/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM commission_tiers WHERE id = $1', [req.params.id]);
    await recordEvent('warn', 'staff', `Escalafón ${req.params.id} eliminado por ${req.user?.email || 'admin'}`, { tier_id: req.params.id });
    notifyUpdate('settings');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Socket autenticado: el cliente envía el JWT en handshake.auth.token.
// Sin token válido no hay conexión en tiempo real.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No autorizado: falta token'));
  try {
    socket.user = jwt.verify(token, jwtSecret);
    next();
  } catch (e) {
    next(new Error('No autorizado: token inválido'));
  }
});

io.on('connection', (socket) => {
  // La sala por usuario se une AQUÍ, desde socket.user (ya verificado en
  // el handshake): antes solo se unía cuando el cliente emitía 'identify'
  // y, si no lo emitía o se reconectaba, los updates dirigidos no llegaban.
  {
    const id = socket.user?.id;
    const role = socket.user?.role;
    if (id) {
      socket.join(id.toString());
      if ((role || '').toLowerCase() === 'admin') socket.join('global_admin');
    }
  }
  // MODIFICACIÓN: Identificación avanzada con Rol
  // La identidad viene del JWT verificado en el handshake (socket.user),
  // no de lo que el cliente diga. Se mantiene por compatibilidad con
  // clientes viejos que aún emiten 'identify' (unirse dos veces a la
  // misma sala es inocuo).
  socket.on('identify', () => {
    const id = socket.user?.id;
    const role = socket.user?.role;
    if (id) {
      const room = id.toString();
      socket.join(room);
      
      // Si el usuario es administrador, se une a la sala global de admins
      if ((role || '').toLowerCase() === 'admin') {
        socket.join('global_admin');
        logger.info(`Admin [${socket.id}] unido a Sala Global: global_admin`);
      }
      
      logger.info(`Socket [${socket.id}] unido a Sala Usuario: ${room}`);
    }
  });
});

app.get('/api/notes/:phone', async (req, res) => {
  try {
    const phone = normalizePhoneString(req.params.phone);
    const r = await pool.query('SELECT * FROM client_notes WHERE client_phone = $1', [phone]);
    res.json(r.rows[0] || { client_phone: phone, content: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notes', async (req, res) => {
  const { phone: rawPhone, content } = req.body;
  const phone = normalizePhoneString(rawPhone);
  // content undefined sobrescribía la nota con NULL: ahora es obligatorio
  // (una cadena vacía sí vale, para borrar la nota).
  if (typeof content !== 'string') return res.status(400).json({ error: 'content es obligatorio' });
  try {
    await pool.query('INSERT INTO client_notes (client_phone, content, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (client_phone) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()', [phone, content]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reminders/:phone', async (req, res) => {
  try {
    const phone = normalizePhoneString(req.params.phone);
    const r = await pool.query('SELECT * FROM client_reminders WHERE client_phone = $1 ORDER BY alert_at ASC', [phone]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/active-reminders', async (req, res) => {
  try {
    // Alcance por JWT: cada usuario ve solo sus recordatorios; el admin
    // los ve todos. Antes devolvía los de TODOS a cualquiera.
    const role = normalizeRoleValue(req.user?.role);
    const r = role === 'admin'
      ? await pool.query('SELECT * FROM client_reminders WHERE is_processed = false AND alert_at <= NOW() + INTERVAL \'1 minute\'')
      : await pool.query('SELECT * FROM client_reminders WHERE is_processed = false AND alert_at <= NOW() + INTERVAL \'1 minute\' AND created_by = $1', [req.user?.name || '']);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reminders', async (req, res) => {
  const { phone: rawPhone, name, title, alertAt } = req.body;
  const phone = normalizePhoneString(rawPhone);
  // createdBy sale del JWT, nunca del body: antes cualquiera podía
  // suplantar a otro empleado. title obligatorio y alertAt con fecha
  // válida: un alertAt inválido daba 500 en el INSERT.
  const createdBy = req.user?.name || null;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
  if (!alertAt || Number.isNaN(Date.parse(alertAt))) return res.status(400).json({ error: 'alertAt debe ser una fecha válida' });
  try {
    const r = await pool.query('INSERT INTO client_reminders (client_phone, client_name, title, alert_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [phone, name, title, alertAt, createdBy]);
    const creator = await pool.query("SELECT id FROM employees WHERE name = $1", [createdBy]);
    notifyUpdate('reminder', creator.rows.map(u => u.id));
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reminders/:id/complete', async (req, res) => {
  try {
    await pool.query('UPDATE client_reminders SET is_processed = true WHERE id = $1', [req.params.id]);
    notifyUpdate('reminder');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reminders/:id', async (req, res) => {
  try {
    const cur = await pool.query('SELECT created_by FROM client_reminders WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Recordatorio no encontrado' });
    // Solo el dueño o un admin: antes cualquiera borraba el recordatorio
    // de cualquiera.
    const isAdmin = normalizeRoleValue(req.user?.role) === 'admin';
    if (!isAdmin && cur.rows[0].created_by !== req.user?.name) return res.status(403).json({ error: 'Solo el creador o un administrador puede borrar este recordatorio' });
    await pool.query('DELETE FROM client_reminders WHERE id = $1', [req.params.id]);
    notifyUpdate('reminder');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/availability', async (req, res) => {
  try {
    // time es VARCHAR y se comparaba como texto: '9:00' < '13:00' es falso
    // en texto, así que un servicio de las 9 se contaba en el PM. Ahora se
    // normaliza a HH:MM y se compara como hora; las horas con formato
    // inválido no se cuentan en ningún bloque.
    const r = await pool.query(`
      SELECT 
        date::text,
        COUNT(*) FILTER (WHERE time ~ '^\\d{1,2}:\\d{2}' AND (LPAD(SPLIT_PART(time, ':', 1), 2, '0') || ':' || SPLIT_PART(time, ':', 2))::time < TIME '13:00' AND deal_status NOT IN ('CANCELADO')) as am_count,
        COUNT(*) FILTER (WHERE time ~ '^\\d{1,2}:\\d{2}' AND (LPAD(SPLIT_PART(time, ':', 1), 2, '0') || ':' || SPLIT_PART(time, ':', 2))::time >= TIME '13:00' AND deal_status NOT IN ('CANCELADO')) as pm_count
      FROM services 
      WHERE date >= CURRENT_DATE 
      AND date <= CURRENT_DATE + INTERVAL '14 days'
      GROUP BY date
      ORDER BY date ASC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats/:id/messages', async (req, res) => {
  const { id } = req.params;
  // v5.2 Solo lectura para el operador (B5): puede leer los mensajes de
  // sus servicios, pero no enviar.
  if (normalizeRoleValue(req.user?.role) === 'operator') {
    return res.status(403).json({ error: 'Solo lectura: los operadores no pueden enviar mensajes' });
  }
  const { content, type, attachmentUrl } = req.body;
  const msgType = ['text', 'image', 'audio', 'video', 'document', 'sticker'].includes(type) ? type : 'text';
  try {
    let lastMsgPreview = content;
    if (!lastMsgPreview) {
      if (msgType === 'image') lastMsgPreview = '📷 Imagen';
      else if (msgType === 'audio') lastMsgPreview = '🎤 Nota de voz';
      else if (msgType === 'video') lastMsgPreview = '🎬 Video';
      else if (msgType === 'document') lastMsgPreview = '📎 Documento';
      else if (msgType === 'sticker') lastMsgPreview = '😀 Sticker';
      else lastMsgPreview = '📎 Archivo';
    }

    // 1. Conversación y canal (para saber por dónde enviar). La respuesta
    // incluye sent/error (contrato con el frontend): el mensaje SÍ queda
    // guardado, así que success sigue true y HTTP 200, pero el frontend
    // muestra "guardado pero no enviado" si sent=false.
    let sent = true;
    let sendError = null;
    let messageId = null;
    const convRes = await pool.query('SELECT client_phone, channel, source FROM conversations WHERE id = $1', [id]);
    if (convRes.rows.length > 0 && convRes.rows[0].client_phone) {
      const phone = convRes.rows[0].client_phone;
      let channel = convRes.rows[0].channel || 'qr';
      // Legado: conversaciones creadas antes de la v5 Parte 2B no tienen
      // channel; si su fuente nombra una instancia Meta, salen por Meta.
      if (!convRes.rows[0].channel) {
        const metaInst = Object.values(waClients).find((w) => w.channel === 'meta' && convRes.rows[0].source && convRes.rows[0].source.includes(w.name));
        if (metaInst) channel = 'meta';
      }
      // 2. Enviar a WhatsApp (texto y/o media). v5.3.6: se envía ANTES de
      // guardar para obtener el id del mensaje enviado y guardarlo como
      // external_id: el evento message_create dispara también por los
      // mensajes enviados desde el CRM, y sin ese id se guardarían dos
      // veces (una por este POST y otra por el evento).
      if (content || attachmentUrl) {
        let media = null;
        if (attachmentUrl) {
          const file = readWaAttachmentFile(attachmentUrl);
          if (file.error) {
            sent = false;
            sendError = file.error;
          } else {
            media = { type: msgType, mimetype: file.mimetype, data: file.data, filename: file.filename, attachmentUrl };
          }
        }
        if (sent) {
          const result = await sendWhatsAppMessage({ phone, content, channel, media });
          if (!result.ok) {
            sent = false;
            sendError = result.error;
            logger.error('Error enviando mensaje via WA', result.error);
            recordEvent('error', 'whatsapp', `No se pudo enviar el mensaje del chat a ${phone} (${channel}): ${result.error}`, { conversation: id, channel });
          } else {
            messageId = result.messageId || null;
          }
        }
      }
    } else {
      // Sin conversación o sin teléfono no hay a dónde enviar.
      sent = false;
      sendError = 'Conversación sin teléfono: el mensaje quedó guardado pero no se envió';
    }

    // 3. Guardar mensaje localmente con su external_id (o NULL si no se
    // envió). ON CONFLICT DO NOTHING: si message_create ya lo guardó
    // (el evento puede llegar antes que este INSERT), no se duplica.
    // v5.3.10 — Dedup de intentos fallidos: si el envío FALLÓ y en los
    // últimos 5 minutos ya se guardó un mensaje idéntico sin enviar en
    // esta misma conversación (mismo sender, type, content, adjunto y
    // external_id NULL), NO se inserta otra copia: cada reintento del
    // usuario era una burbuja más ("hola" x4, "holmo" x3 en producción).
    // El caso de éxito no cambia.
    let skippedDuplicate = false;
    if (!sent) {
      const dup = await pool.query(
        `SELECT id FROM messages WHERE conversation_id = $1 AND sender = 'agent' AND type = $2 AND content = $3 AND attachment_url IS NOT DISTINCT FROM $4 AND external_id IS NULL AND timestamp > NOW() - INTERVAL '5 minutes' LIMIT 1`,
        [id, msgType, content || '', attachmentUrl || null]
      );
      skippedDuplicate = dup.rows.length > 0;
      if (skippedDuplicate) logger.info(`Chat ${id}: intento fallido duplicado (mismo contenido sin enviar en 5 min); no se guarda otra copia.`);
    }
    if (!skippedDuplicate) {
      await pool.query(
        'INSERT INTO messages (conversation_id, sender, type, content, attachment_url, timestamp, external_id) VALUES ($1, $2, $3, $4, $5, NOW(), $6) ON CONFLICT (external_id) DO NOTHING',
        [id, 'agent', msgType, content || '', attachmentUrl || null, messageId]
      );
    }

    // 4. Actualizar conversación
    await pool.query(`UPDATE conversations SET last_message = $1, last_message_time = NOW(), unread_count = 0 WHERE id = $2`, [lastMsgPreview, id]);

    const advisorRes = await pool.query("SELECT e.id FROM employees e JOIN leads l ON e.name = l.advisor WHERE l.conversation_id = $1", [id]);
    notifyUpdate('chat', advisorRes.rows.map(r => r.id));
    res.json({ success: true, sent, error: sendError });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// v5.3.6 — Subida de adjuntos para el chat (imagen/audio/video/documento).
// El frontend sube primero el archivo aquí y luego envía el mensaje con el
// attachmentUrl devuelto. Tope 25 MB por archivo; los archivos quedan en
// uploads/wa-media/ (públicos por /uploads, como el logo).
const waMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(waMediaDir(), { recursive: true }); cb(null, waMediaDir()); },
    filename: (req, file, cb) => {
      const ext = waMediaExtFromMime(file.mimetype, file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    },
  }),
  limits: { fileSize: WA_MEDIA_MAX_BYTES },
});
app.post('/api/chats/:id/attachments', async (req, res) => {
  if (normalizeRoleValue(req.user?.role) === 'operator') {
    return res.status(403).json({ error: 'Solo lectura: los operadores no pueden enviar mensajes' });
  }
  waMediaUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera 25 MB' : (err.message || 'No se pudo subir el archivo');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Sube un archivo' });
    const mimetype = req.file.mimetype || '';
    const okMime = mimetype.startsWith('image/') || mimetype.startsWith('audio/') || mimetype.startsWith('video/') ||
      ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'].includes(mimetype);
    if (!okMime) {
      try { fs.unlinkSync(req.file.path); } catch { /* noop */ }
      return res.status(400).json({ error: 'Tipo de archivo no permitido (imagen, audio, video o documento)' });
    }
    const type = waMediaTypeFromMime(mimetype);
    res.json({ success: true, attachmentUrl: `/uploads/wa-media/${req.file.filename}`, type, filename: req.file.originalname, size: req.file.size, mimetype });
  });
});

app.get('/api/ranking', async (req, res) => {
  const { timeRange = 'month' } = req.query;
  try {
    let whereClauses = ["deal_status IN ('REALIZADO', 'PAGADO')"];
    if (timeRange === 'today') whereClauses.push("date = CURRENT_DATE");
    else if (timeRange === 'week') whereClauses.push("date >= CURRENT_DATE - INTERVAL '6 days'");
    else if (timeRange === 'month') whereClauses.push("EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)");

    const query = `
      SELECT 
        advisor as name, 
        SUM(total_value) as total, 
        COUNT(*) as count,
        SUM(CASE WHEN deal_status = 'PAGADO' THEN total_value ELSE 0 END) as paid_total
      FROM services 
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY advisor 
      ORDER BY total DESC
    `;
    const r = await pool.query(query);
    // v5.2 Alcance por rol (JWT): el asesor ve solo su fila, el líder la
    // suya y la de su red, el operador no ve el ranking de ventas.
    const scope = await getRoleScope(req);
    let rows = r.rows;
    if (scope.role === 'advisor') rows = rows.filter((x) => x.name === scope.userName);
    else if (scope.role === 'sales_agent') rows = rows.filter((x) => (scope.names || []).includes(x.name));
    else if (scope.role === 'operator') rows = [];
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard-stats', async (req, res) => {
  const { timeRange = 'month' } = req.query;
  try {
    let whereClauses = ["deal_status NOT IN ('CANCELADO')"];
    let params = [];
    
    // Filtro de tiempo
    if (timeRange === 'today') {
      whereClauses.push("date = CURRENT_DATE");
    } else if (timeRange === 'week') {
      whereClauses.push("date >= CURRENT_DATE - INTERVAL '6 days'");
    } else if (timeRange === 'month') {
      whereClauses.push("EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)");
    }

    // Filtro de rol v5.2: el alcance sale del JWT verificado (getRoleScope),
    // no de la query. Antes el frontend mandaba ?role=...&userName=... y el
    // servidor confiaba: cualquiera podía pedirse otro rol o usuario.
    const scope = await getRoleScope(req);
    if (scope.role === 'operator') {
      params.push(scope.userName);
      whereClauses.push(`$${params.length} = ANY(operators)`);
      whereClauses.push("deal_status NOT IN ('AGENDADO', 'REAGENDADO')");
    } else if (scope.role !== 'admin') {
      params.push(scope.names);
      whereClauses.push(`advisor = ANY($${params.length})`);
    }

    const whereSql = whereClauses.length > 0 ? " WHERE " + whereClauses.join(" AND ") : "";

    const statsQuery = `
      SELECT 
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) as "grossIncome",
        COALESCE(SUM(expenses) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) as "totalExpenses",
        COALESCE(SUM(operator_payment) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) as "totalOperatorPayments",
        COUNT(*) as "totalServices",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'AGENDADO'), 0) as "scheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'CONFIRMADO'), 0) as "confirmedValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REAGENDADO'), 0) as "rescheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REALIZADO'), 0) as "doneValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) as "paidValue"
      FROM services
      ${whereSql}
    `;

    const stats = await pool.query(statsQuery, params);
    res.json(stats.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- TOTALES REALES DEL SERVIDOR v5 Parte 2C ----------
// Antes, Dashboard/BusinessDeals/LeadPipeline/AuditModule calculaban
// totales sobre la página de 50 registros que les llegaba (o, peor, el
// Dashboard estimaba las comisiones como una fracción fija de los
// ingresos). Ahora los totales globales salen de SQL con COUNT/SUM sobre
// TODOS los registros, sin LIMIT. Sin JWT -> 401 (authMiddleware).
// v5.2: cada rol ve SOLO sus totales (getRoleScope): el operador nunca
// ve los ingresos totales de la empresa. Ver /api/stats/overview y
// /api/stats/commissions.
//
// Filtro de periodo ?timeRange=today|week|month|all (por defecto all):
// se aplica a services.date y a leads.created_at con la misma
// semántica que /api/dashboard-stats. Los duplicados, el conteo de
// clientes y las facturas son siempre globales (no dependen del periodo).
app.get('/api/stats/overview', async (req, res) => {
  const { timeRange = 'all' } = req.query;
  try {
    // v5.2 Alcance por rol (JWT): antes cualquier usuario logueado veía
    // los totales de TODA la empresa (el hueco que se encontró en la
    // revisión de roles). Ahora: admin ve todo; asesor (vendedor) solo
    // lo suyo; líder de ventas lo suyo + lo de su red; operador solo sus
    // servicios asignados, NUNCA los ingresos totales de la empresa.
    const scope = await getRoleScope(req);
    const svcClauses = [];
    const leadClauses = [];
    const svcParams = [];
    const leadParams = [];
    if (scope.role === 'operator') {
      // En servicios, $1 es su nombre (columna operators); en leads, $1
      // son los teléfonos de los clientes de sus servicios asignados.
      svcParams.push(scope.userName);
      svcClauses.push(`$${svcParams.length} = ANY(operators)`);
      const opPhones = await operatorServicePhones(scope.userName);
      if (opPhones.length) { leadParams.push(opPhones); leadClauses.push(`client_phone = ANY($${leadParams.length})`); }
      else leadClauses.push('1 = 0');
    } else if (scope.role !== 'admin') {
      svcParams.push(scope.names);
      svcClauses.push(`advisor = ANY($${svcParams.length})`);
      leadParams.push(scope.names);
      leadClauses.push(`advisor = ANY($${leadParams.length})`);
    }
    if (timeRange === 'today') {
      svcClauses.push('date = CURRENT_DATE');
      leadClauses.push('created_at::date = CURRENT_DATE');
    } else if (timeRange === 'week') {
      svcClauses.push("date >= CURRENT_DATE - INTERVAL '6 days'");
      leadClauses.push("created_at >= CURRENT_DATE - INTERVAL '6 days'");
    } else if (timeRange === 'month') {
      svcClauses.push('EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)');
      leadClauses.push('EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)');
    }
    const svcWhere = svcClauses.length ? 'WHERE ' + svcClauses.join(' AND ') : '';
    const leadWhere = leadClauses.length ? 'WHERE ' + leadClauses.join(' AND ') : '';
    const leadWhereAnd = (extra) => (leadClauses.length ? 'WHERE ' + [...leadClauses, extra].join(' AND ') : 'WHERE ' + extra);
    const svcWhereAnd = (extra) => (svcClauses.length ? 'WHERE ' + [...svcClauses, extra].join(' AND ') : 'WHERE ' + extra);
    // Clientes dentro del alcance: para asesor/líder, conversaciones con
    // lead suyo o servicio suyo; para operador, conversaciones de
    // clientes con un servicio asignado a él.
    let clientsSql = 'SELECT COUNT(*)::int AS count FROM clients';
    let clientsParams = [];
    if (scope.role === 'operator') {
      clientsSql = 'SELECT COUNT(*)::int AS count FROM conversations c WHERE EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND $1 = ANY(s2.operators))';
      clientsParams = [scope.userName];
    } else if (scope.role !== 'admin') {
      clientsSql = 'SELECT COUNT(*)::int AS count FROM conversations c LEFT JOIN leads l ON c.id = l.conversation_id WHERE l.advisor = ANY($1) OR EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND s2.advisor = ANY($1))';
      clientsParams = [scope.names];
    }
    const dupesScope = scope.role === 'admin' ? '' : scope.role === 'operator' ? 'AND $1 = ANY(operators)' : 'AND advisor = ANY($1)';
    // Facturas dentro del alcance: antes solo se filtraba al operador y
    // el asesor/líder veía las facturas de TODA la empresa. La factura
    // pertenece al asesor del servicio.
    const invoicesScope = scope.role === 'admin' ? ''
      : scope.role === 'operator' ? 'WHERE service_id IN (SELECT id FROM services WHERE $1 = ANY(operators))'
      : 'WHERE service_id IN (SELECT id FROM services WHERE advisor = ANY($1))';
    const invoicesParams = scope.role === 'admin' ? [] : scope.role === 'operator' ? [scope.userName] : [scope.names];

    const [rev, byStatus, byStage, leadLoss, svcCancel, clients, dupes, invoices] = await Promise.all([
      pool.query(`SELECT
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS "grossIncome",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'AGENDADO'), 0) AS "scheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'CONFIRMADO'), 0) AS "confirmedValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REAGENDADO'), 0) AS "rescheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REALIZADO'), 0) AS "doneValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS "paidValue",
        COALESCE(SUM(expenses) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) AS "totalExpenses",
        COALESCE(SUM(operator_payment) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) AS "totalOperatorPayments",
        COUNT(*)::int AS "totalServices"
        FROM services ${svcWhere}`, svcParams),
      pool.query(`SELECT deal_status AS status, COUNT(*)::int AS count, COALESCE(SUM(total_value), 0) AS "totalValue" FROM services ${svcWhere} GROUP BY deal_status ORDER BY count DESC`, svcParams),
      pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(estimated_value), 0) AS "estimatedValue" FROM leads ${leadWhere} GROUP BY status ORDER BY count DESC`, leadParams),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(lost_reason), ''), 'Sin motivo') AS reason, COUNT(*)::int AS count FROM leads ${leadWhereAnd("status = 'PERDIDO'")} GROUP BY 1 ORDER BY count DESC`, leadParams),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(cancellation_reason), ''), 'Sin motivo') AS reason, COUNT(*)::int AS count FROM services ${svcWhereAnd("deal_status = 'CANCELADO'")} GROUP BY 1 ORDER BY count DESC`, svcParams),
      pool.query(clientsSql, clientsParams),
      // Duplicados en TODA la base (dentro del alcance): mismo teléfono y
      // misma fecha, sin CANCELADO. Antes la Auditoría solo miraba la
      // página de 50.
      pool.query(`SELECT client_phone AS phone, MAX(client_name) AS name, date::text AS date, COUNT(*)::int AS count
        FROM services WHERE client_phone IS NOT NULL AND date IS NOT NULL AND deal_status <> 'CANCELADO' ${dupesScope}
        GROUP BY client_phone, date HAVING COUNT(*) > 1 ORDER BY count DESC, date DESC`, svcParams),
      pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(balance), 0) AS balance FROM invoices ${invoicesScope} GROUP BY status ORDER BY count DESC`, invoicesParams),
    ]);

    const num = (v) => Number(v) || 0;
    const r = rev.rows[0] || {};
    // Motivos de pérdida combinados (leads PERDIDO + servicios CANCELADO).
    const combined = {};
    for (const row of [...leadLoss.rows, ...svcCancel.rows]) {
      combined[row.reason] = (combined[row.reason] || 0) + row.count;
    }
    res.json({
      timeRange,
      // Para que el frontend sepa de quién son estos totales y pueda
      // avisar cuando no son los de toda la empresa.
      scope: { role: scope.role, userName: scope.userName },
      revenue: {
        grossIncome: num(r.grossIncome), scheduledValue: num(r.scheduledValue),
        confirmedValue: num(r.confirmedValue), rescheduledValue: num(r.rescheduledValue),
        doneValue: num(r.doneValue), paidValue: num(r.paidValue),
        totalExpenses: num(r.totalExpenses), totalOperatorPayments: num(r.totalOperatorPayments),
        totalServices: Number(r.totalServices) || 0,
      },
      servicesByStatus: byStatus.rows.map((x) => ({ status: x.status, count: Number(x.count) || 0, totalValue: num(x.totalValue) })),
      leadsByStage: byStage.rows.map((x) => ({ status: x.status, count: Number(x.count) || 0, estimatedValue: num(x.estimatedValue) })),
      leadLossReasons: leadLoss.rows.map((x) => ({ reason: x.reason, count: Number(x.count) || 0 })),
      serviceCancellationReasons: svcCancel.rows.map((x) => ({ reason: x.reason, count: Number(x.count) || 0 })),
      lossReasons: Object.entries(combined).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      clientsCount: Number(clients.rows[0]?.count) || 0,
      duplicates: dupes.rows.map((x) => ({ phone: x.phone, name: x.name, date: x.date, count: Number(x.count) || 0 })),
      invoicesByStatus: invoices.rows.map((x) => ({ status: x.status, count: Number(x.count) || 0, total: num(x.total), balance: num(x.balance) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comisiones reales por empleado y periodo, con la tabla
// commission_tiers (tramos por rol: advisor y sales_agent). Base del
// tramo: ingresos PAGADOS del periodo (services.total_value con
// deal_status='PAGADO'). Para un sales_agent la base es la de su equipo:
// servicios donde advisor es él o uno de sus subordinados directos
// (employees.parent_id = su id), igual que /api/dashboard-stats. El
// operador no tiene escalafón: su fila trae los números de sus servicios
// asignados (valor de los servicios, no su pago) y percentage/commission
// en null con nota. v5.2: el listado se acota por rol (JWT): el asesor
// solo se ve a sí mismo, el líder a sí mismo y a su red, el operador
// solo a sí mismo; el admin ve a todos.
// ?month=YYYY-MM tiene prioridad; si no, ?timeRange=today|week|month|all;
// por defecto el mes en curso. Si no hay tramo aplicable para el
// ingreso del periodo, percentage y commission salen null con la nota
// "sin tramo": NUNCA se inventa un porcentaje ni se usa el 4% fijo.
// Los tramos de la tabla son datos (3%-5% según el tramo), no una
// estimación: el porcentaje aplicado es siempre el de la tabla.
app.get('/api/stats/commissions', async (req, res) => {
  const { month, timeRange } = req.query;
  try {
    let periodLabel;
    let svcClauses = [];
    if (typeof month === 'string' && month !== '') {
      const m = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
      if (!m) return res.status(400).json({ error: 'month debe ser YYYY-MM' });
      periodLabel = month;
      svcClauses.push(`EXTRACT(YEAR FROM date) = ${Number(m[1])} AND EXTRACT(MONTH FROM date) = ${Number(m[2])}`);
    } else if (timeRange === 'today') {
      periodLabel = 'today';
      svcClauses.push('date = CURRENT_DATE');
    } else if (timeRange === 'week') {
      periodLabel = 'week';
      svcClauses.push("date >= CURRENT_DATE - INTERVAL '6 days'");
    } else if (timeRange === 'all') {
      periodLabel = 'all';
    } else {
      // 'month' o por defecto: mes en curso.
      periodLabel = 'month';
      svcClauses.push('EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)');
    }
    const svcWhere = svcClauses.length ? 'WHERE ' + svcClauses.join(' AND ') : '';

    // v5.2 Alcance por rol (JWT): qué empleados se ven.
    const scope = await getRoleScope(req);
    let employeesSql = 'SELECT id, name, role FROM employees WHERE active = true ORDER BY role, name';
    let employeesParams = [];
    if (scope.role === 'sales_agent') {
      employeesSql = 'SELECT id, name, role FROM employees WHERE active = true AND (id = $1 OR parent_id = $1) ORDER BY role, name';
      employeesParams = [scope.userId];
    } else if (scope.role !== 'admin') {
      employeesSql = 'SELECT id, name, role FROM employees WHERE active = true AND id = $1 ORDER BY role, name';
      employeesParams = [scope.userId];
    }

    const [employees, tiers, revenueByAdvisor] = await Promise.all([
      pool.query(employeesSql, employeesParams),
      pool.query('SELECT role, min_value, max_value, percentage FROM commission_tiers ORDER BY role, min_value ASC'),
      pool.query(`SELECT advisor AS name, COUNT(*)::int AS count,
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS paid,
        COALESCE(SUM(total_value) FILTER (WHERE deal_status <> 'CANCELADO'), 0) AS total
        FROM services ${svcWhere} GROUP BY advisor`),
    ]);
    const revByName = new Map(revenueByAdvisor.rows.map((x) => [x.name, { count: Number(x.count) || 0, paid: Number(x.paid) || 0, total: Number(x.total) || 0 }]));
    const tiersByRole = new Map();
    for (const t of tiers.rows) {
      const k = (t.role || '').toLowerCase();
      if (!tiersByRole.has(k)) tiersByRole.set(k, []);
      tiersByRole.get(k).push({ min: Number(t.min_value), max: Number(t.max_value), percentage: Number(t.percentage) });
    }

    const commissions = [];
    // Asesores cubiertos por la lista (para totalPaidRevenue sin duplicar:
    // el líder ya incluye a su equipo, así que cada nombre se cuenta una
    // sola vez; el operador no se añade: sus servicios ya cuentan bajo su
    // asesor).
    const coveredAdvisorNames = new Set();
    for (const emp of employees.rows) {
      const roleKey = (emp.role || '').toLowerCase();
      let paid = 0;
      let total = 0;
      let count = 0;
      let note = null;
      if (roleKey === 'sales_agent') {
        const team = await pool.query('SELECT name FROM employees WHERE parent_id = $1', [emp.id]);
        const names = [emp.name, ...team.rows.map((x) => x.name)];
        for (const n of names) {
          coveredAdvisorNames.add(n);
          const v = revByName.get(n);
          if (v) { paid += v.paid; total += v.total; count += v.count; }
        }
      } else if (roleKey === 'operator') {
        // El operador no vende ni tiene escalafón: sus números salen de
        // sus servicios asignados (valor de los servicios; su pago real
        // es operator_payment, que se ve en el Dashboard).
        const opWhere = svcWhere ? `${svcWhere} AND $1 = ANY(operators)` : 'WHERE $1 = ANY(operators)';
        const op = await pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS paid, COALESCE(SUM(total_value) FILTER (WHERE deal_status <> 'CANCELADO'), 0) AS total FROM services ${opWhere}`, [emp.name]);
        const rr = op.rows[0] || {};
        count = Number(rr.count) || 0; paid = Number(rr.paid) || 0; total = Number(rr.total) || 0;
        note = 'Operador: sin comisión por escalafón';
      } else {
        coveredAdvisorNames.add(emp.name);
        const v = revByName.get(emp.name);
        if (v) { paid = v.paid; total = v.total; count = v.count; }
      }
      const roleTiers = tiersByRole.get(roleKey) || [];
      // Tramos contiguos: el tramo i cubre [min_i, min_{i+1}) y el último
      // cubre [min, max] o [min, ∞) si max es null. Antes se usaba
      // paid>=min && paid<=max con tramos sembrados con huecos de $1
      // (0–10.000.000 y 10.000.001–20.000.000): un pagado de $10.000.000,50
      // no caía en ningún tramo y percentage/commission salían null.
      // Fallback: si paid supera todos los máximos, el tramo de mayor min.
      let tier = null;
      for (let i = 0; i < roleTiers.length; i++) {
        const t = roleTiers[i];
        const nextMin = i + 1 < roleTiers.length ? roleTiers[i + 1].min : null;
        const upperOk = nextMin !== null ? paid < nextMin : (t.max == null || paid <= t.max);
        if (paid >= t.min && upperOk) { tier = t; break; }
      }
      if (!tier && roleTiers.length && paid >= roleTiers[roleTiers.length - 1].min) tier = roleTiers[roleTiers.length - 1];
      commissions.push({
        employeeId: emp.id.toString(),
        name: emp.name,
        role: roleKey,
        revenue: total,
        paidRevenue: paid,
        totalServices: count,
        percentage: tier ? tier.percentage : null,
        commission: tier ? (paid * tier.percentage) / 100 : null,
        note: note || (tier ? null : 'sin tramo'),
      });
    }
    commissions.sort((a, b) => b.paidRevenue - a.paidRevenue);
    // totalPaidRevenue sobre SERVICIOS distintos: antes se sumaba el
    // paidRevenue de cada fila, pero el del líder YA incluye a su equipo,
    // así que si líder y subordinado aparecen los dos el total salía
    // inflado. Cada servicio tiene un solo asesor: se suma el pagado de
    // cada asesor cubierto una sola vez. El operador solo se ve a sí mismo
    // y su total es el de sus servicios asignados (su única fila).
    let totalPaidRevenue;
    if (scope.role === 'operator') {
      totalPaidRevenue = commissions.reduce((acc, c) => acc + c.paidRevenue, 0);
    } else {
      totalPaidRevenue = 0;
      for (const n of coveredAdvisorNames) totalPaidRevenue += revByName.get(n)?.paid || 0;
    }
    res.json({
      period: periodLabel,
      basis: 'paid',
      scope: { role: scope.role, userName: scope.userName },
      commissions,
      totalCommissions: commissions.reduce((acc, c) => acc + (c.commission || 0), 0),
      totalPaidRevenue,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cities', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT city FROM (
        SELECT city FROM services WHERE city IS NOT NULL
        UNION
        SELECT location as city FROM leads WHERE location IS NOT NULL
      ) as combined_cities ORDER BY city ASC
    `);
    res.json(r.rows.map(row => row.city));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients', async (req, res) => {
  const { search = '', city = 'all', type = 'all', spentRange = 'all' } = req.query;
  const { page, limit, offset } = clampPagination(req.query);
  
  try {
    let whereClauses = [];
    let params = [];

    if (search) {
      // Nombre/ubicación con el término tal cual; teléfono con todas sus
      // variantes (normalizado, sin + y 10 dígitos), así '3001234567'
      // encuentra filas guardadas como '+573001234567' y viceversa.
      // El término va escapado para LIKE (buscar '%' no devuelve todo).
      params.push(`%${escapeLike(search)}%`);
      const namePh = `$${params.length}`;
      const phoneCond = likeAny(params, 'c.client_phone', phoneSearchPatterns(search));
      whereClauses.push(`(c.client_name ILIKE ${namePh} OR l.location ILIKE ${namePh} OR ${phoneCond})`);
    }

    // v5.2 Alcance por rol (JWT): antes solo el asesor filtraba, y el
    // operador veía todos los clientes. Ahora cada rol ve solo los suyos
    // (el líder, además, los de su red).
    const scope = await getRoleScope(req);
    if (scope.role === 'operator') {
      params.push(scope.userName);
      whereClauses.push(`EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND $${params.length} = ANY(s2.operators))`);
    } else if (scope.role !== 'admin') {
      params.push(scope.names);
      whereClauses.push(`(l.advisor = ANY($${params.length}) OR EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND s2.advisor = ANY($${params.length})))`);
    }

    if (city !== 'all') {
      params.push(city);
      whereClauses.push(`(s_agg.city = $${params.length} OR l.location = $${params.length})`);
    }

    let query = `
      SELECT 
        c.client_phone as "clientPhone", 
        MAX(c.client_name) as "clientName", 
        MAX(COALESCE(l.location, s_agg.neighborhood, '')) as "neighborhood",
        MAX(COALESCE(l.address, s_agg.address, '')) as "address",
        MAX(COALESCE(s_agg.city, 'Bogotá')) as "city",
        COALESCE(s_agg.total_services, 0) as "totalServices",
        COALESCE(s_agg.total_spent, 0) as "totalSpent",
        MAX(COALESCE(s_agg.last_date, c.last_message_time)) as "lastServiceDate",
        MAX(c.source) as "source"
      FROM conversations c
      LEFT JOIN leads l ON c.id = l.conversation_id
      LEFT JOIN (
        SELECT client_phone, COUNT(*) as total_services, SUM(total_value) as total_spent, MAX(date) as last_date, MAX(neighborhood) as neighborhood, MAX(address) as address, MAX(city) as city FROM services WHERE deal_status <> 'CANCELADO' GROUP BY client_phone
      ) s_agg ON c.client_phone = s_agg.client_phone
    `;

    if (whereClauses.length > 0) {
      query += ` WHERE ` + whereClauses.join(' AND ');
    }

    query += ` GROUP BY c.client_phone, s_agg.total_services, s_agg.total_spent `;

    // Filtros de agregación (HAVING)
    if (type === 'recurrent') {
      query += ` HAVING COALESCE(s_agg.total_services, 0) > 0 `;
    } else if (type === 'prospect') {
      query += ` HAVING COALESCE(s_agg.total_services, 0) = 0 `;
    }

    if (spentRange !== 'all') {
      if (!query.includes('HAVING')) query += ' HAVING ';
      else query += ' AND ';
      
      if (spentRange === 'low') query += ` COALESCE(s_agg.total_spent, 0) > 0 AND COALESCE(s_agg.total_spent, 0) <= 200000 `;
      if (spentRange === 'mid') query += ` COALESCE(s_agg.total_spent, 0) > 200000 AND COALESCE(s_agg.total_spent, 0) <= 800000 `;
      if (spentRange === 'high') query += ` COALESCE(s_agg.total_spent, 0) > 800000 `;
      if (spentRange === 'zero') query += ` COALESCE(s_agg.total_spent, 0) = 0 `;
    }

    // Paginación
    const countQuery = `SELECT COUNT(*) FROM (${query}) as sub`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    query += ` ORDER BY "lastServiceDate" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const r = await pool.query(query, params);
    res.json({
      data: r.rows,
      total,
      page,
      limit
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:phone', requireAdmin, async (req, res) => {
  const { phone: rawPhone } = req.params;
  // Borra en todas sus formas (normalizada, sin + y 10 dígitos) para que no
  // queden restos de antes de la normalización (v5 Parte 2B).
  const { phone: norm } = normalizePhoneCO(rawPhone);
  const variants = [...new Set([norm, norm.replace('+', ''), norm.slice(3), rawPhone])].filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM services WHERE client_phone = ANY($1)', [variants]);
    await client.query('DELETE FROM leads WHERE client_phone = ANY($1)', [variants]);
    await client.query('DELETE FROM conversations WHERE client_phone = ANY($1)', [variants]);
    // Antes quedaban la fila en clients y sus notas/recordatorios.
    await client.query('DELETE FROM client_notes WHERE client_phone = ANY($1)', [variants]);
    await client.query('DELETE FROM client_reminders WHERE client_phone = ANY($1)', [variants]);
    await client.query('DELETE FROM clients WHERE phone = ANY($1)', [variants]);
    await client.query('COMMIT');
    notifyUpdate('client_deleted'); 
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/chats', async (req, res) => {
  try {
    const r = await pool.query(`SELECT c.*, l.status as lead_status, l.items_to_clean, l.location, l.address, l.estimated_value, l.advisor as lead_advisor, l.technical_images FROM conversations c LEFT JOIN leads l ON c.id = l.conversation_id ORDER BY c.last_message_time DESC`);
    // v5.2 Alcance por rol (JWT): antes este endpoint devolvía TODAS las
    // conversaciones a cualquier usuario logueado. Ahora: operador solo
    // las de los clientes de sus servicios asignados (B5); asesor solo
    // las suyas o sin asignar; líder las suyas, las de su red o sin
    // asignar; admin todas.
    const scope = await getRoleScope(req);
    let rows = r.rows;
    if (scope.role === 'operator') {
      const phones = new Set(await operatorServicePhones(scope.userName));
      rows = rows.filter((row) => phoneVariantsFor(row.client_phone).some((v) => phones.has(v)));
    } else if (scope.role === 'advisor') {
      const myName = (scope.userName || '').trim().toLowerCase();
      rows = rows.filter((row) => { const a = (row.lead_advisor || '').trim().toLowerCase(); return !a || a === 'sin asignar' || a === myName; });
    } else if (scope.role === 'sales_agent') {
      const names = new Set((scope.names || []).map((n) => n.trim().toLowerCase()));
      rows = rows.filter((row) => { const a = (row.lead_advisor || '').trim().toLowerCase(); return !a || a === 'sin asignar' || names.has(a); });
    }
    const chats = await Promise.all(rows.map(async (row) => {
      const msgs = await pool.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC', [row.id]);
      const tasks = await pool.query('SELECT COUNT(*) FROM tasks WHERE conversation_id = $1 AND completed = false', [row.id]);
      return { 
        id: row.id, 
        clientName: row.client_name, 
        clientPhone: row.client_phone, 
        source: row.source, 
        unreadCount: row.unread_count, 
        leadStatus: row.lead_status, 
        inboxName: row.inbox_name,
        pendingTasksCount: parseInt(tasks.rows[0].count), 
        leadData: { itemsToClean: row.items_to_clean, location: row.location, address: row.address, estimatedValue: Number(row.estimated_value), advisor: row.lead_advisor, technicalImages: row.technical_images || [] }, 
        messages: msgs.rows.map(m => ({ 
          id: m.id.toString(), 
          sender: m.sender, 
          content: m.content, 
          type: m.type, 
          attachmentUrl: m.attachment_url, 
          timestamp: new Date(m.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) 
        })) 
      };
    }));
    res.json(chats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads', async (req, res) => {
  const { search = '', status = 'all', startDate, endDate, location, source, minPrice, maxPrice, advisor } = req.query;
  const { page, limit, offset } = clampPagination(req.query);
  
  try {
    let params = [];
    params.push(`%${escapeLike(search)}%`);
    const namePh = `$${params.length}`;
    const phoneCond = likeAny(params, 'client_phone', phoneSearchPatterns(search));
    let whereClauses = [`(client_name ILIKE ${namePh} OR ${phoneCond})`];
    
    if (status !== 'all') {
      params.push(status);
      whereClauses.push(`status = $${params.length}`);
    }
    if (startDate) {
      params.push(startDate);
      whereClauses.push(`created_at >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      whereClauses.push(`created_at <= $${params.length}::timestamp + interval '1 day'`);
    }
    if (location && location !== 'all') {
      params.push(location);
      whereClauses.push(`location = $${params.length}`);
    }
    if (source && source !== 'all') {
      params.push(source);
      whereClauses.push(`source = $${params.length}`);
    }
    if (minPrice) {
      params.push(minPrice);
      whereClauses.push(`estimated_value >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(maxPrice);
      whereClauses.push(`estimated_value <= $${params.length}`);
    }

    // --- RESTRICCIÓN DE SEGURIDAD POR ROL v5.2: alcance del JWT ---
    const scope = await getRoleScope(req);
    if (scope.role === 'operator') {
      // El operador no tiene pipeline: solo los leads de los clientes de
      // sus servicios asignados (por teléfono, con variantes +57).
      const phones = await operatorServicePhones(scope.userName);
      if (phones.length) { params.push(phones); whereClauses.push(`client_phone = ANY($${params.length})`); }
      else whereClauses.push('1 = 0');
    } else if (scope.role !== 'admin') {
      applyRoleScopeClauses(scope, whereClauses, params);
    }
    // Filtro de la UI (asesor elegido en el pipeline): se SUMA al alcance
    // del JWT, nunca lo amplía. Antes, si un líder pasaba ?advisor=otro,
    // el filtro de equipo se saltaba y veía leads ajenos.
    if (advisor && advisor !== 'all') {
      params.push(advisor);
      whereClauses.push(`advisor = $${params.length}`);
    }

    const whereSql = " WHERE " + whereClauses.join(" AND ");
    
    const countQuery = `SELECT COUNT(*) FROM leads ${whereSql}`;
    const totalCount = await pool.query(countQuery, params);

    const query = `
      SELECT * FROM leads 
      ${whereSql}
      ORDER BY updated_at DESC 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);
    
    const r = await pool.query(query, params);
    res.json({
      data: r.rows.map(row => ({
        id: row.id.toString(),
        conversationId: row.conversation_id,
        clientName: row.client_name,
        clientPhone: row.client_phone,
        status: row.status,
        itemsToClean: row.items_to_clean, 
        location: row.location,
        address: row.address,
        estimatedValue: Number(row.estimated_value), 
        advisor: row.advisor,
        lostReason: row.lost_reason,
        assignedAt: row.assigned_at,
        technicalImages: row.technical_images || [],
        createdAt: row.created_at,
        source: row.source
      })),
      total: parseInt(totalCount.rows[0].count)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/update', async (req, res) => {
  // v5.2 El operador no cambia prospectos (solo lee sus mensajes).
  if (normalizeRoleValue(req.user?.role) === 'operator') {
    return res.status(403).json({ error: 'Solo lectura: los operadores no pueden modificar prospectos' });
  }
  // El frontend manda camelCase (conversationId, leadId, clientName,
  // technicalImages, itemsToClean, estimatedValue, lostReason); antes se
  // desestructuraba snake_case y el cuerpo usaba variables camelCase NO
  // declaradas (leadId, conversationId, ...) -> ReferenceError y 500
  // siempre. Se aceptan ambos formatos, con prioridad al camelCase.
  const b = req.body || {};
  const conversationId = b.conversationId ?? b.conversation_id ?? null;
  const leadId = b.leadId ?? b.id ?? null;
  const status = b.status ?? null;
  const clientName = b.clientName ?? b.client_name ?? null;
  const technicalImages = b.technicalImages ?? b.technical_images ?? null;
  const itemsToClean = b.itemsToClean ?? b.items_to_clean ?? null;
  const estimatedValue = b.estimatedValue ?? b.estimated_value ?? null;
  const address = b.address ?? null;
  const location = b.location ?? null;
  const advisor = b.advisor ?? null;
  const lostReason = b.lostReason ?? b.status_reason ?? b.statusReason ?? null;
  const source = b.source ?? null;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let finalLeadId = leadId;
      if (conversationId && !finalLeadId) {
        const check = await client.query('SELECT id FROM leads WHERE conversation_id = $1', [conversationId]);
        if (check.rows.length > 0) finalLeadId = check.rows[0].id;
      }
      
      let finalAdvisor = advisor;
      if (finalLeadId) {
        const currentLead = await client.query("SELECT advisor FROM leads WHERE id = $1", [finalLeadId]);
        if (!finalAdvisor) finalAdvisor = currentLead.rows[0]?.advisor;
        await client.query(`UPDATE leads SET status = COALESCE($1, status), client_name = COALESCE($2, client_name), technical_images = COALESCE($3, technical_images), items_to_clean = COALESCE($4, items_to_clean), estimated_value = COALESCE($5, estimated_value), address = COALESCE($6, address), location = COALESCE($7, location), advisor = COALESCE($8, advisor), lost_reason = COALESCE($9, lost_reason), source = COALESCE($10, source), updated_at = NOW() WHERE id = $11`, [status, clientName, technicalImages, itemsToClean, estimatedValue, address, location, finalAdvisor, lostReason, source, finalLeadId]);
      } else if (conversationId) {
        await client.query(`INSERT INTO leads (conversation_id, client_name, status, technical_images, items_to_clean, estimated_value, address, location, advisor, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [conversationId, clientName || 'Cliente Nuevo', status || 'NUEVO', technicalImages || [], itemsToClean, estimatedValue || 0, address, location, finalAdvisor, source]);
      }
      
      if (clientName && conversationId) {
        await client.query('UPDATE conversations SET client_name = $1 WHERE id = $2', [clientName, conversationId]);
      }
      await client.query('COMMIT');
      
      if (finalAdvisor) {
        const advId = await pool.query("SELECT id FROM employees WHERE name = $1", [finalAdvisor]);
        notifyUpdate('lead', advId.rows.map(r => r.id));
      } else {
        notifyUpdate('lead');
      }
      
      res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Borrar lead (lo usa Auditoría). Sin esto el borrado devolvía 404
// y fallaba en silencio. Solo admin y 404 si no existe.
app.delete('/api/leads/:id', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Lead no encontrado' });
    notifyUpdate('lead');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/staff', async (req, res) => {
  try {
    const r = await pool.query(`SELECT e.id, e.name, e.email, e.role, e.phone, e.commission_pct as "commissionPct", e.parent_id as "parentId", p.name as "parentName", e.is_online as "isOnline", e.last_assigned_at as "lastAssignedAt" FROM employees e LEFT JOIN employees p ON e.parent_id = p.id WHERE e.active = true ORDER BY e.role, e.name`);
    res.json(r.rows.map(row => ({ ...row, id: row.id.toString(), parentId: row.parentId ? row.parentId.toString() : undefined })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', requireAdminOrLeader, async (req, res) => {
  const { name, email, password, phone: rawPhone, active, commissionPct, parentId } = req.body;
  const role = normalizeRoleValue(req.body?.role);
  if (!role) return res.status(400).json({ error: "role inválido: debe ser 'admin', 'advisor', 'operator' o 'sales_agent'" });
  const phone = normalizePhoneString(rawPhone);
  if (!name || !email) return res.status(400).json({ error: 'Nombre y correo son obligatorios' });
  try {
    // Antes: sin contraseña se creaba el usuario con la clave por defecto
    // '123456', y al editar por email existente el upsert SIEMPRE reseteaba
    // la clave. Ahora: crear exige contraseña; editar sin contraseña deja
    // la clave existente intacta.
    const existing = await pool.query('SELECT id FROM employees WHERE email = $1', [email]);
    if (existing.rows.length === 0 && !password) {
      return res.status(400).json({ error: 'La contraseña es obligatoria al crear un empleado' });
    }
    let result;
    if (password) {
      const hashedPw = await bcrypt.hash(password, 10);
      const query = `INSERT INTO employees (name, email, password, role, phone, active, commission_pct, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password = EXCLUDED.password, role = EXCLUDED.role, phone = EXCLUDED.phone, active = EXCLUDED.active, commission_pct = EXCLUDED.commission_pct, parent_id = EXCLUDED.parent_id RETURNING id`;
      result = await pool.query(query, [name, email, hashedPw, role, phone, active ?? true, commissionPct || 0, parentId || null]);
    } else {
      const query = `INSERT INTO employees (name, email, role, phone, active, commission_pct, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, phone = EXCLUDED.phone, active = EXCLUDED.active, commission_pct = EXCLUDED.commission_pct, parent_id = EXCLUDED.parent_id RETURNING id`;
      result = await pool.query(query, [name, email, role, phone, active ?? true, commissionPct || 0, parentId || null]);
    }
    // v5 Parte 2C: el cambio de equipo queda en system_events.
    await recordEvent('info', 'staff', `Empleado ${name} (${email}) ${existing.rows.length ? 'actualizado' : 'creado'} por ${req.user?.email || 'admin'}`, { email, employee_id: result.rows[0].id });
    notifyUpdate('staff');
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', requireAdminOrLeader, async (req, res) => {
  const { id } = req.params;
  const { name, email, password, phone: rawPhone, active, commissionPct, parentId } = req.body;
  const role = normalizeRoleValue(req.body?.role);
  if (!role) return res.status(400).json({ error: "role inválido: debe ser 'admin', 'advisor', 'operator' o 'sales_agent'" });
  // Igual que en el POST: nombre y correo obligatorios.
  if (!name || !email) return res.status(400).json({ error: 'Nombre y correo son obligatorios' });
  const phone = normalizePhoneString(rawPhone);
  try {
    let query = 'UPDATE employees SET name=$1, email=$2, role=$3, phone=$4, active=$5, commission_pct=$6, parent_id=$7';
    let params = [name, email, role, phone, active ?? true, commissionPct || 0, parentId || null];
    if (password) { const hashedPw = await bcrypt.hash(password, 10); query += ', password=$8 WHERE id=$9'; params.push(hashedPw, id); }
    else { query += ' WHERE id=$8'; params.push(id); }
    const r = await pool.query(query, params);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    // v5 Parte 2C: el cambio de equipo queda en system_events.
    await recordEvent('info', 'staff', `Empleado ${name || id} actualizado por ${req.user?.email || 'admin'}`, { employee_id: id, email: email || null });
    notifyUpdate('staff');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/staff/:id', requireAdminOrLeader, async (req, res) => {
  try {
    const target = await pool.query('SELECT name, email FROM employees WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE employees SET active = false WHERE id = $1', [req.params.id]);
    // v5 Parte 2C: la desactivación queda en system_events.
    await recordEvent('warn', 'staff', `Empleado ${target.rows[0]?.name || req.params.id} desactivado por ${req.user?.email || 'admin'}`, { employee_id: req.params.id, email: target.rows[0]?.email || null });
    notifyUpdate('staff');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff/status', async (req, res) => {
  const { id, isOnline } = req.body;
  try {
    await pool.query('UPDATE employees SET is_online = $1 WHERE id = $2', [isOnline, id]);
    notifyUpdate('staff_status');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  // El login es público (sin JWT), así que comprueba la DB aquí mismo: antes
  // esta ruta hacía pool.query sin try/catch y un error de conexión tumbaba
  // todo el proceso.
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const { email, password } = req.body || {};
    // Sin email o password, bcrypt.compare(undefined, hash) y
    // role.toLowerCase() con null daban 500.
    if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
    // Bloqueo en memoria por correo+IP: 5 fallos en 10 min -> 429 durante
    // 15 min. Antes solo se alertaba, nunca se bloqueaba.
    const ip = req.ip || '';
    const blockKey = `${String(email).toLowerCase()}|${ip}`;
    const blockedUntil = loginBlocks.get(blockKey);
    if (blockedUntil && Date.now() < blockedUntil) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Inténtalo de nuevo en 15 minutos.' });
    }
    const r = await pool.query('SELECT * FROM employees WHERE email = $1 AND active = true', [email]);
    if (r.rows.length > 0 && await bcrypt.compare(password, r.rows[0].password)) {
      loginFailures.delete(blockKey);
      loginBlocks.delete(blockKey);
      const user = { id: r.rows[0].id.toString(), name: r.rows[0].name, role: (r.rows[0].role || 'operator').toLowerCase(), email: r.rows[0].email, isOnline: r.rows[0].is_online };
      const token = jwt.sign(user, jwtSecret, { expiresIn: '24h' });
      res.json({ success: true, user, token });
    } else {
      // Login fallido: queda registrado. 5 fallos en 10 min con el mismo
      // correo+IP = posible ataque de fuerza bruta (evento crítico +
      // alerta + bloqueo 15 min).
      const key = blockKey;
      const now = Date.now();
      const fails = (loginFailures.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
      fails.push(now);
      loginFailures.set(key, fails);
      if (fails.length >= 5) {
        loginBlocks.set(key, now + 15 * 60 * 1000);
        recordEvent('critical', 'auth', `Posible fuerza bruta: ${fails.length} intentos fallidos de login con ${email} en 10 min (bloqueado 15 min)`, { email });
        maybeAlert(`brute-${key}`, `🚨 Seguridad: ${fails.length} intentos fallidos de login con ${email} en 10 minutos.`);
      } else {
        recordEvent('warn', 'auth', `Login fallido con ${email}`, { email });
      }
      res.status(401).json({ error: 'Credenciales inválidas o cuenta desactivada' });
    }
  } catch (err) {
    logger.error('Error en login', err);
    res.status(500).json({ error: 'Error de base de datos' });
  }
});

app.get('/api/services', async (req, res) => {
  const { search = '', dealStatus = 'all', startDate, endDate, location, staff, payment } = req.query;
  const { page, limit, offset } = clampPagination(req.query);
  
  try {
    let params = [];
    params.push(`%${escapeLike(search)}%`);
    const namePh = `$${params.length}`;
    const phoneCond = likeAny(params, 'client_phone', phoneSearchPatterns(search));
    let whereClauses = [`(client_name ILIKE ${namePh} OR id::text ILIKE ${namePh} OR ${phoneCond})`];
    
    if (dealStatus !== 'all') {
      params.push(dealStatus);
      whereClauses.push(`deal_status = $${params.length}`);
    }

    if (startDate) {
      params.push(startDate);
      whereClauses.push(`date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      whereClauses.push(`date <= $${params.length}`);
    }
    if (location && location !== 'all') {
      params.push(location);
      whereClauses.push(`neighborhood = $${params.length}`);
    }
    if (staff && staff !== 'all') {
      params.push(staff);
      whereClauses.push(`($${params.length} = ANY(operators) OR advisor = $${params.length})`);
    }
    if (payment && payment !== 'all') {
      params.push(payment);
      whereClauses.push(`payment_method = $${params.length}`);
    }

    // --- RESTRICCIÓN DE SEGURIDAD POR ROL v5.2: alcance del JWT ---
    const scope = await getRoleScope(req);
    applyRoleScopeClauses(scope, whereClauses, params, { operatorsCol: 'operators' });
    if (scope.role === 'operator') whereClauses.push("deal_status NOT IN ('AGENDADO', 'REAGENDADO', 'CANCELADO')");

    const whereSql = " WHERE " + whereClauses.join(" AND ");
    
    const countQuery = `SELECT COUNT(*) FROM services ${whereSql}`;
    const totalCount = await pool.query(countQuery, params);

    const query = `
      SELECT * FROM services 
      ${whereSql}
      ORDER BY date DESC, time ASC 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);
    
    const r = await pool.query(query, params);
    res.json({
      data: r.rows.map(row => ({
        id: row.id.toString(),
        date: row.date ? row.date.toISOString().split('T')[0] : '',
        time: row.time,
        clientName: row.client_name,
        clientPhone: row.client_phone,
        city: row.city,
        neighborhood: row.neighborhood,
        address: row.address,
        advisor: row.advisor,
        operators: row.operators || [],
        itemsToClean: row.items_to_clean,
        servicePerformed: row.service_performed,
        observations: row.observations,
        initialValue: Number(row.initial_value),
        additionalItems: row.additional_items,
        additionalValue: Number(row.additional_value),
        totalValue: Number(row.total_value),
        paymentMethod: row.payment_method,
        expenses: Number(row.expenses),
        expensesNote: row.expenses_note,
        operatorPayment: Number(row.operator_payment),
        advances: Number(row.advances),
        netProfit: Number(row.net_profit),
        isWarranty: row.is_warranty,
        dealStatus: row.deal_status,
        technicalImages: row.technical_images || [],
        afterImages: row.after_images || [],
        clientSignature: row.client_signature || '',
        cancellationReason: row.cancellation_reason,
        rescheduleCount: row.reschedule_count,
        source: row.source,
        googleCalendarEventId: row.google_calendar_event_id || null,
        total: parseInt(totalCount.rows[0].count)
      })),
      total: parseInt(totalCount.rows[0].count)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/services', async (req, res) => {
  const s = req.body;
  // Validación mínima segura: montos negativos no tienen sentido y antes
  // se guardaban tal cual. (El recálculo completo de totales sigue siendo
  // un pendiente grande y NO se toca aquí.)
  const totalValueNum = Number(s.totalValue);
  const advancesNum = Number(s.advances);
  if ((Number.isFinite(totalValueNum) && totalValueNum < 0) || (Number.isFinite(advancesNum) && advancesNum < 0)) {
    return res.status(400).json({ error: 'total_value y advances no pueden ser negativos' });
  }
  // El teléfono del cliente se guarda normalizado (+57...) para que el
  // mismo cliente no se duplique con '300...' en un lado y '+57300...' en otro.
  const clientPhone = normalizePhoneString(s.clientPhone);
  try {
    const query = `
    INSERT INTO services (
      id, date, time, client_name, client_phone, city, neighborhood, address, advisor,
      operators, items_to_clean, service_performed, observations, initial_value, additional_items, additional_value, total_value,
      payment_method, expenses, expenses_note, operator_payment, advances, net_profit, is_warranty, deal_status, technical_images, after_images, client_signature, source, reschedule_count, cancellation_reason
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
    ON CONFLICT (id) DO UPDATE SET
      date=EXCLUDED.date, time=EXCLUDED.time, client_name=EXCLUDED.client_name, client_phone=EXCLUDED.client_phone,
      city=EXCLUDED.city, neighborhood=EXCLUDED.neighborhood, address=EXCLUDED.address, advisor=EXCLUDED.advisor,
      operators=EXCLUDED.operators, items_to_clean=EXCLUDED.items_to_clean, service_performed=EXCLUDED.service_performed, observations=EXCLUDED.observations, initial_value=EXCLUDED.initial_value,
      additional_items=EXCLUDED.additional_items, additional_value=EXCLUDED.additional_value,
      total_value=EXCLUDED.total_value, payment_method=EXCLUDED.payment_method,
      expenses=EXCLUDED.expenses, expenses_note=EXCLUDED.expenses_note, operator_payment=EXCLUDED.operator_payment, advances=EXCLUDED.advances, net_profit=EXCLUDED.net_profit, is_warranty=EXCLUDED.is_warranty,
      deal_status=EXCLUDED.deal_status,
      technical_images=EXCLUDED.technical_images, after_images=EXCLUDED.after_images, client_signature=EXCLUDED.client_signature,
      source=COALESCE(EXCLUDED.source, services.source),
      reschedule_count=EXCLUDED.reschedule_count, cancellation_reason=EXCLUDED.cancellation_reason
    RETURNING id`;
    const r = await pool.query(query, [
      s.id, s.date, s.time, s.clientName, clientPhone, s.city, s.neighborhood, s.address, s.advisor,
      s.operators, s.itemsToClean, s.servicePerformed || '', s.observations || '', s.initialValue, s.additionalItems, s.additionalValue, s.totalValue,
      s.paymentMethod, s.expenses || 0, s.expensesNote || '', s.operatorPayment || 0, s.advances || 0, s.netProfit || 0, s.isWarranty || false, s.dealStatus || 'AGENDADO',
      s.technicalImages || [], s.afterImages || [], s.clientSignature || '', s.source, s.rescheduleCount || 0, s.cancellationReason || null
    ]);

    const peopleInvolved = [s.advisor, ...(s.operators || [])];
    const idsRes = await pool.query("SELECT id FROM employees WHERE name = ANY($1)", [peopleInvolved]);
    notifyUpdate('service', idsRes.rows.map(r => r.id));

    // v5.3 Google Calendar: crear/actualizar el evento (o borrarlo si el
    // servicio se guardó como CANCELADO). Nunca rompe el guardado: si
    // Google falla, el servicio queda guardado y el error queda registrado.
    try {
      const rowRes = await pool.query('SELECT * FROM services WHERE id = $1', [r.rows[0].id]);
      const row = rowRes.rows[0];
      if (row) {
        if (row.deal_status === 'CANCELADO') {
          const del = await deleteServiceFromCalendar(row.id, row.google_calendar_event_id);
          if (del.ok && row.google_calendar_event_id) await pool.query('UPDATE services SET google_calendar_event_id = NULL WHERE id = $1', [row.id]);
        } else {
          await syncServiceToCalendar(row);
        }
      }
    } catch (e) { logger.warn(`Google Calendar (crear servicio ${r.rows[0].id}): ${e.message}`); }

    res.json({ id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/services/update-deal', async (req, res) => {
  const { id, status, reason, date, time } = req.body;
  // Lista cerrada de estados (DealStatus en types.ts): un estado inventado
  // antes se guardaba tal cual y rompía los filtros del frontend.
  const VALID_DEAL_STATUSES = ['AGENDADO', 'CONFIRMADO', 'REAGENDADO', 'REALIZADO', 'PAGADO', 'CANCELADO'];
  if (!id) return res.status(400).json({ error: 'id requerido' });
  if (!VALID_DEAL_STATUSES.includes(status)) return res.status(400).json({ error: `status inválido: debe ser uno de ${VALID_DEAL_STATUSES.join(', ')}` });
  // Reprogramar sin fecha/hora antes ponía date/time en NULL y el servicio
  // quedaba sin cuándo: ahora es 400.
  if (status === 'REAGENDADO' && (!date || !String(date).trim() || !time || !String(time).trim())) {
    return res.status(400).json({ error: 'Para reprogramar, date y time son obligatorios' });
  }
  try {
    const serviceInfo = await pool.query("SELECT advisor, operators, reschedule_count FROM services WHERE id = $1", [id]);
    
    // cancellation_reason solo se toca al CANCELAR: antes, cualquier cambio
    // de estado (p. ej. AGENDADO -> CONFIRMADO) borraba el motivo guardado.
    let query = 'UPDATE services SET deal_status = $1';
    let params = [status, id];
    if (status === 'CANCELADO') {
      query += ', cancellation_reason = $3 WHERE id = $2';
      params.push(reason || null);
    } else if (status === 'REAGENDADO') {
      const newCount = (serviceInfo.rows[0]?.reschedule_count || 0) + 1;
      // reason NO sobrescribe observations: antes cada reprogramación
      // borraba las observaciones del servicio con el motivo.
      query += ', date = $3, time = $4, reschedule_count = $5 WHERE id = $2';
      params.push(date, time, newCount);
    } else {
      query += ' WHERE id = $2';
    }

    const upd = await pool.query(query, params);
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    
    if (serviceInfo.rows[0]) {
      const people = [serviceInfo.rows[0].advisor, ...(serviceInfo.rows[0].operators || [])];
      const idsRes = await pool.query("SELECT id FROM employees WHERE name = ANY($1)", [people]);
      notifyUpdate('service_status', idsRes.rows.map(r => r.id));
    } else {
      notifyUpdate('service_status');
    }

    // v5.3 Google Calendar: reprogramar actualiza el evento; cancelar lo
    // borra. Cualquier otro cambio de estado sincroniza por si el evento
    // no existía (p. ej. Google se configuró después de crear el servicio).
    try {
      const rowRes = await pool.query('SELECT * FROM services WHERE id = $1', [id]);
      const row = rowRes.rows[0];
      if (row) {
        if (status === 'CANCELADO') {
          const del = await deleteServiceFromCalendar(row.id, row.google_calendar_event_id);
          if (del.ok && row.google_calendar_event_id) await pool.query('UPDATE services SET google_calendar_event_id = NULL WHERE id = $1', [row.id]);
        } else {
          await syncServiceToCalendar(row);
        }
      }
    } catch (e) { logger.warn(`Google Calendar (update-deal ${id}): ${e.message}`); }
    
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/services/:id', requireAdmin, async (req, res) => {
  try {
    // v5.3 Google Calendar: borrar el evento antes de borrar el servicio.
    let eventId = null;
    try {
      const rowRes = await pool.query('SELECT google_calendar_event_id FROM services WHERE id = $1', [req.params.id]);
      eventId = rowRes.rows[0]?.google_calendar_event_id || null;
    } catch { /* sin el id, simplemente se borra el servicio */ }
    const del = await pool.query('DELETE FROM services WHERE id = $1', [req.params.id]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (eventId) await deleteServiceFromCalendar(req.params.id, eventId);
    notifyUpdate('service_deleted');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- GOOGLE CALENDAR: ENDPOINTS v5.3 ----------
app.get('/api/system/google-calendar/status', requireAdmin, async (req, res) => {
  try { res.json(await googleCalendarStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Prueba real: crea un evento de 15 min "Prueba CRM — borrar" y lo borra
// de inmediato. Si llega el id del evento y se borra sin error, la
// conexión con Google funciona de verdad.
app.post('/api/system/google-calendar/test', requireAdmin, async (req, res) => {
  try {
    const { client, cfg, error } = await getGoogleCalendarClient();
    if (!client) return res.status(400).json({ ok: false, configured: false, error: error || cfg.reason });
    const now = new Date(Date.now() + 3600 * 1000);
    const end = new Date(now.getTime() + 15 * 60000);
    const created = await client.events.insert({
      calendarId: cfg.calendarId,
      requestBody: {
        summary: 'Prueba CRM — borrar',
        description: 'Evento de prueba del CRM Purifica (se borra solo). Si lo ves en tu calendario, la conexión funciona.',
        start: { dateTime: now.toISOString(), timeZone: 'America/Bogota' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Bogota' },
      },
    });
    const eventId = created.data.id;
    let deleted = false;
    try { await client.events.delete({ calendarId: cfg.calendarId, eventId }); deleted = true; } catch (e) { lastGoogleCalendarError = { at: new Date().toISOString(), message: e.message }; }
    await recordEvent('info', 'google-calendar', `Prueba de Google Calendar: evento ${eventId} creado${deleted ? ' y borrado' : ', pero NO se pudo borrar'}`, { calendarId: cfg.calendarId, eventId, deleted });
    res.json({ ok: true, configured: true, calendarId: cfg.calendarId, eventId, deleted, detail: deleted ? 'Evento de prueba creado y borrado correctamente.' : 'Evento creado, pero no se pudo borrarlo: revísalo en tu calendario y bórralo a mano.' });
  } catch (err) {
    lastGoogleCalendarError = { at: new Date().toISOString(), message: err.message };
    await recordEvent('error', 'google-calendar', `Prueba de Google Calendar falló: ${err.message}`, {});
    res.status(500).json({ ok: false, configured: true, error: err.message });
  }
});

// Reintenta la sincronización de un servicio (p. ej. si Google no estaba
// configurado cuando se creó, o si falló la primera vez).
app.post('/api/services/:id/sync-calendar', requireBilling, async (req, res) => {
  try {
    if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
    const rowRes = await pool.query('SELECT * FROM services WHERE id = $1', [req.params.id]);
    const row = rowRes.rows[0];
    if (!row) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (row.deal_status === 'CANCELADO') return res.status(400).json({ error: 'El servicio está cancelado: no se sincroniza con Google Calendar' });
    const result = await syncServiceToCalendar(row);
    if (!result.ok) return res.status(result.skipped ? 400 : 502).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- FACTURACIÓN Y COBROS v5 Parte 2A (Colombia) ----------
// Esto es facturación INTERNA con cobro por Wompi/PayU. NO es facturación
// electrónica DIAN: no hay envío a la DIAN ni CUFE. Los campos DIAN-ready
// (NIT empresa/cliente, régimen, resolución) y el export JSON existen para
// alimentar a un proveedor certificado (Siigo/Alegra). Ver README.
const INVOICE_STATUSES = ['pendiente', 'parcial', 'pagado', 'anulado'];

function formatInvoiceNumber(n) {
  return `FAC-${String(n).padStart(4, '0')}`;
}

async function getSettingValue(key, fallback = null) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return r.rows[0]?.value ?? fallback;
  } catch { return fallback; }
}

async function getCompanySettings() {
  const keys = ['company_nit', 'company_regime', 'dian_resolution_number', 'dian_resolution_range', 'dian_resolution_date'];
  const out = {};
  for (const k of keys) out[k] = await getSettingValue(k, '');
  try {
    const r = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'branding_%'");
    for (const row of r.rows) out[row.key] = row.value;
  } catch { /* sin branding aún */ }
  return out;
}

// v5.1 Tipos de factura válidos. 'normal' = factura de venta sin DIAN;
// 'electronica' = DIAN-ready (lista para el proveedor certificado).
const INVOICE_TYPES = ['normal', 'electronica'];

function mapInvoice(row) {
  return {
    id: row.id,
    number: row.number,
    type: INVOICE_TYPES.includes(row.type) ? row.type : 'normal',
    serviceId: row.service_id,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    clientNit: row.client_nit || '',
    subtotal: Number(row.subtotal),
    advances: Number(row.advances),
    total: Number(row.total),
    balance: Number(row.balance),
    status: row.status,
    paymentMethod: row.payment_method || '',
    paymentLink: row.payment_link || '',
    createdAt: row.created_at,
    serviceDate: row.service_date ? row.service_date.toISOString().split('T')[0] : null,
    servicePerformed: row.service_performed || '',
  };
}

async function getInvoicePayments(invoiceId) {
  const r = await pool.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC', [invoiceId]);
  return r.rows.map(p => ({
    id: p.id, invoiceId: p.invoice_id, amount: Number(p.amount),
    method: p.method || '', reference: p.reference || '', createdAt: p.created_at,
  }));
}

// Estado por lo PAGADO de verdad: abonos del servicio + pagos registrados
// en payments. Antes se calculaba solo con `advances` (estático): un abono
// parcial con advances=0 nunca marcaba 'parcial'. Un servicio con total 0
// sigue naciendo 'pagado', como antes (balance 0).
function invoiceStatusFor(total, paidSoFar) {
  const t = Number(total) || 0;
  const p = Number(paidSoFar) || 0;
  if (t <= 0) return 'pagado';
  if (p >= t) return 'pagado';
  if (p > 0) return 'parcial';
  return 'pendiente';
}

// Alcance por rol para facturas (v5.3): la factura pertenece al asesor del
// servicio. Admin: todo; asesor/líder: servicios de su red; operador:
// servicios asignados a él.
function invoiceInScope(scope, advisor, operators) {
  if (!scope || scope.role === 'admin') return true;
  if (scope.role === 'operator') return (operators || []).includes(scope.userName);
  return (scope.names || []).includes(advisor);
}

// Reserva el siguiente número de factura (FAC-XXXX) dentro de una
// transacción con bloqueo de fila, para que dos facturas no repitan número.
async function allocateInvoiceNumber(client) {
  const r = await client.query("SELECT value FROM settings WHERE key = 'invoice_next_number' FOR UPDATE");
  const next = parseInt(r.rows[0]?.value || '1', 10) || 1;
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('invoice_next_number', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [String(next + 1)]
  );
  return formatInvoiceNumber(next);
}

app.get('/api/invoices', requireBilling, async (req, res) => {
  try {
    const { status, service_id, type } = req.query;
    const clauses = [];
    const params = [];
    if (status && INVOICE_STATUSES.includes(status)) { params.push(status); clauses.push(`i.status = $${params.length}`); }
    if (type && INVOICE_TYPES.includes(type)) { params.push(type); clauses.push(`i.type = $${params.length}`); }
    if (service_id) { params.push(service_id); clauses.push(`i.service_id = $${params.length}`); }
    // v5.3 Alcance por rol: sin esto un asesor veía/cobraba facturas
    // ajenas. La factura pertenece al asesor del servicio (el líder ve
    // su red; el operador, sus servicios asignados).
    const scope = await getRoleScope(req);
    if (scope.role === 'operator') {
      params.push(scope.userName);
      clauses.push(`i.service_id IN (SELECT id FROM services WHERE $${params.length} = ANY(operators))`);
    } else if (scope.role !== 'admin') {
      params.push(scope.names);
      clauses.push(`i.service_id IN (SELECT id FROM services WHERE advisor = ANY($${params.length}))`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT i.*, s.date AS service_date, s.service_performed FROM invoices i
       LEFT JOIN services s ON s.id = i.service_id ${where} ORDER BY i.id DESC`,
      params
    );
    res.json(r.rows.map(mapInvoice));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices/:id', requireBilling, async (req, res) => {
  try {
    const scope = await getRoleScope(req);
    const scopeParams = [];
    let scopeClause = '';
    if (scope.role === 'operator') {
      scopeParams.push(scope.userName);
      scopeClause = ` AND i.service_id IN (SELECT id FROM services WHERE $${scopeParams.length + 1} = ANY(operators))`;
    } else if (scope.role !== 'admin') {
      scopeParams.push(scope.names);
      scopeClause = ` AND i.service_id IN (SELECT id FROM services WHERE advisor = ANY($${scopeParams.length + 1}))`;
    }
    const r = await pool.query(
      `SELECT i.*, s.date AS service_date, s.service_performed FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1${scopeClause}`,
      [req.params.id, ...scopeParams]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    const invoice = mapInvoice(r.rows[0]);
    invoice.payments = await getInvoicePayments(invoice.id);
    res.json(invoice);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices', requireBilling, async (req, res) => {
  const { service_id, client_nit, type } = req.body || {};
  if (!service_id) return res.status(400).json({ error: 'service_id requerido' });
  // v5.1 Tipo de factura: si viene, se valida; si no, se usa el tipo por
  // defecto de settings (invoice_default_type, 'normal' si no está).
  let invoiceType = 'normal';
  if (type !== undefined && type !== null && type !== '') {
    if (!INVOICE_TYPES.includes(type)) return res.status(400).json({ error: "type debe ser 'normal' o 'electronica'" });
    invoiceType = type;
  } else {
    const def = await getSettingValue('invoice_default_type', 'normal');
    invoiceType = INVOICE_TYPES.includes(def) ? def : 'normal';
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const svc = await client.query(
      'SELECT id, client_name, client_phone, total_value, advances FROM services WHERE id = $1',
      [service_id]
    );
    if (!svc.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Servicio no encontrado' }); }
    const existing = await client.query('SELECT id FROM invoices WHERE service_id = $1 ORDER BY id ASC LIMIT 1', [service_id]);
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      const r = await pool.query('SELECT i.*, s.date AS service_date, s.service_performed FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1', [existing.rows[0].id]);
      return res.json({ ...mapInvoice(r.rows[0]), already_exists: true });
    }
    const s = svc.rows[0];
    const subtotal = Number(s.total_value) || 0;
    const advances = Math.min(Number(s.advances) || 0, subtotal);
    const balance = Math.max(0, subtotal - advances);
    const status = invoiceStatusFor(subtotal, advances);
    const number = await allocateInvoiceNumber(client);
    const ins = await client.query(
      `INSERT INTO invoices (number, type, service_id, client_name, client_phone, client_nit, subtotal, advances, total, balance, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [number, invoiceType, s.id, s.client_name, s.client_phone, (client_nit || '').trim() || null, subtotal, advances, subtotal, balance, status]
    );
    await client.query('COMMIT');
    await recordEvent('info', 'invoices', `Factura ${number} (${invoiceType === 'electronica' ? 'electrónica' : 'normal'}) creada desde servicio ${s.id} (${status}, saldo ${balance})`, { invoice: number, type: invoiceType, service_id: s.id });
    notifyUpdate('invoice');
    res.status(201).json(mapInvoice(ins.rows[0]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    // Carrera: otra petición creó la factura entre el chequeo de existente
    // y el INSERT (el índice único idx_invoices_service_unique lo impidió).
    // Se devuelve la existente en vez de un 500.
    if (err?.code === '23505') {
      try {
        const ex = await pool.query('SELECT i.*, s.date AS service_date, s.service_performed FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.service_id = $1 ORDER BY i.id ASC LIMIT 1', [service_id]);
        if (ex.rows[0]) return res.json({ ...mapInvoice(ex.rows[0]), already_exists: true });
      } catch { /* cae al 500 de abajo */ }
    }
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/invoices/:id/payments', requireBilling, async (req, res) => {
  const { amount, method, reference } = req.body || {};
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que 0' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query('SELECT i.*, s.advisor, s.operators FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1 FOR UPDATE', [req.params.id]);
    if (!inv.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Factura no encontrada' }); }
    const row = inv.rows[0];
    // v5.3 Alcance por rol: un asesor solo cobra sus facturas.
    const scope = await getRoleScope(req);
    if (!invoiceInScope(scope, row.advisor, row.operators)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Factura no encontrada' }); }
    if (row.status === 'anulado') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La factura está anulada' }); }
    if (row.status === 'pagado') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La factura ya está pagada' }); }
    const paid = Math.min(value, Number(row.balance));
    await client.query(
      'INSERT INTO payments (invoice_id, amount, method, reference) VALUES ($1, $2, $3, $4)',
      [row.id, paid, (method || '').trim() || null, (reference || '').trim() || null]
    );
    const newBalance = Math.max(0, Number(row.balance) - paid);
    // Estado por lo pagado de verdad (abonos + todos los pagos): antes se
    // calculaba solo con advances y un abono parcial con advances=0 nunca
    // marcaba 'parcial'.
    const paidSum = await client.query('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = $1', [row.id]);
    const paidTotal = Number(row.advances) + Number(paidSum.rows[0].s);
    const status = invoiceStatusFor(Number(row.total), paidTotal);
    const upd = await client.query(
      'UPDATE invoices SET balance = $1, status = $2, payment_method = COALESCE($3, payment_method) WHERE id = $4 RETURNING *',
      [newBalance, status, (method || '').trim() || null, row.id]
    );
    await client.query('COMMIT');
    await recordEvent('info', 'invoices', `Pago manual de ${paid} en ${row.number} (saldo ${newBalance}, ${status})`, { invoice: row.number, amount: paid, method: method || null });
    notifyUpdate('invoice');
    // El recorte con Math.min ya no es silencioso: la respuesta dice el
    // monto realmente aplicado (paid) y avisa si se pidió más que el saldo.
    res.json({
      ...mapInvoice(upd.rows[0]),
      paid,
      ...(value > Number(row.balance) ? { warning: `Se aplicaron ${paid} de los ${value} solicitados: el saldo de la factura era ${Number(row.balance)}` } : {}),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/invoices/:id/cancel', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!cur.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Factura no encontrada' }); }
    // Una factura pagada no se anula sin más: anularla dejaría los pagos
    // huérfanos sin reversar nada. Primero hay que reversar el pago.
    if (cur.rows[0].status === 'pagado') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No se puede anular una factura pagada: primero revierte sus pagos' }); }
    if (cur.rows[0].status === 'anulado') { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Factura no encontrada o ya anulada' }); }
    const r = await client.query("UPDATE invoices SET status = 'anulado' WHERE id = $1 RETURNING *", [req.params.id]);
    await client.query('COMMIT');
    await recordEvent('warn', 'invoices', `Factura ${r.rows[0].number} anulada por ${req.user?.email || 'admin'}`, { invoice: r.rows[0].number });
    notifyUpdate('invoice');
    res.json(mapInvoice(r.rows[0]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Export DIAN-ready: JSON con todos los campos que un proveedor certificado
// (Siigo, Alegra, etc.) pide para emitir la factura electrónica. Esto NO
// emite nada ante la DIAN; es solo el insumo para ese proveedor.
app.get('/api/invoices/:id/export', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT i.*, s.date AS service_date, s.service_performed, s.address, s.city, s.neighborhood FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1',
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    const inv = mapInvoice(r.rows[0]);
    // v5.1 Decisión: la exportación DIAN solo aplica a facturas
    // electrónicas. Una factura normal no tiene nada que exportar a la
    // DIAN, así que se rechaza con un 400 claro en vez de devolver un
    // JSON con campos DIAN vacíos que podrían confundir.
    if (inv.type !== 'electronica') {
      return res.status(400).json({ error: 'Esta factura es normal (sin DIAN) y no tiene exportación DIAN. Solo las facturas electrónicas se exportan para el proveedor certificado.' });
    }
    inv.payments = await getInvoicePayments(inv.id);
    const company = await getCompanySettings();
    res.json({
      nota: 'Datos listos para un proveedor de facturación electrónica certificado (Siigo/Alegra). Este JSON NO es una factura electrónica ni se envió a la DIAN.',
      empresa: {
        nombre: company.branding_company_name || 'Purifica Tu Ambiente',
        nit: company.company_nit || null,
        regimen: company.company_regime || null,
        resolucion_facturacion: {
          numero: company.dian_resolution_number || null,
          rango: company.dian_resolution_range || null,
          fecha: company.dian_resolution_date || null,
        },
      },
      factura: {
        numero_interno: inv.number, tipo: inv.type, fecha: inv.createdAt, estado: inv.status,
        cliente: { nombre: inv.clientName, telefono: inv.clientPhone, nit: inv.clientNit || null },
        servicio: { id: inv.serviceId, fecha: inv.serviceDate, descripcion: inv.servicePerformed || '', direccion: r.rows[0].address || '', ciudad: r.rows[0].city || '', barrio: r.rows[0].neighborhood || '' },
        subtotal: inv.subtotal, abonos: inv.advances, total: inv.total, saldo: inv.balance,
        moneda: 'COP', medio_pago: inv.paymentMethod || null, link_pago: inv.paymentLink || null,
      },
      pagos: inv.payments,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- LINKS DE PAGO (Wompi / PayU) ----------
app.post('/api/invoices/:id/payment-link', requireBilling, async (req, res) => {
  const { provider } = req.body || {};
  try {
    const r = await pool.query('SELECT i.*, s.advisor, s.operators FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    const inv = r.rows[0];
    // v5.3 Alcance por rol: un asesor solo genera links de sus facturas.
    const scope = await getRoleScope(req);
    if (!invoiceInScope(scope, inv.advisor, inv.operators)) return res.status(404).json({ error: 'Factura no encontrada' });
    if (inv.status === 'anulado') return res.status(400).json({ error: 'La factura está anulada' });
    if (inv.status === 'pagado' || Number(inv.balance) <= 0) return res.status(400).json({ error: 'La factura ya está pagada' });
    const amount = Number(inv.balance);
    let url = null;

    if (provider === 'wompi') {
      const publicKey = (process.env.WOMPI_PUBLIC_KEY || '').trim();
      if (!publicKey) return res.status(400).json({ error: 'Pasarela no configurada: falta WOMPI_PUBLIC_KEY en el .env' });
      // Link de pago Wompi (checkout): public-key, currency COP, monto en
      // centavos y referencia = número de factura. Ver docs de Wompi
      // "Links de pago". redirect-url solo si se configuró WOMPI_REDIRECT_URL.
      const params = new URLSearchParams({
        'public-key': publicKey,
        currency: 'COP',
        'amount-in-cents': String(Math.round(amount * 100)),
        reference: inv.number,
      });
      const redirectUrl = (process.env.WOMPI_REDIRECT_URL || '').trim();
      if (redirectUrl) params.set('redirect-url', redirectUrl);
      url = `https://checkout.wompi.co/p/?${params.toString()}`;
    } else if (provider === 'payu') {
      const merchantId = (process.env.PAYU_MERCHANT_ID || '').trim();
      const apiKey = (process.env.PAYU_API_KEY || '').trim();
      const accountId = (process.env.PAYU_ACCOUNT_ID || '').trim();
      if (!merchantId || !apiKey || !accountId) return res.status(400).json({ error: 'Pasarela no configurada: faltan PAYU_MERCHANT_ID, PAYU_API_KEY o PAYU_ACCOUNT_ID en el .env' });
      // Firma PayU (WebCheckout Colombia): MD5(apiKey~merchantId~referenceCode~amount~currency).
      // El monto va con 2 decimales, igual en la firma y en el parámetro.
      const amountStr = amount.toFixed(2);
      const signature = crypto.createHash('md5').update(`${apiKey}~${merchantId}~${inv.number}~${amountStr}~COP`).digest('hex');
      const params = new URLSearchParams({
        merchantId, accountId,
        description: `Pago factura ${inv.number} - Purifica Tu Ambiente`,
        referenceCode: inv.number,
        amount: amountStr, tax: '0', taxReturnBase: '0', currency: 'COP',
        signature, test: '0',
      });
      const responseUrl = (process.env.PAYU_RESPONSE_URL || '').trim();
      const confirmationUrl = (process.env.PAYU_CONFIRMATION_URL || '').trim();
      if (responseUrl) params.set('responseUrl', responseUrl);
      if (confirmationUrl) params.set('confirmationUrl', confirmationUrl);
      url = `https://checkout.payulatam.com/ppp-web-gateway-payu/?${params.toString()}`;
    } else {
      return res.status(400).json({ error: "provider debe ser 'wompi' o 'payu'" });
    }

    const upd = await pool.query('UPDATE invoices SET payment_link = $1 WHERE id = $2 RETURNING *', [url, inv.id]);
    await recordEvent('info', 'invoices', `Link de pago ${provider} generado para ${inv.number} (${amount} COP)`, { invoice: inv.number, provider });
    notifyUpdate('invoice');
    res.json({ ...mapInvoice(upd.rows[0]), payment_url: url, provider });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- WEBHOOKS DE PASARELAS (públicos, verificados por firma) ----------
// Aplica un pago de pasarela (Wompi/PayU) a una factura: transaccional e
// idempotente por transaction_id. Antes el INSERT del pago y el UPDATE de la
// factura iban sueltos (si fallaba el segundo, el pago quedaba sin reflejar
// en el saldo) y un pago parcial marcaba la factura 'pagado' con balance 0
// porque el UPDATE era incondicional. Ahora: newBalance = balance -
// paidAmount y el estado sale de invoiceStatusFor(total, pagado acumulado),
// así que un parcial marca 'parcial' y solo el pago completo marca 'pagado'.
// Si ya existe un pago con ese transaction_id, no se inserta de nuevo.
async function applyGatewayPayment({ invoiceNumber, paidAmount, method, transactionId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query("SELECT * FROM invoices WHERE number = $1 AND status <> 'anulado' FOR UPDATE", [invoiceNumber]);
    if (!inv.rows[0]) { await client.query('ROLLBACK'); return { ok: false, note: 'Factura no encontrada en el CRM' }; }
    const row = inv.rows[0];
    if (row.status === 'pagado') { await client.query('ROLLBACK'); return { ok: true, alreadyPaid: true, note: 'Factura ya estaba pagada', invoice: row.number, status: 'pagado' }; }
    const txRef = transactionId ? String(transactionId) : null;
    if (txRef) {
      const dup = await client.query('SELECT 1 FROM payments WHERE invoice_id = $1 AND reference = $2 AND method = $3', [row.id, txRef, method]);
      if (dup.rows.length) { await client.query('ROLLBACK'); return { ok: true, duplicate: true, note: 'Pago ya registrado (transaction_id duplicado)', invoice: row.number }; }
    }
    const paid = Math.min(paidAmount, Number(row.balance));
    await client.query('INSERT INTO payments (invoice_id, amount, method, reference) VALUES ($1, $2, $3, $4)', [row.id, paid, method, txRef]);
    const sumRes = await client.query('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = $1', [row.id]);
    const paidTotal = Number(row.advances) + Number(sumRes.rows[0].s);
    const newBalance = Math.max(0, Number(row.balance) - paid);
    const status = invoiceStatusFor(Number(row.total), paidTotal);
    await client.query('UPDATE invoices SET balance = $1, status = $2, payment_method = $3 WHERE id = $4', [newBalance, status, method, row.id]);
    await client.query('COMMIT');
    await recordEvent('info', 'invoices', `Factura ${row.number} ${status === 'pagado' ? 'pagada' : 'con abono parcial'} por webhook ${method} (${paid} COP, saldo ${newBalance})`, { invoice: row.number, transaction_id: txRef });
    notifyUpdate('invoice');
    return { ok: true, invoice: row.number, status, paid, balance: newBalance };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw e;
  } finally { client.release(); }
}

// Wompi: el evento trae data.transaction {id, status, amount_in_cents,
// reference} y signature.checksum = SHA256(id + status + amount_in_cents +
// secreto de eventos). El secreto es WOMPI_EVENTS_SECRET (del panel de
// Wompi, "Secreto de eventos"); si no está, se acepta WOMPI_PRIVATE_KEY
// como respaldo. SIN secreto configurado el evento se registra pero NO se
// marca nada como pagado (no se puede verificar que venga de Wompi).
app.post('/api/webhooks/wompi', async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const tx = req.body?.data?.transaction;
    const checksum = req.body?.signature?.checksum;
    if (!tx?.id || !tx?.reference) return res.status(400).json({ error: 'Evento Wompi sin transacción' });
    const secret = (process.env.WOMPI_EVENTS_SECRET || process.env.WOMPI_PRIVATE_KEY || '').trim();
    let verified = false;
    if (secret && checksum) {
      const expected = crypto.createHash('sha256').update(`${tx.id}${tx.status}${tx.amount_in_cents}${secret}`).digest('hex');
      const given = String(checksum).toLowerCase();
      verified = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    }
    await recordEvent(verified ? 'info' : 'warn', 'invoices',
      `Webhook Wompi ${tx.status} ref ${tx.reference} (firma ${verified ? 'verificada' : 'NO verificada'})`,
      { transaction_id: tx.id, status: tx.status, reference: tx.reference, verified });
    if (!verified) return res.json({ ok: true, verified: false, note: 'Firma no verificada: evento registrado pero la factura NO se marcó como pagada' });
    if (tx.status !== 'APPROVED') return res.json({ ok: true, verified: true, note: `Estado ${tx.status}: no se marca pagado` });
    // amount_in_cents ausente o no numérico daba NaN y se insertaba un pago
    // NaN: se rechaza el evento antes de tocar la factura.
    const cents = Number(tx.amount_in_cents);
    if (!Number.isFinite(cents) || cents < 0) return res.json({ ok: true, verified: true, note: 'Monto del evento inválido (amount_in_cents ausente o no numérico): no se marcó pagado' });
    const result = await applyGatewayPayment({ invoiceNumber: tx.reference, paidAmount: cents / 100, method: 'Wompi', transactionId: tx.id });
    res.json({ ok: true, verified: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PayU: la confirmación trae merchant_id, reference_sale, value, currency,
// state_pol (4 = aprobado) y sign = MD5(apiKey~merchant_id~reference_sale~
// value~currency~state_pol), con value a 1 decimal. Sin PAYU_API_KEY no se
// puede verificar la firma: se registra el evento pero NO se marca pagado.
app.post('/api/webhooks/payu', async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const b = req.body || {};
    const reference = b.reference_sale;
    if (!reference) return res.status(400).json({ error: 'Confirmación PayU sin reference_sale' });
    const apiKey = (process.env.PAYU_API_KEY || '').trim();
    let verified = false;
    if (apiKey && b.sign) {
      const value1 = Number(b.value || 0).toFixed(1);
      const expected = crypto.createHash('md5')
        .update(`${apiKey}~${b.merchant_id}~${reference}~${value1}~${b.currency}~${b.state_pol}`)
        .digest('hex');
      verified = String(b.sign).toLowerCase() === expected;
    }
    await recordEvent(verified ? 'info' : 'warn', 'invoices',
      `Webhook PayU state_pol ${b.state_pol} ref ${reference} (firma ${verified ? 'verificada' : 'NO verificada'})`,
      { reference_sale: reference, state_pol: b.state_pol, verified });
    if (!verified) return res.json({ ok: true, verified: false, note: 'Firma no verificada: evento registrado pero la factura NO se marcó como pagada' });
    if (String(b.state_pol) !== '4') return res.json({ ok: true, verified: true, note: `state_pol ${b.state_pol}: no es aprobado, no se marca pagado` });
    // value ausente o no numérico daba NaN y se insertaba un pago NaN.
    const valueNum = Number(b.value);
    if (!Number.isFinite(valueNum) || valueNum < 0) return res.json({ ok: true, verified: true, note: 'Monto de la confirmación inválido (value ausente o no numérico): no se marcó pagado' });
    const result = await applyGatewayPayment({ invoiceNumber: reference, paidAmount: valueNum, method: 'PayU', transactionId: b.transaction_id || null });
    res.json({ ok: true, verified: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Endpoints /api/tasks/* eliminados en v4: ningún componente del frontend
// los llamaba (las tareas solo se cuentan en GET /api/chats con
// pendingTasksCount, y la tabla tasks sigue existiendo para eso).
app.get('/api/templates', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM templates ORDER BY id ASC'); res.json(r.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/templates', async (req, res) => {
  try {
    const { id, title, content } = req.body;
    if (id) { await pool.query('UPDATE templates SET title=$1, content=$2 WHERE id=$3', [title, content, id]); }
    else { await pool.query('INSERT INTO templates (title, content) VALUES ($1, $2)', [title, content]); }
    notifyUpdate('template');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/templates/:id', async (req, res) => {
  try { await pool.query('DELETE FROM templates WHERE id=$1', [req.params.id]); notifyUpdate('template'); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM settings');
    const s = {}; r.rows.forEach(row => s[row.key] = row.value);
    // El token de Meta NUNCA se devuelve al frontend (ni siquiera enmascarado:
    // no sale la clave). El frontend sabe si existe por GET /api/wa/meta/status.
    delete s['meta_wa_token'];
    // v5.3 Lo mismo con el refresh token de Google Calendar: es una
    // credencial, nunca sale al frontend. El estado se consulta por
    // GET /api/system/google-calendar/status (solo admin). El client secret
    // de Google tampoco sale, por si alguna vez se guardara en settings
    // (hoy solo vive en .env).
    delete s['google_refresh_token'];
    delete s['google_client_secret'];
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    // Sin allow-list cualquier clave (incluidas branding_* o last_backup) se
    // podía pisar desde el frontend. Solo las que el frontend usa de verdad.
    // v5 Facturación/DIAN-ready: NIT y régimen de la empresa y datos de la
    // resolución de facturación. invoice_next_number NO está aquí a propósito:
    // el consecutivo solo lo mueve la creación de facturas, no un formulario.
    // v5 Parte 2B Meta: token y phone number id de WhatsApp Cloud API.
    const ALLOWED_SETTINGS_KEYS = ['reassignment_timeout', 'daily_capacity', 'company_nit', 'company_regime', 'dian_resolution_number', 'dian_resolution_range', 'dian_resolution_date', 'meta_wa_token', 'meta_wa_phone_number_id', 'invoice_default_type', 'google_refresh_token', 'google_calendar_id', 'google_calendar_duration_minutes', 'google_calendar_enabled'];
    if (!ALLOWED_SETTINGS_KEYS.includes(key)) return res.status(400).json({ error: `Clave no permitida: ${key}` });
    // Las claves de Meta son credenciales: solo el admin las escribe.
    if (key.startsWith('meta_wa_') && (req.user?.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }
    // v5.2 Facturación (B6): el tipo de factura por defecto y los datos de
    // la empresa para facturar son solo admin, aunque el asesor (vendedor)
    // ya puede crear facturas y cobrar.
    const ADMIN_ONLY_SETTINGS = new Set(['invoice_default_type', 'company_nit', 'company_regime', 'dian_resolution_number', 'dian_resolution_range', 'dian_resolution_date', 'google_refresh_token', 'google_calendar_id', 'google_calendar_duration_minutes', 'google_calendar_enabled']);
    if (ADMIN_ONLY_SETTINGS.has(key) && normalizeRoleValue(req.user?.role) !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede cambiar esa configuración' });
    }
    if (key === 'meta_wa_phone_number_id' && value && !/^\d+$/.test(String(value).trim())) {
      return res.status(400).json({ error: 'El phone number id de Meta debe ser solo dígitos' });
    }
    // v5.1 El tipo de factura por defecto solo admite los dos tipos válidos.
    if (key === 'invoice_default_type' && value && !INVOICE_TYPES.includes(String(value).trim())) {
      return res.status(400).json({ error: "invoice_default_type debe ser 'normal' o 'electronica'" });
    }
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    notifyUpdate('settings');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- MARCA BLANCA ----------
// Se guarda en la tabla settings (key/value) con claves branding_*.
const BRANDING_DEFAULTS = {
  company_name: 'Purifica Tu Ambiente',
  tagline: 'Sistema Integrado de Gestión CRM',
  logo_url: '',
  primary_color: '#0284c7',
  secondary_color: '#0ea5e9',
};
const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

app.get('/api/settings/branding', async (req, res) => {
  try {
    const r = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'branding_%'");
    const out = { ...BRANDING_DEFAULTS };
    r.rows.forEach((row) => { out[row.key.replace('branding_', '')] = row.value; });
    res.json(out);
  } catch (err) {
    // Sin DB: devolver los valores por defecto para que el login se vea bien.
    res.json({ ...BRANDING_DEFAULTS });
  }
});

app.put('/api/settings/branding', requireAdmin, async (req, res) => {
  const { company_name, tagline, primary_color, secondary_color } = req.body || {};
  if (primary_color && !isHexColor(primary_color)) return res.status(400).json({ error: 'primary_color debe ser hexadecimal (#RRGGBB)' });
  if (secondary_color && !isHexColor(secondary_color)) return res.status(400).json({ error: 'secondary_color debe ser hexadecimal (#RRGGBB)' });
  const values = { company_name, tagline, primary_color, secondary_color };
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`branding_${k}`, String(v)]);
    }
    notifyUpdate('settings');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
app.post('/api/settings/logo', requireAdmin, logoUpload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sube un archivo de imagen' });
  if (!['image/png', 'image/jpeg'].includes(req.file.mimetype)) return res.status(400).json({ error: 'Solo PNG o JPG' });
  const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  try {
    for (const old of ['logo.png', 'logo.jpg']) {
      const p = path.join(uploadsDir(), old);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.writeFileSync(path.join(uploadsDir(), `logo.${ext}`), req.file.buffer);
    const logoUrl = `/uploads/logo.${ext}`;
    await pool.query("INSERT INTO settings (key, value) VALUES ('branding_logo_url', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [logoUrl]);
    notifyUpdate('settings');
    res.json({ success: true, logo_url: logoUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /api desconocida -> JSON 404 (antes devolvía el index.html del SPA).
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint no encontrado' }));
// Archivos sensibles: nunca servir el código fuente ni la configuración.
app.get(['/server.js', '/package.json', '/package-lock.json', '/.env', '/.env.example', '/Dockerfile', '/docker-compose.yml', '/vite.config.ts', '/tsconfig.json', '/.dockerignore'], (req, res) => res.status(404).send('Not found'));

app.use(express.static(path.join(__dirname, 'dist')));

// Middleware de Manejo de Errores Centralizado
app.use((err, req, res, next) => {
  logger.error(`Error en ${req.method} ${req.path}`, err);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
    timestamp: new Date().toISOString()
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

server.listen(PORT, () => {
  console.log(`🚀 Purifica CRM Real-Time ON :${PORT}`);

  // v5.3.2: las instancias guardadas se restauran al final de initDB
  // (restoreWhatsAppInstances), no aquí: así solo se levantan cuando la
  // DB ya está lista y con su canal guardado.
});
