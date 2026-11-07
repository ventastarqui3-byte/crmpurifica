// Estado del Sistema (solo administradores).
// Semáforos por componente, autoprueba, últimos eventos, reconexión de
// WhatsApp y respaldo. Si algo se rompe, aquí se ve sin entrar a los logs.
import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Play,
  Database, Smartphone, Server, MessagesSquare, HardDrive, Bell,
  Loader2, RotateCcw, Download, Send, CalendarDays,
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Cargando estado del sistema…
      </div>
    );
  }

  const wa = data?.components.find((c) => c.key === 'whatsapp');

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
              cliente se queje. Configura <code className="font-mono">TELEGRAM_BOT_TOKEN</code> y{' '}
              <code className="font-mono">TELEGRAM_CHAT_ID</code> en el <code className="font-mono">.env</code>{' '}
              (2 minutos con BotFather, ver README → “¿Cómo sé si algo se rompió?”) y luego pulsa
              “Probar alerta”.
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
              {c.key === 'backup' && c.backup?.file && (
                <p className="text-xs text-slate-400 mt-1">
                  Archivo: {c.backup.file} · {Math.round((c.backup.sizeBytes || 0) / 1024)} KB
                </p>
              )}
            </div>
          );
        })}
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
