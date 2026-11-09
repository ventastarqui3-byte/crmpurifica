// Estado del Sistema (solo administradores).
// Semáforos por componente, autoprueba, últimos eventos, reconexión de
// WhatsApp y respaldo. Si algo se rompe, aquí se ve sin entrar a los logs.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Play,
  Database, Smartphone, Server, MessagesSquare, HardDrive, Bell,
  Loader2, RotateCcw, Download, Send, CalendarDays, Eraser,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { SystemComponentStatus, SystemEvent, SelfTestResult } from '../types';

type Status = 'green' | 'yellow' | 'red';

const DOT: Record<Status, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
};
const LABEL: Record<Status, string> = {
  green: 'Bien',
  yellow: 'Atención',
  red: 'Roto',
};
const BADGE: Record<Status, string> = {
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  yellow: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-red-50 text-red-700 border-red-200',
};
const ICONS: Record<string, any> = {
  db: Database,
  whatsapp: Smartphone,
  server: Server,
  queue: MessagesSquare,
  backup: HardDrive,
  'google-calendar': CalendarDays,
};

interface StatusData {
  version: string;
  uptime_seconds: number;
  alerts: { telegramConfigured: boolean; emailConfigured: boolean };
  // v5.3.16 Desglose de almacenamiento del volumen (sesión WhatsApp vs
  // fotos subidas vs total del volumen). volumeMB puede ser null si no se
  // pudo medir.
  storage?: { sessionMB: number; uploadsMB: number; volumeMB: { freeMB: number; totalMB: number; usedPercent?: number | null } | null };
  components: SystemComponentStatus[];
  criticalEvents: SystemEvent[];
}

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
}

