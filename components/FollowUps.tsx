// v5.3.17 Seguimiento automático de clientes (solo admin en v1).
// Cuando un servicio REALIZADO o PAGADO cumple N meses, el CRM crea un
// pendiente para avisarle al cliente por WhatsApp que ya es hora de otra
// limpieza. El admin personaliza todo: habilitado, intervalo en meses,
// modo (manual: él envía los del día; automático: el CRM los envía solo a
// la hora elegida) y la plantilla del mensaje. Un servicio genera un solo
// pendiente: nunca se le escribe dos veces por el mismo trabajo. El mensaje
// enviado queda en la conversación de Mensajes como uno propio más.
// v5.3.18 El seguimiento puede llevar UNA imagen o un video (el mismo para
// todos los avisos, configurable en los ajustes y cambiable cuando se quiera,
// por ejemplo para una promoción). El medio se lee al enviar, no al crear el
// pendiente.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Clock, Send, X, RefreshCw, Play, Loader2, CheckCircle2, XCircle, Save, BellRing, Upload, Trash2, Megaphone } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { FollowupRow, FollowupStatus } from '../types';
import { Campaigns } from './Campaigns';

const DEFAULT_MESSAGE = 'Hola {{nombre}}, soy de {{empresa}}. Hace {{meses}} meses hicimos la limpieza de {{servicio}} en tu hogar y ya es hora de otra limpieza. ¿Te agendo una visita esta semana?';

// Las fechas llegan como ISO (DATE de Postgres a medianoche UTC): se toma
// solo la parte de la fecha para no restar un día por la zona horaria.
const fmtDate = (iso: string | null | undefined): string => {
  const d = String(iso || '').slice(0, 10);
  if (!d || d.length < 10) return '—';
  const [y, m, day] = d.split('-');
  return `${parseInt(day, 10)}/${parseInt(m, 10)}/${y}`;
};

const STATUS_LABEL: Record<FollowupStatus, string> = {
  pending: 'Pendiente',
  sent: 'Enviado',
  failed: 'Fallido',
  skipped: 'Omitido',
};

const STATUS_BADGE: Record<FollowupStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  skipped: 'bg-slate-50 text-slate-500 border-slate-200',
};

