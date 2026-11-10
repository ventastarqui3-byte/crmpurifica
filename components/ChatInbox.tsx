
import React, { useState, useEffect, useRef, useMemo } from 'react';
import {ChatConversation, StaffMember, ChatMessage, LeadStatus, CurrentUser, ChatTemplate} from '../types';
import {Search, Send, ArrowLeft, MessageCircle, Globe, Plus, ClipboardList, X, Calculator, Save, Camera, Loader2, Zap, Instagram, Facebook, Info, Sparkles, Paperclip, FileText, Download, Bot} from 'lucide-react';
import { ClientIntelligence } from './ClientIntelligence';
import { apiFetch } from '../lib/api';
import { isSafeUrl, isSafeImageSrc } from '../lib/safeUrl';

interface ChatInboxProps {
  conversations: ChatConversation[];
  staff: StaffMember[];
  currentUser: CurrentUser;
  onLocalMessage: (conversationId: string, message: ChatMessage) => void;
  onOpenService: (phone: string, leadData: any) => void;
  onUpdateStatus?: (id: string, status: LeadStatus, isConvId: boolean) => void;
  preselectedPhone?: string | null;
  onClearPreselection?: () => void;
  // v5.2 B5: modo lectura para el operador: ve solo las conversaciones de
  // los clientes de sus servicios asignados (el servidor ya las filtra),
  // sin caja de envío y sin cambiar el estado del lead.
  readOnly?: boolean;
}

const SourceBadge = ({ source, inboxName, className = "" }: { source?: string, inboxName?: string, className?: string }) => {
  const commonClasses = `text-[9px] font-black px-2 py-0.5 rounded flex items-center gap-1.5 uppercase tracking-tighter shadow-sm border transition-all ${className}`;
  const s = (source || '').toLowerCase();
  
  if (s.includes('whatsapp')) {
    return <span className={`${commonClasses} bg-green-100 text-green-700 border-green-200`}><MessageCircle className="w-3 h-3" /> {inboxName || 'WhatsApp'}</span>;
  }
  if (s.includes('instagram')) {
    return <span className={`${commonClasses} bg-pink-100 text-pink-700 border-pink-200`}><Instagram className="w-3 h-3" /> {inboxName || 'Instagram'}</span>;
  }
  if (s.includes('facebook') || s.includes('messenger') || s.includes('page')) {
    return <span className={`${commonClasses} bg-blue-100 text-blue-700 border-blue-200`}><Facebook className="w-3 h-3" /> {inboxName || 'Messenger'}</span>;
  }
  if (s.includes('api')) {
    return <span className={`${commonClasses} bg-purple-100 text-purple-700 border-purple-200`}><Zap className="w-3 h-3" /> {inboxName || 'API'}</span>;
  }
  
  return <span className={`${commonClasses} bg-slate-100 text-slate-700 border-slate-200`}><Globe className="w-3 h-3" /> {inboxName || 'Web'}</span>;
};

