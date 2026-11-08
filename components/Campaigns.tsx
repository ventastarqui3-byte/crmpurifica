// v5.3.20 Campañas personalizadas (dentro de Seguimiento, solo admin).
// A diferencia del seguimiento automático (un aviso por servicio vencido),
// la campaña la crea el admin cuando quiere, escogiendo los clientes de la
// lista. Cada destinatario recibe el mensaje con SU nombre ({{nombre}}) y
// el nombre de la empresa ({{empresa}}), más la imagen o el video de la
// campaña si tiene. El envío va en segundo plano con pausa de 8 s entre
// clientes (anti-bloqueo por QR): el frontend consulta el progreso cada
// 5 s mientras la campaña está enviando. Cada mensaje queda en la
// conversación de Mensajes como uno propio más. Tope de 100 destinatarios
// por campaña (v1).
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Megaphone, Send, Upload, Trash2, Loader2, CheckCircle2, XCircle, Play, Eye, EyeOff, Search, Users } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { isSafeUrl } from '../lib/safeUrl';
import type { CampaignRow, CampaignStatus, CampaignRecipientRow, ClientSummary } from '../types';

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Borrador',
  sending: 'Enviando',
  done: 'Terminada',
  partial: 'Parcial',
};

const STATUS_BADGE: Record<CampaignStatus, string> = {
  draft: 'bg-slate-50 text-slate-600 border-slate-200',
  sending: 'bg-sky-50 text-sky-700 border-sky-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
};

const RECIPIENT_BADGE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
};