export const SystemStatus: React.FC = () => {
  const [data, setData] = useState<StatusData | null>(null);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [levelFilter, setLevelFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [tests, setTests] = useState<SelfTestResult[] | null>(null);
  const [testSummary, setTestSummary] = useState('');
  // v5.3.15 Formularios de integraciones (Google Calendar y Telegram).
  // Los secretos NUNCA se traen del servidor: los campos empiezan vacíos y
  // los vacíos no se envían al guardar (lo guardado se conserva). Los campos
  // no secretos de Google (calendario, duración, habilitado) se rellenan UNA
  // vez con lo que devuelve GET /api/settings (que ya borra los secretos).
  const [gcalClientId, setGcalClientId] = useState('');
  const [gcalClientSecret, setGcalClientSecret] = useState('');
  const [gcalRefreshToken, setGcalRefreshToken] = useState('');
  const [gcalCalendarId, setGcalCalendarId] = useState('');
  const [gcalDuration, setGcalDuration] = useState('120');
  const [gcalEnabled, setGcalEnabled] = useState(true);
  const [tgBotToken, setTgBotToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const gcalFormInit = useRef(false);
  // v5.3.34 Respaldo sin cifrar: opt-in explícito del admin (ver tarjeta
  // Respaldo abajo). Sin esto y sin BACKUP_ENCRYPTION_KEY, el respaldo
  // falla cerrado.
  const [backupAllowUnencrypted, setBackupAllowUnencrypted] = useState(false);
  const backupFormInit = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/system/status');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo cargar el estado');
      setData(json);
      const evRes = await apiFetch(`/api/system/events?limit=50${levelFilter ? `&level=${levelFilter}` : ''}`);
      const evJson = await evRes.json().catch(() => ({}));
      if (evRes.ok) setEvents(evJson.events || []);
      // v5.3.15 Rellenar una sola vez los campos NO secretos de Google con
      // lo guardado (GET /api/settings ya borra los secretos). En su propio
      // try/catch: si falla, el estado principal ya cargó igual.
      try {
        const stRes = await apiFetch('/api/settings');
        const stJson = await stRes.json().catch(() => ({}));
        if (stRes.ok && !gcalFormInit.current) {
          if (typeof stJson.google_calendar_id === 'string' && stJson.google_calendar_id) setGcalCalendarId(stJson.google_calendar_id);
          if (typeof stJson.google_calendar_duration_minutes === 'string' && stJson.google_calendar_duration_minutes) setGcalDuration(stJson.google_calendar_duration_minutes);
          if (typeof stJson.google_calendar_enabled === 'string') setGcalEnabled(stJson.google_calendar_enabled.toLowerCase() !== 'false');
          gcalFormInit.current = true;
        }
        if (stRes.ok && !backupFormInit.current) {
          if (typeof stJson.backup_allow_unencrypted === 'string') setBackupAllowUnencrypted(stJson.backup_allow_unencrypted.toLowerCase() === 'true');
          backupFormInit.current = true;
        }
      } catch { /* sin settings: los campos quedan con su valor por defecto */ }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [levelFilter]);

  // Carga silenciosa al cambiar el filtro de nivel: antes load() ponía
  // loading=true y el return temprano sustituía toda la vista por el
  // loader de pantalla completa. El estado inicial (true) sigue mostrando
  // el loader en la primera carga.
  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [load]);

  const runAction = async (key: string, fn: () => Promise<{ message: string }>) => {
    setBusy(key);
    setMessage('');
    try {
      const r = await fn();
      setMessage(r.message);
      await load(true);
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const selfTest = async () => {
    setBusy('test');
    setMessage('');
    setTests(null);
    try {
      const res = await apiFetch('/api/system/self-test', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'La autoprueba falló');
      setTests(json.tests || []);
      setTestSummary(`${json.summary.passed}/${json.summary.total} pruebas correctas`);
      await load(true);
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const reconnectWhatsApp = async (id?: string) =>
    runAction(`wa-${id || 'all'}`, async () => {
      const res = await apiFetch('/api/system/whatsapp/reconnect', {
        method: 'POST',
        body: JSON.stringify(id ? { id } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo reconectar');
      return { message: 'Reconexión iniciada. Si aparece un QR nuevo, escanealo en Canales WhatsApp.' };
    });

  const doBackup = async () =>
    runAction('backup', async () => {
      const res = await apiFetch('/api/system/backup', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'El respaldo falló');
      return { message: `Respaldo OK: ${json.file} (${Math.round((json.sizeBytes || 0) / 1024)} KB)` };
    });

  const testAlert = async () =>
    runAction('alert', async () => {
      const res = await apiFetch('/api/system/alerts/test', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo probar la alerta');
      if (!json.sent) throw new Error(json.reason || 'Telegram no configurado');
      return { message: 'Alerta de prueba enviada a Telegram. Revisa tu teléfono.' };
    });

  // v5.3.16 Limpiar la caché de WhatsApp: libera espacio sin borrar la
  // sesión ni las fotos; WhatsApp se reconecta solo con la misma sesión.
  // El confirm explica en una frase qué se borra y qué no, porque borrar
  // el volumen desde Railway sí borraría sesión + fotos.
  const cleanCache = async () => {
    if (!window.confirm('Limpiar la caché de WhatsApp libera espacio sin borrar la sesión ni las fotos: WhatsApp se para, se borran solo las cachés de Chrome y se reconecta solo con la misma sesión (sin escanear QR).')) return;
    await runAction('clean-cache', async () => {
      const res = await apiFetch('/api/system/whatsapp/clean-cache', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo limpiar la caché');
      return { message: `Caché limpiada: se liberaron ${json.freedMB} MB · Sesión ${json.sessionMB} MB · Fotos ${json.uploadsMB} MB. WhatsApp se está reconectando solo.` };
    });
  };

  // v5.3.15 Guardar una clave en settings (POST /api/settings, una llamada
  // por clave). Solo admin (el backend lo exige).
  const saveSetting = async (key: string, value: string) => {
    const res = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `No se pudo guardar ${key}`);
  };

  // v5.3.15 Google Calendar: los secretos vacíos NO se envían (lo guardado
  // se conserva). La duración y el calendario solo se envían si tienen
  // valor; el habilitado siempre se envía (es el interruptor). Tras guardar
  // se limpian los campos de secreto y se recarga el estado.
  const saveGoogle = async () =>
    runAction('gcal-save', async () => {
      const pairs: [string, string][] = [];
      if (gcalClientId.trim()) pairs.push(['google_client_id', gcalClientId.trim()]);
      if (gcalClientSecret.trim()) pairs.push(['google_client_secret', gcalClientSecret.trim()]);
      if (gcalRefreshToken.trim()) pairs.push(['google_refresh_token', gcalRefreshToken.trim()]);
      if (gcalCalendarId.trim()) pairs.push(['google_calendar_id', gcalCalendarId.trim()]);
      const dur = parseInt(gcalDuration, 10);
      if (Number.isFinite(dur) && dur > 0) pairs.push(['google_calendar_duration_minutes', String(dur)]);
      pairs.push(['google_calendar_enabled', gcalEnabled ? 'true' : 'false']);
      for (const [key, value] of pairs) await saveSetting(key, value);
      setGcalClientId('');
      setGcalClientSecret('');
      setGcalRefreshToken('');
      return { message: 'Google Calendar guardado. Pulsa “Probar conexión” para verificar que funciona.' };
    });

  const testGoogle = async () =>
    runAction('gcal-test', async () => {
      const res = await apiFetch('/api/system/google-calendar/test', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'La prueba de Google Calendar falló');
      return { message: json.detail || 'Google Calendar conectado: evento de prueba creado y borrado.' };
    });

  // v5.3.15 Telegram: los campos vacíos NO se envían (lo guardado se
  // conserva). Si no hay nada que guardar, se avisa en vez de llamar.
  const saveTelegram = async () =>
    runAction('tg-save', async () => {
      const pairs: [string, string][] = [];
      if (tgBotToken.trim()) pairs.push(['telegram_bot_token', tgBotToken.trim()]);
      if (tgChatId.trim()) pairs.push(['telegram_chat_id', tgChatId.trim()]);
      if (pairs.length === 0) throw new Error('Escribe el token del bot y/o el chat id para guardar');
      for (const [key, value] of pairs) await saveSetting(key, value);
      setTgBotToken('');
      setTgChatId('');
      return { message: 'Telegram guardado. Pulsa “Probar alerta de Telegram” para verificar que llega el mensaje.' };
    });

  // v5.3.34 Respaldo sin cifrar: opt-in explícito del admin. Sin esto (y sin
  // clave BACKUP_ENCRYPTION_KEY), el respaldo falla cerrado.
  const saveBackup = async () =>
    runAction('backup-save', async () => {
      await saveSetting('backup_allow_unencrypted', backupAllowUnencrypted ? 'true' : 'false');
      return { message: backupAllowUnencrypted
        ? 'Guardado: los respaldos se guardarán SIN cifrar. Cada uno avisará por Telegram.'
        : 'Guardado: los respaldos exigirán clave de cifrado (BACKUP_ENCRYPTION_KEY).' };
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Cargando estado del sistema…
      </div>
    );
  }

  const wa = data?.components.find((c) => c.key === 'whatsapp');
  // v5.3.15 Estado de las integraciones para los formularios de abajo: el
  // estado de Google viene en su componente (configured + detail) y el de
  // Telegram en data.alerts. Los secretos nunca se traen al navegador.
  const gcalComp = data?.components.find((c) => c.key === 'google-calendar');
  const tgConfigured = data?.alerts.telegramConfigured ?? false;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Activity className="w-6 h-6 text-brand-600" /> Estado del Sistema
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Si algo se rompe, se ve aquí sin entrar a los logs. Versión {data?.version || '—'} ·
          servidor activo desde hace {data ? fmtUptime(data.uptime_seconds) : '—'}.
        </p>
        {error && (
          <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg flex items-center gap-2">
            <XCircle className="w-4 h-4" /> {error}
          </div>
        )}
      </div>

      {data && !data.alerts.telegramConfigured && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-sm text-amber-800 flex items-start gap-3">
          <Bell className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Las alertas de Telegram no están configuradas.</p>
            <p>
              Sin Telegram, si WhatsApp o la base de datos se caen nadie se entera hasta que un
              cliente se queje. Configúralo abajo, en “Configuración de integraciones → Telegram”
              (2 minutos con BotFather), o con <code className="font-mono">TELEGRAM_BOT_TOKEN</code> y{' '}
              <code className="font-mono">TELEGRAM_CHAT_ID</code> en el <code className="font-mono">.env</code>,
              y luego pulsa “Probar alerta”.
            </p>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {data?.components.map((c) => {
          const Icon = ICONS[c.key] || Server;
          return (
            <div key={c.key} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon className="w-5 h-5 text-slate-500" />
                  <h3 className="font-bold text-slate-800">{c.label}</h3>
                </div>
                <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border ${BADGE[c.status]}`}>
                  <span className={`w-2 h-2 rounded-full ${DOT[c.status]}`} />
                  {LABEL[c.status]}
                </span>
              </div>
              <p className="text-sm text-slate-600 mt-2">{c.detail}</p>
              {c.key === 'google-calendar' && (
                <p className="text-xs text-slate-400 mt-1">
                  {c.configured === false ? 'No configurado' : c.configured ? 'Configurado' : ''}
                  {c.lastError ? ` · Último error (${fmtTime(c.lastError.at)}): ${c.lastError.message}` : ''}
                </p>
              )}
              {c.key === 'db' && c.latencyMs !== undefined && (
                <p className="text-xs text-slate-400 mt-1">Latencia: {c.latencyMs} ms</p>
              )}
              {c.key === 'server' && (
                <p className="text-xs text-slate-400 mt-1">
                  Memoria: {c.memoryMB} MB
                  {c.disk ? ` · Disco libre: ${c.disk.freeMB} MB de ${c.disk.totalMB} MB` : ''}
                </p>
              )}
              {c.key === 'whatsapp' && c.instances && c.instances.length > 0 && (
                <div className="mt-3 space-y-2">
                  {c.instances.map((inst) => (
                    <div key={inst.id} className="flex items-center justify-between gap-2 text-sm bg-slate-50 rounded-lg px-3 py-2">
                      <div>
                        <p className="font-bold text-slate-700">{inst.name} <span className="text-slate-400 font-normal">({inst.status})</span></p>
                        <p className="text-xs text-slate-400">
                          {inst.phone ? `Número: ${inst.phone} · ` : ''}
                          Último mensaje: {fmtTime(inst.lastMessageAt)}
                        </p>
                      </div>
                      <button
                        onClick={() => reconnectWhatsApp(inst.id)}
                        disabled={busy === `wa-${inst.id}`}
                        className="text-xs font-bold text-brand-600 hover:underline disabled:opacity-50 flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" /> Reconectar
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {c.key === 'whatsapp' && data?.storage && (
                <p className="text-xs text-slate-400 mt-1">
                  Almacenamiento: sesión {data.storage.sessionMB} MB · Fotos {data.storage.uploadsMB} MB
                  {data.storage.volumeMB ? ` · Volumen libre: ${data.storage.volumeMB.freeMB} MB de ${data.storage.volumeMB.totalMB} MB${data.storage.volumeMB.usedPercent != null ? ` · Disco al ${data.storage.volumeMB.usedPercent}%` : ''}` : ''}
                </p>
              )}
              {c.key === 'backup' && c.backup?.file && (
                <p className="text-xs text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
                  <span>Archivo: {c.backup.file} · {Math.round((c.backup.sizeBytes || 0) / 1024)} KB</span>
                  <a href={`/api/system/backup/download?file=${encodeURIComponent(c.backup.file)}`} download
                    className="text-xs font-bold text-brand-600 hover:underline flex items-center gap-1">
                    <Download className="w-3 h-3" /> Descargar
                  </a>
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* v5.3.15 Configuración de integraciones: antes no había dónde poner
          Google Calendar ni Telegram (solo por .env / script local). Los
          secretos se escriben aquí y nunca se muestran ni se devuelven: los
          campos empiezan vacíos y los vacíos no se envían al guardar. */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-1">Configuración de integraciones</h2>
        <p className="text-sm text-slate-500 mb-4">
          Las credenciales se guardan solo para el administrador y nunca se muestran.
          Si un campo de secreto queda vacío al guardar, lo que ya estaba guardado se
          conserva. Las variables de .env (Railway) siguen funcionando como respaldo
          si aquí no hay nada puesto.
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border border-slate-200 rounded-2xl p-4">
            <h3 className="font-bold text-slate-800 flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-slate-500" /> Google Calendar
            </h3>
            <p className="text-xs text-slate-500 mt-1 mb-3">
              {gcalComp?.configured ? 'Configurado' : 'No configurado'}
              {gcalComp?.detail ? ` · ${gcalComp.detail}` : ''}
            </p>
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs font-bold text-slate-500 uppercase">Client ID</span>
                <input type="password" value={gcalClientId} onChange={(e) => setGcalClientId(e.target.value)}
                  placeholder={gcalComp?.configured ? '•••••••• (configurado)' : 'Sin configurar'}
                  autoComplete="off"
                  className="w-full border border-slate-300 rounded-lg text-sm p-2 outline-none focus:border-brand-500" />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-slate-500 uppercase">Client Secret</span>
                <input type="password" value={gcalClientSecret} onChange={(e) => setGcalClientSecret(e.target.value)}
                  placeholder={gcalComp?.configured ? '•••••••• (configurado)' : 'Sin configurar'}
                  autoComplete="off"
                  className="w-full border border-slate-300 rounded-lg text-sm p-2 outline-none focus:border-brand-500" />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-slate-500 uppercase">Refresh Token</span>
                <input type="password" value={gcalRefreshToken} onChange={(e) => setGcalRefreshToken(e.target.value)}
                  placeholder={gcalComp?.configured ? '•••••••• (configurado)' : 'Sin configurar'}
                  autoComplete="off"
                  className="w-full border border-slate-300 rounded-lg text-sm p-2 outline-none focus:border-brand-500" />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-slate-500 uppercase">Calendar ID</span>
                <input type="text" value={gcalCalendarId} onChange={(e) => setGcalCalendarId(e.target.value)}
                  placeholder="primary"
                  className="w-full border border-slate-300 rounded-lg text-sm p-2 outline-none focus:border-brand-500" />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-slate-500 uppercase">Duración de cada servicio (minutos)</span>
                <input type="number" min={15} max={1440} value={gcalDuration} onChange={(e) => setGcalDuration(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg text-sm p-2 outline-none focus:border-brand-500" />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={gcalEnabled} onChange={(e) => setGcalEnabled(e.target.checked)} />
                Habilitado (crear eventos al agendar servicios)
              </label>
              <p className="text-xs text-slate-400">
                El refresh token se obtiene con <code className="font-mono">node scripts/get-google-refresh-token.js</code> (ver README, sección “Google Calendar”).
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={saveGoogle} disabled={busy === 'gcal-save'}
                  className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2">
                  {busy === 'gcal-save' ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Guardar Google Calendar
                </button>
                <button onClick={testGoogle} disabled={busy === 'gcal-test'}
                  className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
                  {busy === 'gcal-test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Probar conexión
                </button>
              </div>
            </div>
          </div>
          <div className="border border-slate-200 rounded-2xl p-4">
            <h3 className="font-bold text-slate-800 flex items-center gap-2">
              <Bell className="w-5 h-5 text-slate-500" /> Telegram (alertas)
            </h3>
            <p className="text-xs text-slate-500 mt-1 mb-3">
              {tgConfigured ? 'Configurado: las alertas llegan a Telegram.' : 'No configurado: si WhatsApp o la base de datos se caen, nadie se entera.'}
            </p>
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs font-bold text-slate-500 uppercase">Bot Token</span>
                <input type="password" value={tgBotToken} onChange={(e) => setTgBotToken(e.target.value)}
                  placeholder={tgConfigured ? '•••••••• (configurado)' : 'Sin configurar'}
                  autoComplete="off"
                  className="w-full border border-slate-300 rounded-lg text-sm p-2 outline-none focus:border-brand-500" />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-slate-500 uppercase">Chat ID</span>
                <input type="text" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)}
                  placeholder={tgConfigured ? '•••••••• (configurado)' : 'Sin configurar'}
                  autoComplete="off"
                  className="w-full border border-slate-300 rounded-lg text-sm p-2 outline-none focus:border-brand-500" />
              </label>
              <p className="text-xs text-slate-400">
                Crea el bot con @BotFather en Telegram y copia el token. El chat id es el número
                del chat (o del grupo) donde deben llegar las alertas.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={saveTelegram} disabled={busy === 'tg-save'}
                  className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2">
                  {busy === 'tg-save' ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Guardar Telegram
                </button>
              </div>
              <p className="text-xs text-slate-400">
                Después de guardar, usa el botón “Probar alerta de Telegram” de Acciones para verificar que llega el mensaje.
              </p>
            </div>
          </div>
          <div className="border border-slate-200 rounded-2xl p-4">
            <h3 className="font-bold text-slate-800 flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-slate-500" /> Respaldo
            </h3>
            <p className="text-xs text-slate-500 mt-1 mb-3">
              El respaldo contiene toda la base de datos. Sin clave de cifrado
              (BACKUP_ENCRYPTION_KEY en Railway/.env), el respaldo falla por defecto.
            </p>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={backupAllowUnencrypted} onChange={(e) => setBackupAllowUnencrypted(e.target.checked)} className="mt-0.5" />
                <span>
                  Permitir respaldos SIN cifrar
                  <span className="block text-xs text-amber-600 font-normal mt-0.5">
                    Peligro: el archivo queda en texto plano con hashes de contraseñas y tokens.
                    Cada respaldo sin cifrar avisa por Telegram y queda en Últimos eventos.
                  </span>
                </span>
              </label>
              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={saveBackup} disabled={busy === 'backup-save'}
                  className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2">
                  {busy === 'backup-save' ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Guardar respaldo
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-3">Acciones</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={selfTest} disabled={busy === 'test'}
            className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2">
            {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Probar ahora
          </button>
          <button onClick={() => reconnectWhatsApp()} disabled={busy === 'wa-all'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            <RotateCcw className="w-4 h-4" /> Reconectar WhatsApp
          </button>
          <button onClick={doBackup} disabled={busy === 'backup'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            <Download className="w-4 h-4" /> Hacer respaldo ahora
          </button>
          <button onClick={testAlert} disabled={busy === 'alert'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            <Send className="w-4 h-4" /> Probar alerta de Telegram
          </button>
          <button onClick={cleanCache} disabled={busy === 'clean-cache'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            {busy === 'clean-cache' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eraser className="w-4 h-4" />} Limpiar caché de WhatsApp
          </button>
          <button onClick={() => load()} disabled={loading}
            className="border border-slate-300 px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-50 disabled:opacity-60 flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Actualizar
          </button>
        </div>
        {message && (
          <div className={`mt-4 p-3 rounded-lg text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
            {message}
          </div>
        )}
        {tests && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-bold text-slate-700">Autoprueba: {testSummary}</p>
            {tests.map((t) => (
              <div key={t.name} className="flex items-center justify-between gap-2 text-sm bg-slate-50 rounded-lg px-3 py-2">
                <span className="flex items-center gap-2">
                  {t.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                  {t.name}
                </span>
                <span className="text-xs text-slate-500">{t.detail} · {t.ms} ms</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-slate-800">Últimos eventos</h2>
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}
            className="border border-slate-300 rounded-lg text-sm p-2 outline-none">
            <option value="">Todos los niveles</option>
            <option value="info">Info</option>
            <option value="warn">Advertencias</option>
            <option value="error">Errores</option>
            <option value="critical">Críticos</option>
          </select>
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">No hay eventos registrados todavía. Los errores y avisos importantes aparecerán aquí.</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {events.map((ev, i) => (
              <div key={ev.id || i} className="flex items-start gap-3 text-sm bg-slate-50 rounded-lg px-3 py-2">
                {ev.level === 'critical' || ev.level === 'error'
                  ? <XCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                  : ev.level === 'warn'
                    ? <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    : <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />}
                <div className="min-w-0">
                  <p className="font-bold text-slate-700">
                    <span className="text-xs uppercase text-slate-400 mr-2">{ev.level} · {ev.component}</span>
                    {ev.message}
                  </p>
                  <p className="text-xs text-slate-400">{fmtTime(ev.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {data && data.criticalEvents.length > 0 && (
          <p className="text-xs text-slate-400 mt-3">
            Últimos críticos: {data.criticalEvents.length} (también están en la lista de arriba).
          </p>
        )}
        {wa && (wa.instances?.length ?? 0) === 0 && (
          <p className="text-xs text-slate-400 mt-3">Sin instancias de WhatsApp: crea una en Canales WhatsApp.</p>
        )}
      </div>
    </div>
  );
};