export const ChatInbox: React.FC<ChatInboxProps> = ({ conversations, staff, currentUser, onOpenService, onUpdateStatus, onLocalMessage, preselectedPhone, onClearPreselection, readOnly = false }) => {
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [messageText, setMessageText] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<ChatTemplate[]>([]);
  const [sidebarTab, setSidebarTab] = useState<'info' | 'intel'>('info');
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);

  // v5.3.30: historial completo del chat abierto. La lista (GET /api/chats)
  // solo trae los últimos 50 mensajes por conversación; al abrir un chat se
  // pide aquí el historial (200) y se puede cargar más hacia atrás.
  // detailChatId evita mostrar el historial del chat anterior mientras
  // carga el nuevo; detailMessages null = usar los mensajes de la lista.
  const [detailMessages, setDetailMessages] = useState<ChatMessage[] | null>(null);
  const [detailChatId, setDetailChatId] = useState<string | null>(null);
  const [detailHasMore, setDetailHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  
  const [clientName, setClientName] = useState('');
  const [techImages, setTechImages] = useState<string[]>([]);
  const [localLeadStatus, setLocalLeadStatus] = useState<LeadStatus>(LeadStatus.NEW);
  const [itemsToClean, setItemsToClean] = useState('');
  const [estimatedValue, setEstimatedValue] = useState(0);
  const [address, setAddress] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [city, setCity] = useState('');
  const [advisor, setAdvisor] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  // v5.3.6 — Adjuntos: foto, audio, video o documento (tope 25 MB). El
  // archivo se sube primero a /api/chats/:id/attachments y luego se envía
  // el mensaje con su attachmentUrl; la vista previa es local.
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachPreview, setAttachPreview] = useState<string | null>(null);
  const [attachError, setAttachError] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // v5.3.36 Bot de WhatsApp: spinner del botón pausar/reactivar.
  const [botBusy, setBotBusy] = useState(false);

  // Grabación de voz y adjuntos: había refs e iconos (Mic, Paperclip...)
  // pero ningún botón ni <input type=file>: no se podía grabar ni adjuntar
  // nada. Se quitan los restos muertos; si se quiere el feature, hay que
  // construirlo (botón + subida) en vez de dejar refs sin uso.
  const chatEndRef = useRef<HTMLDivElement>(null);

  const activeChat = useMemo(() => conversations.find(c => c.id === selectedChatId), [conversations, selectedChatId]);

  // v5.3.30: la vista del chat abierto usa el historial completo si ya
  // cargó para ESTE chat; si no, los mensajes de la lista (últimos 50).
  const openMessages = (detailChatId === selectedChatId && detailMessages !== null) ? detailMessages : (activeChat?.messages || []);
  
  // FILTRADO Y ORDENAMIENTO (Mantiene lo nuevo arriba)
  const filteredConversations = useMemo(() => {
    const myName = (currentUser.name || '').trim().toLowerCase();
    
    let result = conversations.filter(chat => {
      const search = searchTerm.toLowerCase();
      const matchesSearch = (chat.clientName || '').toLowerCase().includes(search) || (chat.clientPhone || '').includes(search);
      if (!matchesSearch) return false;

      if (currentUser.role === 'advisor') {
        const chatAdvisor = (chat.leadData?.advisor || '').trim().toLowerCase();
        const isMine = !chatAdvisor || chatAdvisor === 'sin asignar' || chatAdvisor === myName;
        if (!isMine) return false;
      }
      return true;
    });

    // Sin reordenar: el backend ya devuelve las conversaciones por
    // last_message_time DESC. Antes se ordenaba por messages[].fullDate,
    // que el backend no devuelve: new Date(undefined) = NaN y el orden
    // quedaba al azar (correcto solo por accidente).
    return result;
  }, [conversations, searchTerm, currentUser]);

  useEffect(() => {
    apiFetch('/api/templates').then(res => { if (!res.ok) throw new Error('templates'); return res.json(); }).then(data => { if (Array.isArray(data)) setTemplates(data); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (preselectedPhone && conversations.length > 0) {
      const match = conversations.find(c => c.clientPhone === preselectedPhone || c.id === preselectedPhone);
      if (match) {
        setSelectedChatId(match.id);
        // Solo se limpia la preselección si hubo coincidencia: antes se
        // borraba siempre y el chat pedido nunca se abría si la lista
        // aún no lo traía.
        if (onClearPreselection) {
          onClearPreselection();
        }
      }
    }
  }, [preselectedPhone, conversations, onClearPreselection]);

  useEffect(() => {
    if (activeChat) {
      setClientName(activeChat.clientName || '');
      setTechImages(activeChat.leadData?.technicalImages || []);
      setLocalLeadStatus(activeChat.leadStatus || LeadStatus.NEW);
      setItemsToClean(activeChat.leadData?.itemsToClean || '');
      setEstimatedValue(activeChat.leadData?.estimatedValue || 0);
      setAddress(activeChat.leadData?.address || '');
      // location viene como "Barrio, Ciudad": el barrio es solo la
      // primera parte. Antes se guardaba la ubicación completa en
      // neighborhood y al guardar se sumaba la ciudad otra vez
      // ("Chapinero, Bogotá, Bogotá", creciendo en cada guardado).
      setNeighborhood((activeChat.leadData?.location || '').split(',')[0].trim());
      setCity(activeChat.leadData?.location?.split(',')[1]?.trim() || '');
      setAdvisor(activeChat.leadData?.advisor || currentUser.name);
      
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 150);
      
      // El contador de no leídos se limpia solo con el próximo fetchData:
      // no existe endpoint de "marcar leído" (onMarkAsRead era un no-op).
    }
  }, [selectedChatId, activeChat?.messages?.length]);

  // v5.3.30: cargar el historial completo al abrir un chat, y refrescarlo
  // cuando llegan mensajes nuevos a ese chat (la lista se actualiza por
  // socket y su contador cambia). No se refetchea si el historial ya está
  // al día (su último mensaje es el mismo que el de la lista): así, si el
  // usuario cargó mensajes viejos con "Cargar anteriores", no se pierden
  // al llegar un mensaje nuevo... salvo que haya uno nuevo, en cuyo caso
  // se vuelve a los 200 más recientes y se baja al final, como siempre.
  // Al cambiar de chat se limpia el historial para no mostrar el anterior.
  const detailRef = useRef<ChatMessage[] | null>(null);
  useEffect(() => { detailRef.current = detailMessages; }, [detailMessages]);
  const prevChatIdRef = useRef<string | null>(null);
  // v5.3.31: el id del último mensaje de la lista como disparador del
  // refresco. Antes el efecto solo dependía del CONTEO de mensajes, y con
  // el tope de 50 de la v5.3.30 el conteo deja de cambiar en chats con 50+
  // mensajes: el efecto no se re-ejecutaba y los mensajes nuevos (de texto
  // o de media, enviados o recibidos) no aparecían hasta refrescar la
  // página a mano. El id sí cambia con cada mensaje nuevo, esté o no el
  // chat en el tope. La guarda de dentro (mismo último id → no refetchear)
  // sigue evitando refetcheos de más.
  const newestListMsgId = activeChat?.messages?.length ? activeChat.messages[activeChat.messages.length - 1].id : null;
  useEffect(() => {
    if (!activeChat) { setDetailMessages(null); setDetailChatId(null); setDetailHasMore(false); prevChatIdRef.current = null; return; }
    const chatChanged = prevChatIdRef.current !== activeChat.id;
    if (chatChanged) { setDetailMessages(null); setDetailChatId(null); setDetailHasMore(false); prevChatIdRef.current = activeChat.id; }
    const listMsgs = activeChat.messages || [];
    const newestListId = listMsgs.length ? listMsgs[listMsgs.length - 1].id : null;
    const current = detailRef.current;
    if (!chatChanged && current !== null && newestListId !== null && current.length > 0 && current[current.length - 1].id === newestListId) return;
    let cancelled = false;
    apiFetch(`/api/chats/${activeChat.id}/messages?limit=200`)
      .then(res => { if (!res.ok) throw new Error('messages'); return res.json(); })
      .then(data => {
        if (cancelled) return;
        if (Array.isArray(data?.data)) {
          setDetailMessages(data.data);
          setDetailChatId(activeChat.id);
          setDetailHasMore(!!data.hasMore);
          setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 150);
        }
      })
      .catch(() => { /* sin historial: la vista sigue con los mensajes de la lista */ });
    return () => { cancelled = true; };
  }, [selectedChatId, activeChat?.messages?.length, newestListMsgId]);

  // v5.3.30: cargar una página más hacia atrás (200 mensajes más viejos
  // que el primero que se ve). No baja al final: el usuario sigue donde
  // estaba leyendo.
  const loadOlderMessages = async () => {
    if (!activeChat || !detailMessages || detailMessages.length === 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await apiFetch(`/api/chats/${activeChat.id}/messages?limit=200&before=${encodeURIComponent(detailMessages[0].id)}`);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (Array.isArray(data?.data)) {
          setDetailMessages([...data.data, ...detailMessages]);
          setDetailHasMore(!!data.hasMore);
        }
      }
    } catch { /* se queda como está */ }
    setLoadingOlder(false);
  };

  // v5.3.36 Bot de WhatsApp: pausar / reactivar el bot para este chat.
  // El bot se reanuda SOLO por este botón (no hay temporizadores). Tras
  // guardar, la lista se actualiza sola por el socket (el endpoint avisa
  // con notifyUpdate('chat') y App recarga las conversaciones).
  const toggleBot = async () => {
    if (!activeChat || botBusy || readOnly) return;
    const newPaused = !activeChat.botPaused;
    setBotBusy(true);
    try {
      const res = await apiFetch(`/api/chats/${encodeURIComponent(activeChat.id)}/bot-toggle`, {
        method: 'POST',
        body: JSON.stringify({ paused: newPaused }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo cambiar el estado del bot');
    } catch (e: any) {
      setAttachError(e.message || 'No se pudo cambiar el estado del bot');
    } finally {
      setBotBusy(false);
    }
  };

  // Textos que el servidor usa como contenido cuando un mensaje de media
  // no trae caption: no se muestran como texto debajo del adjunto.
  const MEDIA_LABELS = ['📷 Imagen', '🎤 Nota de voz', '🎬 Video', '📎 Documento', '😀 Sticker', '📎 Archivo'];

  const handleAttachFile = (file: File | null) => {
    setAttachError('');
    if (!file) { setAttachFile(null); setAttachPreview(null); return; }
    if (file.size > 25 * 1024 * 1024) { setAttachError('El archivo supera 25 MB'); return; }
    const ok = file.type.startsWith('image/') || file.type.startsWith('audio/') || file.type.startsWith('video/') ||
      ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'].includes(file.type);
    if (!ok) { setAttachError('Tipo de archivo no permitido (imagen, audio, video o documento)'); return; }
    if (attachPreview) URL.revokeObjectURL(attachPreview);
    setAttachFile(file);
    setAttachPreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
  };

  const clearAttachment = () => {
    if (attachPreview) URL.revokeObjectURL(attachPreview);
    setAttachFile(null);
    setAttachPreview(null);
    setAttachError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSendMessage = async () => {
    if (readOnly) return;
    if ((!messageText.trim() && !attachFile) || !activeChat) return;
    const text = messageText;
    const file = attachFile;
    setMessageText('');
    clearAttachment();
    try {
      let type: ChatMessage['type'] = 'text';
      let attachmentUrl: string | undefined;
      if (file) {
        setIsUploading(true);
        const form = new FormData();
        form.append('file', file);
        const up = await apiFetch(`/api/chats/${activeChat.id}/attachments`, { method: 'POST', body: form });
        const upData = await up.json().catch(() => null);
        setIsUploading(false);
        if (!up.ok || !upData?.attachmentUrl) {
          setAttachError(upData?.error || 'No se pudo subir el archivo');
          setMessageText(text);
          return;
        }
        type = upData.type || 'document';
        attachmentUrl = upData.attachmentUrl;
      }
      onLocalMessage(activeChat.id, {
        id: Date.now().toString(),
        sender: 'agent',
        content: text,
        timestamp: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
        fullDate: new Date().toISOString(),
        type,
        attachmentUrl,
      });
    } catch (e) {
      setIsUploading(false);
      setAttachError('Sin conexión con el servidor');
      setMessageText(text);
    }
  };

  const toggleImageSelection = (url: string) => {
    if (currentUser.role === 'operator') return;
    setTechImages(prev => prev.includes(url) ? prev.filter(img => img !== url) : [...prev, url]);
  };

  const renderSidebarContent = () => {
    if (!activeChat) return null;
    return (
      <div className="flex flex-col h-full relative">
        <div className="flex border-b sticky top-0 bg-white z-10">
          <button onClick={() => setSidebarTab('info')} className={`flex-1 py-4 text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 ${sidebarTab === 'info' ? 'text-brand-600 border-b-2 border-brand-600' : 'text-slate-400'}`}><ClipboardList className="w-4 h-4" /> Info Venta</button>
          <button onClick={() => setSidebarTab('intel')} className={`flex-1 py-4 text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 ${sidebarTab === 'intel' ? 'text-brand-600 border-b-2 border-brand-600' : 'text-slate-400'}`}><Sparkles className="w-4 h-4" /> Inteligencia</button>
          <button onClick={() => setShowMobileSidebar(false)} className="xl:hidden p-4 text-slate-400"><X className="w-5 h-5" /></button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-5 pb-32">
          {sidebarTab === 'info' ? (
            <div className="space-y-6 animate-in fade-in duration-300">
               {/* NOMBRE */}
               <div className="bg-brand-50/50 p-4 rounded-2xl border border-brand-100 shadow-inner">
                  <label className="text-[9px] font-black text-brand-500 uppercase tracking-widest mb-2 block">Nombre Real Cliente</label>
                  <input type="text" value={clientName} onChange={e => setClientName(e.target.value)} className="w-full bg-white border border-brand-100 rounded-xl px-3 py-2 text-xs font-black outline-none" placeholder="Nombre completo..." />
               </div>

               {/* ESTADO PIPELINE */}
               <div>
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3 block">Estado Pipeline</label>
                  <div className="grid grid-cols-2 gap-2">
                     {[LeadStatus.QUOTED, LeadStatus.PENDING_DECISION, LeadStatus.SCHEDULED, LeadStatus.LOST].map(status => (
                       <button key={status} onClick={() => setLocalLeadStatus(status)} className={`py-2 px-1 text-[10px] font-black uppercase rounded-lg border transition-all ${localLeadStatus === status ? 'bg-brand-600 text-white border-brand-600 shadow-md' : 'bg-white border-slate-100 text-slate-400 hover:border-brand-200'}`}>{status.replace('_',' ')}</button>
                     ))}
                  </div>
               </div>

               {/* ASESOR */}
               <div>
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Asesor Responsable</label>
                  <select value={advisor} onChange={e => setAdvisor(e.target.value)} className="w-full bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:bg-white">
                     <option value="">Seleccionar Asesor...</option>
                     {staff.filter(s => s.role !== 'operator').map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
               </div>

               {/* UBICACIÓN */}
               <div className="space-y-4 border-t pt-4">
                  <div className="grid grid-cols-2 gap-2">
                    <input type="text" value={city} onChange={e => setCity(e.target.value)} placeholder="Ciudad" className="w-full bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold outline-none" />
                    <input type="text" value={neighborhood} onChange={e => setNeighborhood(e.target.value)} placeholder="Barrio" className="w-full bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold outline-none" />
                  </div>
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Dirección Exacta</label>
                    <input type="text" value={address} onChange={e => setAddress(e.target.value)} placeholder="Ej: Calle 3 # 45-67" className="w-full bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold outline-none" />
                  </div>
               </div>

               {/* ITEMS */}
               <div className="border-t pt-4">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Items a Limpieza</label>
                  <textarea value={itemsToClean} onChange={e => setItemsToClean(e.target.value)} rows={3} className="w-full bg-slate-50 border border-slate-100 rounded-2xl p-3 text-xs font-bold outline-none shadow-inner" placeholder="Sofá 3 puestos..." />
               </div>

               {/* VALOR */}
               <div className="border-t pt-4">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Valor Cotizado</label>
                  <div className="bg-emerald-50/50 p-4 rounded-2xl border border-emerald-100 flex items-center justify-between">
                     <Calculator className="w-5 h-5 text-emerald-600" />
                     <input type="number" value={estimatedValue} onChange={e => setEstimatedValue(Number(e.target.value))} className="bg-transparent border-none text-right font-black text-xl text-emerald-700 w-full outline-none" />
                  </div>
               </div>

               {/* FOTOS DE REFERENCIA */}
               <div className="border-t pt-4 pb-10">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-3"><Camera className="w-3 h-3" /> Fotos de Referencia ({techImages.length})</label>
                  <div className="grid grid-cols-3 gap-2">
                     {techImages.map((img, idx) => (
                       <div key={idx} className="relative aspect-square rounded-xl overflow-hidden shadow-sm border-2 border-white group">
                          <img src={img} className="w-full h-full object-cover" />
                          <button onClick={() => toggleImageSelection(img)} className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-md shadow-lg opacity-90 hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>
                       </div>
                     ))}
                  </div>
               </div>
            </div>
          ) : (
            <ClientIntelligence clientPhone={activeChat.clientPhone} clientName={activeChat.clientName} currentUser={currentUser} />
          )}
        </div>

        {!readOnly && (<div className="absolute bottom-0 left-0 w-full p-5 border-t border-slate-100 bg-white/95 backdrop-blur-md z-40">
           <button 
             onClick={async () => {
                setIsSyncing(true);
                try {
                  await apiFetch('/api/leads/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                      conversationId: activeChat.id, 
                      clientName, 
                      technicalImages: techImages, 
                      status: localLeadStatus, 
                      itemsToClean, 
                      estimatedValue, 
                      address, 
                      location: neighborhood + (city ? `, ${city}` : ''), 
                      advisor 
                    })
                  });
                  if (localLeadStatus === LeadStatus.SCHEDULED) {
                    onOpenService(activeChat.clientPhone, { name: clientName, items: itemsToClean, value: estimatedValue, technicalImages: techImages, address, location: neighborhood, advisor });
                  }
                  setShowMobileSidebar(false);
                } catch (e) { console.error(e); } finally { setIsSyncing(false); }
             }} 
             disabled={isSyncing} 
             className="w-full bg-slate-900 text-white py-4 rounded-xl text-[10px] font-black uppercase shadow-xl flex items-center justify-center gap-2 transition-all active:scale-95"
           >
             {isSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Sincronizar Venta
           </button>
        </div>)}
      </div>
    );
  };

  return (
    <div className="flex h-full bg-white relative overflow-hidden">
      <div className={`flex-col bg-white border-r border-slate-200 h-full w-full md:w-80 flex-shrink-0 ${selectedChatId ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-slate-100">
          <h2 className="text-lg font-black text-slate-800 mb-3 tracking-tighter uppercase">Mensajes</h2>
          <div className="relative">
             <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400" />
             <input type="text" placeholder="Buscar..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full bg-slate-50 border-none rounded-lg py-1.5 pl-8 text-xs outline-none font-bold" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.map(chat => (
            <div key={chat.id} onClick={() => setSelectedChatId(chat.id)} className={`p-4 border-b cursor-pointer transition-all ${selectedChatId === chat.id ? 'bg-brand-50 border-l-4 border-brand-600' : 'hover:bg-slate-50'}`}>
              <div className="flex justify-between items-start mb-1">
                <h3 className="font-bold text-sm truncate flex-1">{chat.clientName || 'Cliente'}</h3>
                {chat.unreadCount > 0 && <div className="bg-red-500 text-white text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center animate-pulse">{chat.unreadCount}</div>}
              </div>
              <div className="flex items-center justify-between">
                <SourceBadge source={chat.source} inboxName={chat.inboxName} />
                <span className="text-[8px] font-bold text-slate-400">{chat.messages?.[chat.messages.length - 1]?.timestamp}</span>
              </div>
              <p className="text-[10px] text-slate-400 mt-2 truncate font-medium">{chat.messages?.[chat.messages.length - 1]?.content || 'Sin mensajes'}</p>
            </div>
          ))}
        </div>
      </div>

      <div className={`flex-1 flex flex-col bg-[#f0f2f5] relative ${!selectedChatId ? 'hidden md:flex' : 'flex'}`}>
        {activeChat ? (
          <>
            <div className="h-16 px-6 flex items-center justify-between bg-white border-b shadow-sm z-10">
               <div className="flex items-center gap-4">
                 <button onClick={() => setSelectedChatId(null)} className="md:hidden p-2 text-slate-400"><ArrowLeft /></button>
                 <div className="w-10 h-10 rounded-full bg-brand-600 text-white flex items-center justify-center font-black text-lg">{(activeChat.clientName || 'S').charAt(0)}</div>
                 <div>
                   <h3 className="font-black text-sm text-slate-800 leading-tight">{activeChat.clientName || 'Cliente'}</h3>
                   <span className="text-[8px] font-black text-brand-600 uppercase bg-brand-50 px-1.5 rounded">{activeChat.leadStatus || 'NUEVO'}</span>
                 </div>
               </div>
               <div className="flex items-center gap-2">
                 {/* v5.3.36 Bot de WhatsApp: indicador por chat + botón para
                     pausar/reactivar. Solo se muestra si el bot está activo
                     globalmente; si está pausado, el bot no responde en este
                     chat hasta que alguien lo reactive aquí. */}
                 {activeChat.botEnabled && (
                   <button onClick={toggleBot} disabled={botBusy} title={activeChat.botPaused ? 'El bot está pausado en este chat: pulsa para reactivarlo' : 'El bot está activo en este chat: pulsa para pausarlo'}
                     className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-[10px] font-black uppercase transition-all disabled:opacity-50 ${activeChat.botPaused ? 'bg-slate-50 text-slate-500 border-slate-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                     {botBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />} <span>{activeChat.botPaused ? 'Bot pausado' : 'Bot activo'}</span>
                   </button>
                 )}
                 <button onClick={() => setShowMobileSidebar(true)} className="xl:hidden p-2 text-brand-600 bg-brand-50 rounded-xl border border-brand-100 flex items-center gap-2 px-3">
                   <ClipboardList className="w-4 h-4" /> <span className="text-[10px] font-black uppercase">Info</span>
                 </button>
               </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
               {/* v5.3.30: cargar el historial hacia atrás (la lista solo trae los últimos 50 por conversación). */}
               {detailHasMore && (
                 <div className="flex justify-center">
                   <button onClick={loadOlderMessages} disabled={loadingOlder} className="text-[10px] font-black uppercase tracking-wide text-brand-600 bg-brand-50 hover:bg-brand-100 border border-brand-100 rounded-full px-4 py-1.5 disabled:opacity-50">
                     {loadingOlder ? 'Cargando…' : 'Cargar mensajes anteriores'}
                   </button>
                 </div>
               )}
               {openMessages.map((msg) => (
                 <div key={msg.id} className={`flex ${msg.sender === 'client' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[75%] rounded-2xl p-3 shadow-sm text-sm relative group ${msg.sender === 'client' ? 'bg-white rounded-tl-none' : 'bg-[#dcf8c6] rounded-tr-none'}`}>
                        {msg.attachmentUrl ? (
                           <div>
                             <div className="relative">
                               {msg.type === 'audio' ? <audio controls src={msg.attachmentUrl} className="h-10 w-full" /> :
                                msg.type === 'video' ? <video controls preload="metadata" src={msg.attachmentUrl} className="max-h-72 rounded-xl w-full bg-black" /> :
                                msg.type === 'document' || msg.type === 'file' ? (
                                  // v5.3.25 (M13): el enlace solo se renderiza si la URL es
                                  // segura (/uploads/ o https://); nunca javascript: ni rutas
                                  // fuera del CRM. Y rel con noopener.
                                  isSafeUrl(msg.attachmentUrl) ? (
                                    <a href={msg.attachmentUrl} target="_blank" rel="noopener noreferrer" download className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 transition-colors">
                                      <FileText className="w-5 h-5 text-brand-600" /> <span className="truncate">Descargar documento</span> <Download className="w-4 h-4 ml-auto flex-shrink-0" />
                                    </a>
                                  ) : (
                                    <span className="flex items-center gap-2 bg-slate-100 rounded-xl px-3 py-2 text-xs font-bold text-slate-500">
                                      <FileText className="w-5 h-5 text-slate-400" /> <span className="truncate">Documento no disponible</span>
                                    </span>
                                  )
                                ) : (
                                  <>
                                    {isSafeImageSrc(msg.attachmentUrl) ? (
                                      <img src={msg.attachmentUrl} className="max-h-72 rounded-xl object-cover cursor-pointer hover:brightness-95" />
                                    ) : null}
                                    <button onClick={() => toggleImageSelection(msg.attachmentUrl!)} className={`absolute bottom-2 right-2 p-2 rounded-full shadow-xl transition-all ${techImages.includes(msg.attachmentUrl!) ? 'bg-red-500 text-white' : 'bg-white text-brand-600 opacity-0 group-hover:opacity-100 scale-90 hover:scale-100'}`}>
                                      {techImages.includes(msg.attachmentUrl!) ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                                    </button>
                                  </>
                               )}
                             </div>
                             {msg.content && !MEDIA_LABELS.includes(msg.content) && <p className="leading-relaxed whitespace-pre-wrap mt-2">{msg.content}</p>}
                           </div>
                        ) : <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>}
                        <div className="text-[8px] text-right mt-1 opacity-40 font-black">{msg.timestamp}</div>
                    </div>
                 </div>
               ))}
               <div ref={chatEndRef} />
            </div>

            {readOnly ? (
              <div className="p-4 bg-amber-50 border-t border-amber-200">
                <p className="text-center text-[11px] font-black uppercase tracking-widest text-amber-700">Solo lectura: mensajes de tus servicios asignados</p>
              </div>
            ) : (
            <div className="p-4 bg-white border-t border-slate-200">
               {attachFile && (
                 <div className="max-w-5xl mx-auto mb-3 flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                   {attachPreview ? <img src={attachPreview} className="w-10 h-10 rounded-lg object-cover" /> : <FileText className="w-5 h-5 text-brand-600 flex-shrink-0" />}
                   <span className="text-xs font-bold text-slate-700 truncate flex-1">{attachFile.name} ({(attachFile.size / 1024).toFixed(0)} KB)</span>
                   <button onClick={clearAttachment} className="p-1 text-slate-400 hover:text-red-500"><X className="w-4 h-4" /></button>
                 </div>
               )}
               {attachError && <p className="max-w-5xl mx-auto mb-2 text-[11px] font-bold text-red-600">{attachError}</p>}
               <div className="flex items-center gap-3 max-w-5xl mx-auto">
                  <button onClick={() => setShowTemplates(!showTemplates)} className="p-2 text-slate-400 hover:text-amber-600 transition-colors"><Zap className={`w-5 h-5 ${showTemplates ? 'text-amber-600' : ''}`} /></button>
                  <input ref={fileInputRef} type="file" accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" className="hidden" onChange={e => handleAttachFile(e.target.files?.[0] || null)} />
                  <button onClick={() => fileInputRef.current?.click()} title="Adjuntar foto, audio, video o documento (máx. 25 MB)" className="p-2 text-slate-400 hover:text-brand-600 transition-colors"><Paperclip className="w-5 h-5" /></button>
                  <div className="flex-1 relative">
                    {showTemplates && (
                      <div className="absolute bottom-full left-0 mb-4 w-64 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-50">
                         <div className="p-3 bg-slate-50 border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase">Plantillas</div>
                         <div className="max-h-60 overflow-y-auto">
                            {templates.map(tpl => (
                              <button key={tpl.id} onClick={() => { setMessageText(prev => prev + (prev ? '\n' : '') + tpl.content); setShowTemplates(false); }} className="w-full text-left p-4 hover:bg-brand-50 border-b border-slate-50 transition-colors">
                                <p className="font-black text-xs text-slate-800">{tpl.title}</p>
                                <p className="text-[10px] text-slate-400 truncate mt-1">{tpl.content}</p>
                              </button>
                            ))}
                         </div>
                      </div>
                    )}
                    <textarea value={messageText} onChange={e => setMessageText(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSendMessage())} placeholder="Escribe un mensaje..." rows={1} className="w-full bg-slate-50 rounded-2xl px-5 py-3 border-none outline-none text-sm font-medium resize-none shadow-inner" />
                  </div>
                  <button onClick={handleSendMessage} disabled={(!messageText.trim() && !attachFile) || isUploading} className="p-3 bg-brand-600 text-white rounded-full shadow-lg hover:bg-brand-700 active:scale-95 transition-all disabled:opacity-50">{isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}</button>
               </div>
            </div>)}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-200 p-10 text-center">
            <MessageCircle className="w-24 h-24 opacity-10" />
            <h3 className="font-black uppercase tracking-widest text-[10px] mt-6 text-slate-400">Selecciona una conversación</h3>
          </div>
        )}
      </div>

      {showMobileSidebar && (
        <div className="fixed inset-0 z-[60] xl:hidden flex justify-end">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowMobileSidebar(false)}></div>
          <div className="relative w-[85%] max-w-[340px] h-full bg-white shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
            {renderSidebarContent()}
          </div>
        </div>
      )}

      <div className="w-[340px] border-l border-slate-200 bg-white hidden xl:flex flex-col relative overflow-hidden">
        {renderSidebarContent()}
      </div>
    </div>
  );
};