export const FollowUps: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [rows, setRows] = useState<FollowupRow[]>([]);

  const [enabled, setEnabled] = useState(false);
  const [months, setMonths] = useState('3');
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [hour, setHour] = useState('9');
  const [template, setTemplate] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState<'image' | 'video' | ''>('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [edits, setEdits] = useState<Record<string, string>>({});

  // v5.3.20 Pestañas: seguimiento automático | campañas personalizadas.
  const [tab, setTab] = useState<'auto' | 'campaigns'>('auto');

  const load = useCallback(async (first = false) => {
    if (first) setLoading(true);
    try {
      const [sRes, fRes] = await Promise.all([
        apiFetch('/api/settings'),
        apiFetch('/api/followups?limit=100'),
      ]);
      const settings = await sRes.json().catch(() => ({}));
      if (sRes.ok) {
        setEnabled(settings.followup_enabled === 'true');
        if (settings.followup_months) setMonths(String(settings.followup_months));
        if (settings.followup_mode === 'auto' || settings.followup_mode === 'manual') setMode(settings.followup_mode);
        if (settings.followup_hour !== undefined && settings.followup_hour !== null && settings.followup_hour !== '') setHour(String(settings.followup_hour));
        if (settings.followup_message) setTemplate(String(settings.followup_message));
        if (settings.followup_media_url) setMediaUrl(String(settings.followup_media_url));
        if (settings.followup_media_type === 'image' || settings.followup_media_type === 'video') setMediaType(settings.followup_media_type);
      }
      const list = await fRes.json().catch(() => []);
      if (fRes.ok && Array.isArray(list)) setRows(list);
    } catch (e: any) {
      setMessage(`Error cargando seguimiento: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(true); }, [load]);

  const runAction = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage('');
    try {
      const msg = await fn();
      setMessage(msg);
      await load();
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const saveSetting = async (key: string, value: string) => {
    const res = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `No se pudo guardar ${key}`);
  };

  const saveSettings = () =>
    runAction('save', async () => {
      const m = parseInt(months, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) throw new Error('El intervalo debe ser un número entre 1 y 12 meses');
      const h = parseInt(hour, 10);
      if (!Number.isFinite(h) || h < 0 || h > 23) throw new Error('La hora debe ser un número entre 0 y 23');
      await saveSetting('followup_enabled', enabled ? 'true' : 'false');
      await saveSetting('followup_months', String(m));
      await saveSetting('followup_mode', mode);
      await saveSetting('followup_hour', String(h));
      if (template.trim()) await saveSetting('followup_message', template.trim());
      await saveSetting('followup_media_url', mediaUrl);
      await saveSetting('followup_media_type', mediaType);
      return 'Ajustes de seguimiento guardados.';
    });

  const handleMediaFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      setMessage('Error: solo se admite imagen o video.');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setMessage('Error: el archivo supera 25 MB.');
      return;
    }
    await runAction('media-upload', async () => {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch('/api/followups/media', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo subir el archivo');
      await saveSetting('followup_media_url', json.url);
      await saveSetting('followup_media_type', json.type);
      setMediaUrl(json.url);
      setMediaType(json.type === 'video' ? 'video' : 'image');
      return 'Medio guardado: se enviará con todos los avisos de seguimiento.';
    });
  };

  const removeMedia = () =>
    runAction('media-remove', async () => {
      const res = await apiFetch('/api/followups/media/remove', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo quitar el medio');
      setMediaUrl('');
      setMediaType('');
      return 'Medio quitado: los avisos saldrán solo con texto. Los mensajes ya enviados conservan su imagen o video.';
    });

  const runNow = () =>
    runAction('run-now', async () => {
      const res = await apiFetch('/api/followups/run-now', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo buscar pendientes');
      if (json.reason === 'deshabilitado') return 'El seguimiento está deshabilitado: actívalo arriba y guarda.';
      return `Escaneo listo: ${json.created} pendientes nuevos (${json.sent} enviados, ${json.failed} fallidos, modo ${json.mode}).`;
    });

  const sendAll = () =>
    runAction('send-all', async () => {
      const res = await apiFetch('/api/followups/send-all', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudieron enviar los pendientes');
      return `Enviados ${json.sent} de ${json.total} pendientes (${json.failed} fallidos).`;
    });

  const sendOne = (id: string) =>
    runAction(`send-${id}`, async () => {
      const edited = (edits[id] || '').trim();
      const res = await apiFetch(`/api/followups/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(edited ? { message: edited } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo enviar');
      if (!json.sent) throw new Error(json.error || 'WhatsApp no lo envió');
      return 'Mensaje enviado al cliente.';
    });

  const skipOne = (id: string) =>
    runAction(`skip-${id}`, async () => {
      const res = await apiFetch(`/api/followups/${id}/skip`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo omitir');
      return 'Seguimiento omitido: no se le escribirá por este servicio.';
    });

  const pending = rows.filter((r) => r.status === 'pending');
  const failed = rows.filter((r) => r.status === 'failed');
  const done = rows.filter((r) => r.status === 'sent' || r.status === 'skipped');

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" /> Cargando seguimiento…
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-2">
          <BellRing className="w-5 h-5 text-brand-600" />
          <h1 className="text-xl font-bold text-slate-800">Seguimiento de clientes</h1>
        </div>
        <p className="text-sm text-slate-600 mt-1">
          Cuando un trabajo realizado o pagado cumple el intervalo, el CRM crea un pendiente para avisarle al
          cliente por WhatsApp que ya es hora de otra limpieza. Cada servicio genera un solo pendiente.
        </p>
      </div>

      {/* v5.3.20 Pestañas: automático | campañas */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab('auto')}
          className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${tab === 'auto' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'}`}
        >
          <BellRing className="w-4 h-4" /> Seguimiento automático
        </button>
        <button
          onClick={() => setTab('campaigns')}
          className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${tab === 'campaigns' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'}`}
        >
          <Megaphone className="w-4 h-4" /> Campañas
        </button>
      </div>

      {tab === 'campaigns' ? (
        <Campaigns />
      ) : (
      <>
      {/* Ajustes */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-3">Ajustes</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4" />
            Seguimiento activado
          </label>
          <label className="text-sm text-slate-700">
            Intervalo (meses)
            <input
              type="number" min={1} max={12} value={months} onChange={(e) => setMonths(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-slate-700">
            Modo
            <select
              value={mode} onChange={(e) => setMode(e.target.value as 'manual' | 'auto')}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="manual">Manual: yo envío los pendientes del día</option>
              <option value="auto">Automático: el CRM los envía solo</option>
            </select>
          </label>
          {mode === 'auto' && (
            <label className="text-sm text-slate-700">
              Hora de envío (0–23, hora de Bogotá)
              <input
                type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>
          )}
        </div>
        <label className="block text-sm text-slate-700 mt-4">
          Mensaje (puedes cambiarlo; variables: {'{{nombre}}'} {'{{servicio}}'} {'{{fecha}}'} {'{{meses}}'} {'{{empresa}}'})
          <textarea
            value={template} onChange={(e) => setTemplate(e.target.value)}
            placeholder={DEFAULT_MESSAGE}
            rows={3}
            className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
        {/* v5.3.18 Imagen o video del seguimiento (uno solo para todos) */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <h3 className="font-bold text-slate-800 text-sm">Imagen o video del seguimiento</h3>
          <p className="text-xs text-slate-500 mt-1">
            Este medio se manda con todos los avisos de seguimiento. Cámbialo cuando quieras, por ejemplo para una promoción.
          </p>
          {mediaUrl ? (
            <div className="mt-3">
              {mediaType === 'video' ? (
                <video src={mediaUrl} controls className="max-h-40 rounded-lg border border-slate-200" />
              ) : (
                <img src={mediaUrl} alt="Medio del seguimiento" className="max-h-40 rounded-lg border border-slate-200" />
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500 mt-2">Sin imagen ni video — el aviso llega solo con texto.</p>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            <input type="file" accept="image/*,video/*" ref={fileRef} className="hidden" onChange={handleMediaFile} />
            <button
              onClick={() => fileRef.current?.click()} disabled={busy === 'media-upload'}
              className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2"
            >
              {busy === 'media-upload' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {mediaUrl ? 'Cambiar imagen o video' : 'Subir imagen o video'}
            </button>
            {mediaUrl && (
              <button
                onClick={removeMedia} disabled={busy === 'media-remove'}
                className="border border-slate-300 px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-50 disabled:opacity-60 flex items-center gap-2"
              >
                {busy === 'media-remove' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Quitar
              </button>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Imagen o video, máximo 25 MB. Se lee al enviar: si cambias la promoción, los pendientes que aún no se han enviado llevan la nueva.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={saveSettings} disabled={busy === 'save'}
            className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2"
          >
            {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Guardar ajustes
          </button>
          <button
            onClick={runNow} disabled={busy === 'run-now'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2"
          >
            {busy === 'run-now' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Buscar pendientes ahora
          </button>
          {mode === 'manual' && pending.length > 0 && (
            <button
              onClick={sendAll} disabled={busy === 'send-all'}
              className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-2"
            >
              {busy === 'send-all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Enviar todos los pendientes ({pending.length})
            </button>
          )}
        </div>
        {message && (
          <div className={`mt-4 p-3 rounded-lg text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
            {message}
          </div>
        )}
      </div>

      {/* Pendientes */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-1 flex items-center gap-2">
          <Clock className="w-5 h-5 text-slate-500" /> Pendientes ({pending.length})
        </h2>
        <p className="text-xs text-slate-500 mt-1 flex items-center gap-2">
          {mediaUrl ? (
            <>
              Se enviará con:
              {mediaType === 'video' ? (
                <video src={mediaUrl} className="w-10 h-10 object-cover rounded border border-slate-200" />
              ) : (
                <img src={mediaUrl} alt="" className="w-10 h-10 object-cover rounded border border-slate-200" />
              )}
            </>
          ) : (
            'Solo texto (sin imagen ni video).'
          )}
        </p>
        {pending.length === 0 && (
          <p className="text-sm text-slate-500 mt-2">No hay pendientes. Pulsa “Buscar pendientes ahora” para revisar los servicios que ya cumplieron el intervalo.</p>
        )}
        <div className="space-y-3 mt-3">
          {pending.map((f) => (
            <div key={f.id} className="border border-slate-200 rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-bold text-slate-800">{f.client_name} <span className="text-slate-400 font-normal">· {f.client_phone}</span></p>
                  <p className="text-xs text-slate-500">{f.service_name} · Último trabajo: {fmtDate(f.service_date)} · Tocaba: {fmtDate(f.due_date)}</p>
                </div>
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${STATUS_BADGE[f.status]}`}>{STATUS_LABEL[f.status]}</span>
              </div>
              <textarea
                value={edits[f.id] ?? f.message}
                onChange={(e) => setEdits((prev) => ({ ...prev, [f.id]: e.target.value }))}
                rows={3}
                className="mt-3 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => sendOne(f.id)} disabled={busy === `send-${f.id}`}
                  className="bg-brand-600 text-white px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-1"
                >
                  {busy === `send-${f.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Enviar
                </button>
                <button
                  onClick={() => skipOne(f.id)} disabled={busy === `skip-${f.id}`}
                  className="border border-slate-300 px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-slate-50 disabled:opacity-60 flex items-center gap-1"
                >
                  <X className="w-4 h-4" /> Omitir
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Fallidos */}
      {failed.length > 0 && (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-red-200">
          <h2 className="font-bold text-red-700 mb-1 flex items-center gap-2">
            <XCircle className="w-5 h-5" /> Fallidos ({failed.length})
          </h2>
          <p className="text-sm text-slate-600">Estos no llegaron a WhatsApp. Revísalos y reinténtalos.</p>
          <div className="space-y-3 mt-3">
            {failed.map((f) => (
              <div key={f.id} className="border border-red-200 rounded-xl p-4">
                <p className="font-bold text-slate-800">{f.client_name} <span className="text-slate-400 font-normal">· {f.client_phone}</span></p>
                <p className="text-xs text-slate-500">{f.service_name} · Tocaba: {fmtDate(f.due_date)}</p>
                <p className="text-sm text-slate-600 mt-2">{f.message}</p>
                <button
                  onClick={() => sendOne(f.id)} disabled={busy === `send-${f.id}`}
                  className="mt-2 bg-brand-600 text-white px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-1"
                >
                  {busy === `send-${f.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Reintentar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Enviados / omitidos */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-1 flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" /> Enviados y omitidos ({done.length})
        </h2>
        {done.length === 0 && <p className="text-sm text-slate-500 mt-2">Aún no hay seguimientos enviados ni omitidos.</p>}
        <div className="space-y-2 mt-3">
          {done.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 text-sm bg-slate-50 rounded-lg px-3 py-2">
              <span>
                <span className="font-bold text-slate-700">{f.client_name}</span>
                <span className="text-slate-500"> · {f.client_phone} · {f.service_name} · Tocaba: {fmtDate(f.due_date)}</span>
              </span>
              <span className="flex items-center gap-2">
                {f.status === 'sent' && <span className="text-xs text-slate-400">Enviado: {fmtDate(f.sent_at)}</span>}
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${STATUS_BADGE[f.status]}`}>{STATUS_LABEL[f.status]}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      </>
      )}
    </div>
  );
};