export const Campaigns: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [detail, setDetail] = useState<{ campaign: CampaignRow; recipients: CampaignRecipientRow[] } | null>(null);
  const [detailOpen, setDetailOpen] = useState('');

  // Formulario de nueva campaña
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState<'image' | 'video' | ''>('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Selector de clientes
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [clientsTotal, setClientsTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadCampaigns = useCallback(async () => {
    try {
      const res = await apiFetch('/api/campaigns');
      const list = await res.json().catch(() => []);
      if (res.ok && Array.isArray(list)) setCampaigns(list);
    } catch { /* se muestra en el siguiente intento */ }
  }, []);

  const loadClients = useCallback(async (term: string) => {
    try {
      const q = term.trim() ? `?search=${encodeURIComponent(term.trim())}&limit=200` : '?limit=200';
      const res = await apiFetch(`/api/clients${q}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(json.data)) {
        setClients(json.data);
        setClientsTotal(Number(json.total) || json.data.length);
      }
    } catch { /* el buscador queda vacío hasta el siguiente intento */ }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/campaigns/${id}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.id) setDetail({ campaign: json, recipients: Array.isArray(json.recipients) ? json.recipients : [] });
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadCampaigns(), loadClients('')]);
      setLoading(false);
    })();
  }, [loadCampaigns, loadClients]);

  // Buscador de clientes con debounce (el servidor busca por nombre o teléfono)
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { loadClients(search); }, 400);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search, loadClients]);

  // Mientras alguna campaña está enviando, refresca la lista (y el detalle
  // abierto) cada 5 s para ver el progreso sin recargar la página.
  const anySending = campaigns.some((c) => c.status === 'sending') || (detail?.campaign.status === 'sending');
  useEffect(() => {
    if (!anySending) return;
    const t = setInterval(() => {
      loadCampaigns();
      if (detailOpen) loadDetail(detailOpen);
    }, 5000);
    return () => clearInterval(t);
  }, [anySending, detailOpen, loadCampaigns, loadDetail]);

  const runAction = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage('');
    try {
      const msg = await fn();
      setMessage(msg);
      await loadCampaigns();
      if (detailOpen) await loadDetail(detailOpen);
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

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
      const res = await apiFetch('/api/campaigns/media', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo subir el archivo');
      setMediaUrl(json.url);
      setMediaType(json.type === 'video' ? 'video' : 'image');
      return 'Imagen o video listo: se mandará con esta campaña.';
    });
  };

  const toggleClient = (phone: string, clientName: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[phone]) delete next[phone];
      else next[phone] = clientName;
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = { ...prev };
      clients.forEach((c) => { next[c.clientPhone] = c.clientName; });
      return next;
    });
  };

  const createCampaign = () =>
    runAction('create', async () => {
      const recipients = Object.entries(selected).map(([phone, clientName]) => ({ phone, name: clientName }));
      if (!name.trim()) throw new Error('Ponle un nombre a la campaña (ej. “Promo limpieza profunda”).');
      if (!template.trim()) throw new Error('Escribe el mensaje de la campaña.');
      if (recipients.length === 0) throw new Error('Escoge al menos un cliente de la lista.');
      const res = await apiFetch('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), message: template.trim(), media_url: mediaUrl, media_type: mediaType, recipients }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo crear la campaña');
      setName('');
      setTemplate('');
      setMediaUrl('');
      setMediaType('');
      setSelected({});
      return `Campaña creada con ${json.total} cliente(s)${json.skipped ? ` (${json.skipped} sin teléfono válido no entraron)` : ''}. Pulsa Enviar cuando quieras mandarla.`;
    });

  const sendCampaign = (id: string) =>
    runAction(`send-${id}`, async () => {
      const res = await apiFetch(`/api/campaigns/${id}/send`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo iniciar el envío');
      return 'Envío iniciado: va cliente por cliente con pausa entre uno y otro; el progreso se actualiza solo.';
    });

  const retryFailed = (id: string) =>
    runAction(`retry-${id}`, async () => {
      const res = await apiFetch(`/api/campaigns/${id}/retry-failed`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo reintentar');
      return `Reintentando ${json.retried} destinatario(s) fallido(s).`;
    });

  const deleteCampaign = (id: string, campaignName: string) => {
    if (!confirm(`¿Eliminar la campaña “${campaignName}”? Se borran la campaña y su lista de destinatarios. Los mensajes ya enviados quedan en sus conversaciones.`)) {
      return;
    }
    runAction(`delete-${id}`, async () => {
      const res = await apiFetch(`/api/campaigns/${id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo eliminar');
      if (detailOpen === id) { setDetailOpen(''); setDetail(null); }
      return 'Campaña eliminada.';
    });
  };

  const toggleDetail = (id: string) => {
    if (detailOpen === id) { setDetailOpen(''); setDetail(null); return; }
    setDetailOpen(id);
    loadDetail(id);
  };

  const selectedCount = Object.keys(selected).length;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin" /> Cargando campañas…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-brand-600" />
          <h2 className="font-bold text-slate-800">Campañas personalizadas</h2>
        </div>
        <p className="text-sm text-slate-600 mt-1">
          Escoge los clientes, escribe el mensaje con su nombre y mándales la campaña cuando quieras.
          Cada uno recibe el mensaje con su nombre y, si subiste una, con la imagen o el video. El envío
          va cliente por cliente con pausa entre uno y otro, y cada mensaje queda en su conversación.
        </p>
      </div>

      {/* Nueva campaña */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h3 className="font-bold text-slate-800 mb-3">Nueva campaña</h3>
        <div className="grid md:grid-cols-2 gap-4">
          <label className="text-sm text-slate-700">
            Nombre de la campaña
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Ej. Promo limpieza profunda"
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <div className="text-sm text-slate-700">
            Imagen o video (opcional)
            {/* v5.3.25 (M13): el medio solo se previsualiza si la URL es segura. */}
            {mediaUrl && isSafeUrl(mediaUrl) ? (
              <div className="mt-1">
                {mediaType === 'video' ? (
                  <video src={mediaUrl} controls className="max-h-32 rounded-lg border border-slate-200" />
                ) : (
                  <img src={mediaUrl} alt="Medio de la campaña" className="max-h-32 rounded-lg border border-slate-200" />
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => fileRef.current?.click()} disabled={busy === 'media-upload'}
                    className="border border-slate-300 px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-slate-50 disabled:opacity-60"
                  >
                    Cambiar
                  </button>
                  <button
                    onClick={() => { setMediaUrl(''); setMediaType(''); }}
                    className="border border-slate-300 px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-slate-50 flex items-center gap-1"
                  >
                    <Trash2 className="w-4 h-4" /> Quitar
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1">
                <button
                  onClick={() => fileRef.current?.click()} disabled={busy === 'media-upload'}
                  className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2"
                >
                  {busy === 'media-upload' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Subir imagen o video
                </button>
                <p className="text-xs text-slate-400 mt-1">Máximo 25 MB. Si la quitas, la campaña sale solo con texto.</p>
              </div>
            )}
            <input type="file" accept="image/*,video/*" ref={fileRef} className="hidden" onChange={handleMediaFile} />
          </div>
        </div>
        <label className="block text-sm text-slate-700 mt-4">
          Mensaje (variables: {'{{nombre}}'} = nombre del cliente, {'{{empresa}}'} = nombre de tu empresa)
          <textarea
            value={template} onChange={(e) => setTemplate(e.target.value)}
            placeholder={'Hola {{nombre}}, soy de {{empresa}}. Esta semana tenemos una promoción en limpieza profunda…'}
            rows={3}
            className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        {/* Selector de clientes */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <h4 className="font-bold text-slate-800 text-sm flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-500" /> Escoger clientes ({selectedCount} seleccionados)
          </h4>
          <div className="relative mt-2">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o teléfono…"
              className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-slate-500">
              {clients.length} cliente(s) en la lista{clientsTotal > clients.length ? ` de ${clientsTotal} en total` : ''}.
            </p>
            <button onClick={selectAllVisible} className="text-xs font-bold text-brand-600 hover:underline">
              Seleccionar todos los visibles
            </button>
          </div>
          <div className="mt-2 max-h-64 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
            {clients.length === 0 && <p className="text-sm text-slate-500 p-3">No hay clientes para este criterio.</p>}
            {clients.map((c) => (
              <label key={c.clientPhone} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox" checked={Boolean(selected[c.clientPhone])}
                  onChange={() => toggleClient(c.clientPhone, c.clientName)}
                  className="w-4 h-4"
                />
                <span className="font-bold text-slate-700">{c.clientName}</span>
                <span className="text-slate-500">{c.clientPhone}</span>
                {c.totalServices > 0 && <span className="text-xs text-slate-400">· {c.totalServices} servicio(s)</span>}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={createCampaign} disabled={busy === 'create' || selectedCount === 0}
            className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2"
          >
            {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
            Crear campaña ({selectedCount})
          </button>
          {selectedCount > 0 && (
            <button onClick={() => setSelected({})} className="border border-slate-300 px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-50">
              Limpiar selección
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Crear la campaña NO la envía: queda en borrador y la mandas cuando quieras con el botón Enviar.
          Máximo 100 clientes por campaña.
        </p>
        {message && (
          <div className={`mt-4 p-3 rounded-lg text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
            {message}
          </div>
        )}
      </div>

      {/* Lista de campañas */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h3 className="font-bold text-slate-800 mb-3">Historial de campañas ({campaigns.length})</h3>
        {campaigns.length === 0 && (
          <p className="text-sm text-slate-500">Aún no hay campañas. Crea la primera arriba.</p>
        )}
        <div className="space-y-3">
          {campaigns.map((c) => (
            <div key={c.id} className="border border-slate-200 rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-bold text-slate-800">{c.name}</p>
                  <p className="text-xs text-slate-500">
                    {new Date(c.created_at).toLocaleString('es-CO')} · {c.sent}/{c.total} enviados
                    {c.failed > 0 && ` · ${c.failed} fallido(s)`}
                    {c.pending > 0 && ` · ${c.pending} pendiente(s)`}
                  </p>
                  <p className="text-sm text-slate-600 mt-1 line-clamp-2">{c.message}</p>
                  {c.media_url && (
                    <p className="text-xs text-slate-400 mt-1">Con {c.media_type === 'video' ? 'video' : 'imagen'} adjunta.</p>
                  )}
                </div>
                <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {(c.status === 'draft' || c.status === 'partial') && c.pending > 0 && (
                  <button
                    onClick={() => sendCampaign(c.id)} disabled={busy === `send-${c.id}`}
                    className="bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-1"
                  >
                    {busy === `send-${c.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Enviar
                  </button>
                )}
                {c.failed > 0 && c.status !== 'sending' && (
                  <button
                    onClick={() => retryFailed(c.id)} disabled={busy === `retry-${c.id}`}
                    className="bg-slate-800 text-white px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-1"
                  >
                    {busy === `retry-${c.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Reintentar fallidos ({c.failed})
                  </button>
                )}
                <button
                  onClick={() => toggleDetail(c.id)}
                  className="border border-slate-300 px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-slate-50 flex items-center gap-1"
                >
                  {detailOpen === c.id ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  {detailOpen === c.id ? 'Ocultar' : 'Ver destinatarios'}
                </button>
                {c.status !== 'sending' && (
                  <button
                    onClick={() => deleteCampaign(c.id, c.name)} disabled={busy === `delete-${c.id}`}
                    className="border border-red-200 text-red-600 px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-red-50 disabled:opacity-60 flex items-center gap-1"
                  >
                    {busy === `delete-${c.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Eliminar
                  </button>
                )}
              </div>
              {detailOpen === c.id && detail && (
                <div className="mt-3 space-y-2">
                  {detail.recipients.length === 0 && <p className="text-sm text-slate-500">Sin destinatarios.</p>}
                  {detail.recipients.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm bg-slate-50 rounded-lg px-3 py-2">
                      <span>
                        <span className="font-bold text-slate-700">{r.client_name}</span>
                        <span className="text-slate-500"> · {r.client_phone}</span>
                        {r.error && <span className="text-red-600"> · {r.error}</span>}
                      </span>
                      <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${RECIPIENT_BADGE[r.status]}`}>
                        {r.status === 'sent' ? 'Enviado' : r.status === 'failed' ? 'Fallido' : 'Pendiente'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
