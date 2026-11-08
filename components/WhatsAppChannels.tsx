import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {Smartphone, Plus, Trash2, RefreshCw, QrCode, Loader2, Info, ShieldCheck, Zap, X, Cloud, KeyRound, Save, CheckCircle2} from 'lucide-react';
import { WhatsAppInstance, CurrentUser } from '../types';
import { io } from 'socket.io-client';
import { apiFetch } from '../lib/api';
import { isSafeImageSrc } from '../lib/safeUrl';

interface MetaStatus {
  configured: boolean;
  hasToken: boolean;
  tokenSource: 'settings' | 'env' | 'none';
  phoneNumberId: string | null;
  verifyTokenConfigured: boolean;
  appSecretConfigured: boolean;
}

export const WhatsAppChannels: React.FC<{ currentUser: CurrentUser }> = ({ currentUser }) => {
  const isAdmin = currentUser?.role === 'admin';
  const [instances, setInstances] = useState<WhatsAppInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newId, setNewId] = useState('');
  const [newChannel, setNewChannel] = useState<'qr' | 'meta'>('qr');
  const [activeQr, setActiveQr] = useState<{ id: string; qr: string } | null>(null);
  // Meta Cloud API (v5 Parte 2B): el token nunca se muestra ni se descarga;
  // solo se sabe si hay uno guardado (hasToken) y el phone number id.
  const [metaStatus, setMetaStatus] = useState<MetaStatus | null>(null);
  const [metaToken, setMetaToken] = useState('');
  const [metaPhoneId, setMetaPhoneId] = useState('');
  const [metaSaving, setMetaSaving] = useState(false);
  const [metaMsg, setMetaMsg] = useState('');

  const fetchMetaStatus = async () => {
    try {
      const res = await apiFetch('/api/wa/meta/status');
      if (!res.ok) return;
      const data = await res.json();
      setMetaStatus(data);
      if (data.phoneNumberId) setMetaPhoneId(data.phoneNumberId);
    } catch (e) {
      console.error('Error consultando estado de Meta', e);
    }
  };

  const fetchInstances = async () => {
    try {
      const res = await apiFetch('/api/wa/instances');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setInstances(data);
    } catch (e) {
      console.error('Error fetching instances', e);
    } finally {
      setLoading(false);
    }
  };

  // El QR solo vive en memoria del servidor mientras está pendiente: tras
  // recargar, el listado no lo trae y "Ver QR" abría un <img src=""> vacío.
  // Se recupera con GET /api/wa/qr/:id (endpoint que existía sin usarse).
  const handleViewQr = async (inst: WhatsAppInstance) => {
    if (inst.qr) { setActiveQr({ id: inst.id, qr: inst.qr }); return; }
    try {
      const res = await apiFetch(`/api/wa/qr/${inst.id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || 'No se pudo recuperar el QR de esta instancia.'); return; }
      if (data.qr) setActiveQr({ id: inst.id, qr: data.qr });
      else alert('Esta instancia no tiene un QR pendiente ahora. Pulsa "Reconectar" en Estado del Sistema para generar uno nuevo.');
    } catch (e) { console.error('Error recuperando QR', e); alert('Sin conexión con el servidor.'); }
  };

  useEffect(() => {
    fetchInstances();
    fetchMetaStatus();

    // v5.3.24 (A5): el socket se autentica con la cookie HttpOnly
    // (withCredentials); ya no se manda el token en handshake.auth.
    const socket = io(window.location.origin, { withCredentials: true });
    
    socket.on('wa_qr', (data: { id: string; qr: string; status: string }) => {
      setInstances(prev => prev.map(inst => 
        inst.id === data.id ? { ...inst, qr: data.qr, status: data.status as any, hasQr: true } : inst
      ));
      // Solo se abre el QR si no se está mirando el de otra instancia:
      // antes un QR nuevo de cualquier instancia tapaba el que se veía.
      if (data.qr) {
        setActiveQr(prev => (prev && prev.id !== data.id ? prev : { id: data.id, qr: data.qr }));
      }
    });

    socket.on('wa_status', (data: { id: string; status: string }) => {
      setInstances(prev => prev.map(inst => 
        inst.id === data.id ? { ...inst, status: data.status as any, qr: data.status === 'ready' ? undefined : inst.qr, hasQr: data.status === 'ready' ? false : inst.hasQr } : inst
      ));
      if (data.status === 'ready') {
        setActiveQr(null);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const handleAddInstance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) { alert('Solo los administradores pueden agregar canales de WhatsApp.'); return; }
    if (!newId || !newName) return;

    try {
      const res = await apiFetch('/api/wa/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newId, name: newName, channel: newChannel })
      });
      if (res.ok) {
        setIsAdding(false);
        setNewId('');
        setNewName('');
        setNewChannel('qr');
        fetchInstances();
      } else {
        // Antes el error no se mostraba y el modal quedaba abierto sin
        // explicar nada (p. ej. 403 de un no-admin).
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'No se pudo crear la instancia.');
      }
    } catch (e) {
      console.error('Error adding instance', e);
      alert('Sin conexión con el servidor.');
    }
  };

  // Cambiar el canal de una instancia (QR <-> Meta). Al pasar a Meta se
  // destruye la sesión de WhatsApp Web; al volver a QR hay que escanear
  // un QR nuevo.
  const handleChannelChange = async (inst: WhatsAppInstance, channel: 'qr' | 'meta') => {
    if (!isAdmin) { alert('Solo los administradores pueden cambiar el canal de una instancia.'); return; }
    if ((inst.channel || 'qr') === channel) return;
    if (channel === 'meta' && !metaStatus?.configured) {
      alert('Primero configura Meta Cloud API abajo (token y phone number id). Sin eso, la instancia Meta quedaría desconectada.');
      return;
    }
    if (!confirm(`¿Cambiar ${inst.name} a ${channel === 'meta' ? 'Meta Cloud API (oficial)' : 'QR (WhatsApp Web)'}?${channel === 'qr' ? ' Habrá que escanear un QR nuevo.' : ''}`)) return;
    try {
      const res = await apiFetch(`/api/wa/instances/${inst.id}/channel`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel })
      });
      if (res.ok) fetchInstances();
      else { const d = await res.json().catch(() => ({})); alert(d.error || 'No se pudo cambiar el canal'); }
    } catch (e) { console.error('Error cambiando canal', e); }
  };

  // Guardar credenciales de Meta (solo admin; el servidor lo exige también).
  // El token se guarda en settings y nunca vuelve al frontend.
  const handleSaveMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    // Sin token nuevo ni phone id no se guarda nada: antes se mostraba
    // "Meta guardado" aunque no se hubiera guardado nada.
    const hasSavedToken = !!metaStatus?.hasToken;
    if (!metaToken.trim() && !hasSavedToken) { setMetaMsg('Falta el token de acceso de Meta: sin él no se guarda nada.'); return; }
    if (!metaPhoneId.trim()) { setMetaMsg('Falta el Phone Number ID de Meta: sin él las instancias Meta no pueden enviar.'); return; }
    setMetaSaving(true);
    setMetaMsg('');
    try {
      if (metaToken.trim()) {
        const res = await apiFetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'meta_wa_token', value: metaToken.trim() })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); setMetaMsg(d.error || 'No se pudo guardar el token'); setMetaSaving(false); return; }
      }
      if (metaPhoneId.trim()) {
        const res = await apiFetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'meta_wa_phone_number_id', value: metaPhoneId.trim() })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); setMetaMsg(d.error || 'No se pudo guardar el phone number id'); setMetaSaving(false); return; }
      }
      setMetaToken('');
      setMetaMsg('Meta guardado. Las instancias Meta ya pueden enviar y recibir.');
      fetchMetaStatus();
      fetchInstances();
    } catch (err) { setMetaMsg('Error de red guardando Meta'); } finally { setMetaSaving(false); }
  };

  const handleDeleteInstance = async (id: string) => {
    if (!isAdmin) { alert('Solo los administradores pueden eliminar canales de WhatsApp.'); return; }
    if (!confirm('¿Seguro que deseas desconectar y eliminar esta instancia?')) return;
    try {
      const res = await apiFetch(`/api/wa/instances/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchInstances();
        if (activeQr?.id === id) setActiveQr(null);
      } else {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'No se pudo eliminar la instancia.');
      }
    } catch (e) {
      console.error('Error deleting instance', e);
      alert('Sin conexión con el servidor.');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ready': return 'text-emerald-500 bg-emerald-50 border-emerald-100';
      case 'qr_ready': return 'text-amber-500 bg-amber-50 border-amber-100';
      case 'initializing':
      case 'authenticated': return 'text-blue-500 bg-blue-50 border-blue-100';
      case 'disconnected':
      case 'auth_failure':
      case 'error': return 'text-red-500 bg-red-50 border-red-100';
      default: return 'text-slate-400 bg-slate-50 border-slate-100';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'ready': return 'Conectado';
      case 'qr_ready': return 'Esperando QR';
      case 'initializing': return 'Iniciando...';
      case 'authenticated': return 'Autenticado';
      case 'auth_failure': return 'Fallo de Autenticación';
      case 'disconnected': return 'Desconectado';
      case 'error': return 'Error';
      default: return status;
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
            <Smartphone className="w-8 h-8 text-brand-600" />
            Canales de WhatsApp
          </h1>
          <p className="text-slate-500 font-medium mt-1">Gestiona tus conexiones directas de WhatsApp sin intermediarios.</p>
        </div>
        {isAdmin && (
          <button 
            onClick={() => setIsAdding(true)}
            className="bg-brand-600 text-white px-6 py-3 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-brand-600/20 hover:bg-brand-700 transition-all flex items-center gap-2 self-start"
          >
            <Plus className="w-4 h-4" /> Agregar Número
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          {loading ? (
            <div className="bg-white p-12 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col items-center justify-center space-y-4">
              <Loader2 className="w-10 h-10 text-brand-600 animate-spin" />
              <p className="text-slate-400 font-bold uppercase text-[10px] tracking-widest">Cargando instancias...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <AnimatePresence>
                {instances.map((inst) => (
                  <motion.div 
                    key={inst.id}
                    layout
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-md transition-all group"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex items-center gap-3">
                        <div className={`p-3 rounded-2xl ${inst.status === 'ready' ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'}`}>
                          <Smartphone className="w-6 h-6" />
                        </div>
                        <div>
                          <h3 className="font-black text-slate-800">{inst.name}</h3>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">ID: {inst.id}</p>
                        </div>
                      </div>
                      {isAdmin && (
                        <button 
                          onClick={() => handleDeleteInstance(inst.id)}
                          className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-6">
                      <div className={`px-3 py-1 rounded-full border text-[9px] font-black uppercase tracking-widest ${getStatusColor(inst.status)}`}>
                        {getStatusLabel(inst.status)}
                      </div>

                      {(inst.channel || 'qr') === 'meta' ? (
                        <span className="text-[9px] font-black text-sky-600 uppercase flex items-center gap-1">
                          <Cloud className="w-3 h-3" /> Meta Cloud API
                        </span>
                      ) : inst.status === 'qr_ready' && (
                        <button
                          onClick={() => handleViewQr(inst)}
                          className="text-[9px] font-black text-brand-600 uppercase flex items-center gap-1 hover:underline"
                        >
                          <QrCode className="w-3 h-3" /> Ver QR
                        </button>
                      )}
                    </div>

                    {/* Canal de envío (v5 Parte 2B): QR o Meta Cloud API */}
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 block mb-2">Canal de envío</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => handleChannelChange(inst, 'qr')}
                          disabled={!isAdmin}
                          title={isAdmin ? 'Cambiar a QR' : 'Solo el administrador puede cambiar el canal'}
                          className={`py-2 px-2 text-[10px] font-black uppercase rounded-xl border transition-all flex items-center justify-center gap-1 ${(inst.channel || 'qr') === 'qr' ? 'bg-emerald-600 text-white border-emerald-600 shadow-md' : 'bg-white border-slate-200 text-slate-400 hover:border-emerald-300'} disabled:opacity-60`}
                        >
                          <QrCode className="w-3 h-3" /> QR
                        </button>
                        <button
                          onClick={() => handleChannelChange(inst, 'meta')}
                          disabled={!isAdmin}
                          title={isAdmin ? 'Cambiar a Meta' : 'Solo el administrador puede cambiar el canal'}
                          className={`py-2 px-2 text-[10px] font-black uppercase rounded-xl border transition-all flex items-center justify-center gap-1 ${(inst.channel || 'qr') === 'meta' ? 'bg-sky-600 text-white border-sky-600 shadow-md' : 'bg-white border-slate-200 text-slate-400 hover:border-sky-300'} disabled:opacity-60`}
                        >
                          <Cloud className="w-3 h-3" /> Meta
                        </button>
                      </div>
                      {(inst.channel || 'qr') === 'meta' && !metaStatus?.configured && (
                        <p className="text-[10px] text-amber-600 font-bold mt-2">Meta sin configurar: guarda el token y el phone number id abajo.</p>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {instances.length === 0 && (
                <div className="md:col-span-2 bg-slate-50 border-2 border-dashed border-slate-200 p-12 rounded-[2.5rem] text-center">
                  <p className="text-slate-400 font-bold uppercase text-[10px] tracking-widest">No hay números conectados</p>
                  {isAdmin && (
                    <button 
                      onClick={() => setIsAdding(true)}
                      className="mt-4 text-brand-600 font-black text-xs uppercase hover:underline"
                    >
                      Conecta tu primer número ahora
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-brand-600/10 blur-3xl rounded-full" />
            <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-brand-400 mb-6 flex items-center gap-2">
              <Zap className="w-4 h-4" /> Estado de Conexión
            </h3>
            
            {/* v5.3.25 (M13): el QR solo se muestra si es una data:image válida. */}
            {activeQr && isSafeImageSrc(activeQr.qr) ? (
              <div className="space-y-6 flex flex-col items-center">
                <div className="bg-white p-4 rounded-3xl shadow-xl">
                  <img src={activeQr.qr} alt="WhatsApp QR" className="w-48 h-48" />
                </div>
                <div className="text-center space-y-2">
                  <p className="text-sm font-black">Escanea el código QR</p>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                    Vinculando: {instances.find(i => i.id === activeQr.id)?.name}
                  </p>
                </div>
                <div className="flex items-center gap-2 bg-white/5 p-3 rounded-2xl border border-white/10 w-full">
                  <Info className="w-4 h-4 text-brand-400 shrink-0" />
                  <p className="text-[9px] text-slate-300 leading-tight">
                    Abre WhatsApp en tu teléfono {'>'} Dispositivos vinculados {'>'} Vincular un dispositivo.
                  </p>
                </div>
              </div>
            ) : (
              <div className="py-12 flex flex-col items-center text-center space-y-4">
                <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center border border-white/10">
                  <ShieldCheck className="w-8 h-8 text-slate-500" />
                </div>
                <p className="text-xs text-slate-400 font-medium">
                  Selecciona "Ver QR" en una instancia pendiente o agrega un nuevo número para comenzar.
                </p>
              </div>
            )}
          </div>

          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2 flex items-center gap-2">
              <Cloud className="w-4 h-4 text-sky-600" /> Meta Cloud API (oficial)
            </h3>
            <p className="text-[11px] text-slate-500 font-medium leading-relaxed mb-4">
              Alternativa oficial al QR: los mensajes salen por la API de Meta y entran por webhook, sin escanear nada ni depender de un celular encendido. Sin configurar, todo sigue por QR como antes.
            </p>
            {isAdmin ? (
              <form onSubmit={handleSaveMeta} className="space-y-4">
                <div className="flex items-center gap-2 text-[11px] font-bold">
                  {metaStatus?.configured
                    ? <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-4 h-4" /> Configurado{metaStatus.tokenSource === 'env' ? ' (desde .env)' : ' (guardado en el CRM)'}</span>
                    : <span className="text-amber-600 font-bold">Sin configurar</span>}
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1 flex items-center gap-1"><KeyRound className="w-3 h-3" /> Token de acceso {metaStatus?.hasToken && '(guardado: déjalo vacío para no cambiarlo)'}</label>
                  <input
                    type="password"
                    value={metaToken}
                    onChange={(e) => setMetaToken(e.target.value)}
                    placeholder={metaStatus?.hasToken ? '•••••••• (guardado)' : 'EAAJ... (token de Meta)'}
                    autoComplete="off"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-sky-500 transition-all font-bold text-slate-700 text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Phone Number ID</label>
                  <input
                    type="text"
                    value={metaPhoneId}
                    onChange={(e) => setMetaPhoneId(e.target.value.replace(/\D/g, ''))}
                    placeholder="ej: 123456789012345"
                    inputMode="numeric"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-sky-500 transition-all font-bold text-slate-700 text-xs"
                  />
                </div>
                <div className="text-[10px] text-slate-400 font-medium leading-relaxed">
                  Verify token: {metaStatus?.verifyTokenConfigured ? <span className="text-emerald-600 font-bold">configurado en .env</span> : <span className="text-amber-600 font-bold">falta en .env (META_WA_VERIFY_TOKEN)</span>} · Firma webhook: {metaStatus?.appSecretConfigured ? <span className="text-emerald-600 font-bold">verificada</span> : <span className="text-amber-600 font-bold">sin secreto (META_WA_APP_SECRET)</span>}
                </div>
                <button
                  type="submit"
                  disabled={metaSaving}
                  className="w-full bg-sky-600 text-white py-3 rounded-2xl font-black uppercase text-[10px] tracking-[0.2em] shadow-lg shadow-sky-600/20 hover:bg-sky-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {metaSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Guardar Meta
                </button>
                {metaMsg && <p className="text-[11px] font-bold text-slate-600">{metaMsg}</p>}
                <p className="text-[10px] text-slate-400 font-medium leading-relaxed">
                  El token nunca se muestra ni se descarga: queda guardado en el servidor. Pasos completos en el README, sección "WhatsApp Meta Cloud API".
                </p>
              </form>
            ) : (
              <p className="text-[11px] text-slate-500 font-medium">
                {metaStatus?.configured
                  ? 'Meta Cloud API está configurado (el administrador guarda el token).'
                  : 'Meta Cloud API no está configurado. Solo un administrador puede guardar el token.'}
              </p>
            )}
          </div>

          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-6">Ventajas de Conexión Directa</h3>
            <ul className="space-y-4">
              {[
                { icon: Zap, title: 'Cero Latencia', desc: 'Mensajes instantáneos directos por WhatsApp.' },
                { icon: ShieldCheck, title: 'Privacidad', desc: 'Tus datos viajan directo de WA a tu servidor.' },
                { icon: RefreshCw, title: 'Auto-Reconexión', desc: 'Las sesiones se mantienen activas permanentemente.' }
              ].map((item, i) => (
                <li key={i} className="flex gap-4">
                  <div className="bg-brand-50 p-2 rounded-xl text-brand-600 h-fit">
                    <item.icon className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-black text-slate-800">{item.title}</p>
                    <p className="text-[10px] text-slate-500 font-medium leading-tight mt-0.5">{item.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isAdding && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white w-full max-w-md rounded-[3rem] shadow-2xl overflow-hidden border border-slate-100"
            >
              <div className="p-8">
                <div className="flex justify-between items-center mb-8">
                  <h3 className="text-xl font-black text-slate-800 tracking-tight">Nuevo Canal</h3>
                  <button onClick={() => setIsAdding(false)} className="p-2 hover:bg-slate-100 rounded-xl transition-all">
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>

                <form onSubmit={handleAddInstance} className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">ID de Instancia (Sin espacios)</label>
                    <input 
                      type="text" 
                      required
                      value={newId}
                      onChange={(e) => setNewId(e.target.value.toLowerCase().replace(/\s/g, '-'))}
                      placeholder="ej: ventas-bogota"
                      className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-brand-500 transition-all font-bold text-slate-700"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Nombre Descriptivo</label>
                    <input 
                      type="text" 
                      required
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="ej: WhatsApp Ventas 1"
                      className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-brand-500 transition-all font-bold text-slate-700"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-1">Canal</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setNewChannel('qr')}
                        className={`py-3 px-2 text-[11px] font-black uppercase rounded-2xl border transition-all flex items-center justify-center gap-2 ${newChannel === 'qr' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}
                      >
                        <QrCode className="w-4 h-4" /> QR
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewChannel('meta')}
                        className={`py-3 px-2 text-[11px] font-black uppercase rounded-2xl border transition-all flex items-center justify-center gap-2 ${newChannel === 'meta' ? 'bg-sky-600 text-white border-sky-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}
                      >
                        <Cloud className="w-4 h-4" /> Meta
                      </button>
                    </div>
                    {newChannel === 'meta' && !metaStatus?.configured && (
                      <p className="text-[11px] text-amber-600 font-bold">Meta aún no está configurado: guarda el token y el phone number id en el panel "Meta Cloud API" antes de crear instancias Meta.</p>
                    )}
                  </div>

                  <button 
                    type="submit"
                    className="w-full bg-brand-600 text-white py-5 rounded-2xl font-black uppercase text-xs tracking-[0.2em] shadow-xl shadow-brand-600/20 hover:bg-brand-700 transition-all mt-4"
                  >
                    Inicializar Instancia
                  </button>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
