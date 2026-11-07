
import React, { useState, useMemo, useEffect } from 'react';
import { LeadRecord, LeadStatus, StaffMember, CurrentUser, StatsOverview } from '../types';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';
import {Search, TrendingUp, Clock, CheckCircle, XCircle, Phone, MapPin, User, ChevronRight, Filter, Calendar, Grid, List, CalendarDays, ChevronLeft, AlertTriangle, Timer, MessageCircle, Edit3, X, Zap, Instagram, Facebook, Globe} from 'lucide-react';

interface LeadPipelineProps {
  leads: LeadRecord[];
  totalLeads: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  onSearchChange: (search: string) => void;
  onFiltersChange: (filters: any) => void;
  staff: StaffMember[];
  onUpdateStatus: (id: string, status: LeadStatus, isConvId: boolean, reason?: string) => void;
  onEditLead: (lead: LeadRecord) => void;
  onChat: (phone: string) => void;
  currentUser: CurrentUser;
}

type ViewMode = 'kanban' | 'grid' | 'calendar';

const STAGES = [
  { id: LeadStatus.NEW, label: 'Nuevos', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: Clock },
  { id: LeadStatus.QUOTED, label: 'Cotizados', color: 'bg-amber-100 text-amber-700 border-amber-200', icon: TrendingUp },
  { id: LeadStatus.PENDING_DECISION, label: 'En Decisión', color: 'bg-purple-100 text-purple-700 border-purple-200', icon: Phone },
  { id: LeadStatus.SCHEDULED, label: 'Agendados', color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: CheckCircle },
  { id: LeadStatus.NOT_INTERESTED, label: 'No interesados', color: 'bg-slate-100 text-slate-500 border-slate-200', icon: XCircle },
  { id: LeadStatus.OUT_OF_COVERAGE, label: 'Fuera de cobertura', color: 'bg-slate-100 text-slate-500 border-slate-200', icon: XCircle },
  { id: LeadStatus.LOST, label: 'Perdidos', color: 'bg-slate-100 text-slate-600 border-slate-200', icon: XCircle }
];

export const LeadPipeline: React.FC<LeadPipelineProps> = ({ 
  leads, totalLeads, currentPage, onPageChange, onSearchChange, onFiltersChange,
  staff, onUpdateStatus, onEditLead, onChat, currentUser 
}) => {
  const isAdvisor = currentUser.role === 'advisor';
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedAdvisor, setSelectedAdvisor] = useState<string>(isAdvisor ? currentUser.name : 'all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedSource, setSelectedSource] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [now, setNow] = useState(new Date());
  
  // Advanced Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [minPrice, setMinPrice] = useState<number | ''>('');
  const [maxPrice, setMaxPrice] = useState<number | ''>('');
  const [selectedLocation, setSelectedLocation] = useState('all');

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  // Totales globales del servidor (toda la base, sin límite de 50): los
  // conteos por columna del kanban solo describen la página cargada.
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  useEffect(() => {
    apiFetch('/api/stats/overview?timeRange=all').then(res => { if (!res.ok) throw new Error('overview'); return res.json(); }).then(setOverview).catch(console.error);
  }, []);
  const globalByStage = useMemo(() => {
    const map = new Map<string, { count: number; estimatedValue: number }>();
    (overview?.leadsByStage || []).forEach(s => map.set(s.status, { count: s.count, estimatedValue: s.estimatedValue }));
    return map;
  }, [overview]);

  useEffect(() => {
    onFiltersChange({
      status: selectedStatus,
      startDate,
      endDate,
      location: selectedLocation,
      source: selectedSource,
      minPrice,
      maxPrice,
      advisor: selectedAdvisor
    });
    onPageChange(1);
  }, [selectedStatus, startDate, endDate, selectedLocation, selectedSource, minPrice, maxPrice, selectedAdvisor]);

  const totalPages = Math.ceil(totalLeads / 50);

  const locations = useMemo(() => {
    const locs = new Set(leads.map(l => l.location).filter(Boolean));
    return Array.from(locs);
  }, [leads]);

  const sources = useMemo(() => {
    const srs = new Set(leads.map(l => l.source).filter(Boolean));
    return Array.from(srs);
  }, [leads]);

  const handleSearch = (val: string) => {
    setSearchTerm(val);
    onSearchChange(val);
    onPageChange(1);
  };

  const handleDragStart = (e: React.DragEvent, leadId: string) => {
    e.dataTransfer.setData('text/plain', leadId);
  };

  const handleDrop = (e: React.DragEvent, targetStage: LeadStatus) => {
    e.preventDefault();
    const leadId = e.dataTransfer.getData('text/plain');
    if (leadId) onUpdateStatus(leadId, targetStage, false);
  };

  const getResponseTime = (assignedAt?: string) => {
    if (!assignedAt) return null;
    const diff = now.getTime() - new Date(assignedAt).getTime();
    const mins = Math.floor(diff / 60000);
    return mins;
  };

  const clearFilters = () => {
    setSearchTerm('');
    setSelectedAdvisor(isAdvisor ? currentUser.name : 'all');
    setSelectedStatus('all');
    setSelectedSource('all');
    setStartDate('');
    setEndDate('');
    setMinPrice('');
    setMaxPrice('');
    setSelectedLocation('all');
    onSearchChange('');
  };

  const renderFilters = () => (
    <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 mb-6 space-y-4 animate-in slide-in-from-top-4 duration-500">
       <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-brand-600" />
            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Panel de Filtros Avanzados (Leads)</h3>
          </div>
          <button onClick={clearFilters} className="text-[9px] font-black text-slate-400 uppercase hover:text-red-500 transition-colors flex items-center gap-1.5">
            <X className="w-3 h-3" /> Limpiar Filtros
          </button>
       </div>
       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Estado Prospecto</label>
             <select value={selectedStatus} onChange={e => setSelectedStatus(e.target.value)} className="w-full text-xs font-black bg-brand-50 border-brand-100 text-brand-700 rounded-xl p-2.5 outline-none focus:ring-2 focus:ring-brand-500/20 shadow-inner">
                <option value="all">Ver todos los estados</option>
                {STAGES.map(s => <option key={s.id} value={s.id}>{s.label.toUpperCase()}</option>)}
             </select>
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Fecha Inicio</label>
             <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Fecha Fin</label>
             <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Ubicación</label>
             <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none">
                <option value="all">Todas las zonas</option>
                {locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
             </select>
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Fuente</label>
             <select value={selectedSource} onChange={e => setSelectedSource(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none">
                <option value="all">Cualquier origen</option>
                {sources.map(src => <option key={src} value={src}>{src?.toUpperCase()}</option>)}
             </select>
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Valor Min.</label>
             <input type="number" value={minPrice} onChange={e => setMinPrice(e.target.value === '' ? '' : Number(e.target.value))} placeholder="$" className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Valor Max.</label>
             <input type="number" value={maxPrice} onChange={e => setMaxPrice(e.target.value === '' ? '' : Number(e.target.value))} placeholder="$" className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Asesor</label>
             <select 
               value={isAdvisor ? currentUser.name : selectedAdvisor} 
               disabled={isAdvisor}
               onChange={e => setSelectedAdvisor(e.target.value)} 
               className={`w-full text-xs font-bold border-none rounded-xl p-2.5 outline-none ${isAdvisor ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : 'bg-slate-50'}`}
             >
                {!isAdvisor && <option value="all">Todos los asesores</option>}
                {staff.filter(s => s.role !== 'operator').map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
             </select>
          </div>
       </div>
    </div>
  );

  const renderKanban = () => {
    const stagesToShow = selectedStatus === 'all' 
      ? STAGES 
      : STAGES.filter(s => s.id === selectedStatus);

    return (
      <div className="flex gap-4 overflow-x-auto pb-6">
        {stagesToShow.map(stage => {
          const stageLeads = leads.filter(l => l.status === stage.id);
          return (
            <div 
              key={stage.id} 
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => handleDrop(e, stage.id as LeadStatus)}
              className="flex-1 min-w-[320px] rounded-[2.5rem] border bg-slate-100/30 border-slate-200 flex flex-col h-[75vh] animate-in fade-in zoom-in-95 duration-300"
            >
              <div className="p-5 border-b flex justify-between items-center bg-white rounded-t-[2.5rem] shadow-sm">
                <div className="flex items-center gap-2">
                  <stage.icon className="w-4 h-4 text-slate-400" />
                  <span className={`text-[9px] font-black uppercase px-2 py-1 rounded-md border ${stage.color}`}>{stage.label}</span>
                </div>
                <span className="text-xs font-black text-slate-400 bg-slate-100 px-3 py-1 rounded-full" title="En la página cargada (50 máx.) / global en toda la base">{stageLeads.length} en pág. · {globalByStage.get(stage.id)?.count ?? '…'} global</span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {stageLeads.map(lead => {
                  const responseMins = getResponseTime(lead.assignedAt);
                  const isUrgent = stage.id === LeadStatus.NEW && responseMins !== null && responseMins >= 7;
                  const isOverdue = stage.id === LeadStatus.NEW && responseMins !== null && responseMins >= 10;

                  return (
                    <div 
                      key={lead.id} 
                      draggable
                      onDragStart={(e) => handleDragStart(e, lead.id)}
                      onDoubleClick={() => onEditLead(lead)}
                      className={`bg-white p-5 rounded-3xl border-2 transition-all group relative overflow-hidden shadow-sm hover:shadow-xl ${isOverdue ? 'border-red-500 animate-pulse' : isUrgent ? 'border-orange-400' : 'border-white hover:border-brand-300'}`}
                    >
                      {isUrgent && (
                        <div className={`absolute top-0 left-0 w-full py-1 text-[8px] font-black uppercase tracking-widest text-center flex items-center justify-center gap-1.5 ${isOverdue ? 'bg-red-500 text-white' : 'bg-orange-400 text-white'}`}>
                          <AlertTriangle className="w-3 h-3" /> {isOverdue ? 'Reasignación Inminente' : 'Atención Requerida'}
                        </div>
                      )}
                      
                      <div className={`flex justify-between items-start mb-3 ${isUrgent ? 'mt-4' : ''}`}>
                        <h4 className="font-black text-slate-800 text-sm truncate flex-1 leading-tight group-hover:text-brand-600">{lead.clientName}</h4>
                        <span className="text-[10px] font-black text-brand-500 bg-brand-50 px-2 rounded-full">{formatCurrency(Number(lead.estimatedValue) || 0)}</span>
                      </div>
                      <div className="space-y-2 text-[11px] text-slate-500 font-bold">
                        <div className="flex items-center gap-2"><Phone className="w-3.5 h-3.5 text-slate-300" /> {lead.clientPhone}</div>
                        <div className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-slate-300" /> {lead.location || 'Pendiente'}</div>
                        {lead.source && (
                          <div className="flex items-center gap-2 pt-1">
                            {lead.source.includes('whatsapp') ? <Zap className="w-3 h-3 text-emerald-500" /> : 
                             lead.source.includes('instagram') ? <Instagram className="w-3 h-3 text-pink-500" /> : 
                             lead.source.includes('facebook') ? <Facebook className="w-3 h-3 text-blue-500" /> : <Globe className="w-3 h-3 text-slate-400" />}
                            <span className="text-[8px] font-black uppercase tracking-widest opacity-60">Fuente: {lead.source}</span>
                          </div>
                        )}
                      </div>

                      {stage.id === LeadStatus.NEW && responseMins !== null && (
                        <div className={`mt-3 p-2 rounded-xl border flex items-center justify-between ${isUrgent ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'}`}>
                           <div className="flex items-center gap-2">
                              <Timer className={`w-3.5 h-3.5 ${isUrgent ? 'text-red-500' : 'text-slate-400'}`} />
                              <span className={`text-[9px] font-black uppercase tracking-tighter ${isUrgent ? 'text-red-600' : 'text-slate-500'}`}>Espera:</span>
                           </div>
                           <span className={`text-[10px] font-black ${isUrgent ? 'text-red-600' : 'text-slate-700'}`}>{responseMins} min</span>
                        </div>
                      )}

                      <div className="mt-4 pt-4 border-t border-slate-50 flex items-center justify-between">
                         <div className="flex items-center gap-1.5 text-[9px] font-black text-slate-400 uppercase">
                            <User className="w-3 h-3" /> {lead.advisor || 'S.A.'}
                         </div>
                         <div className="flex items-center gap-2">
                            <button onClick={() => onChat(lead.clientPhone)} title="Chatear" className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 transition-all border border-emerald-100">
                               <MessageCircle className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => onEditLead(lead)} title="Editar lead" className="p-1.5 bg-brand-50 text-brand-600 rounded-lg hover:bg-brand-100 transition-all border border-brand-100">
                               <Edit3 className="w-3.5 h-3.5" />
                            </button>
                         </div>
                      </div>
                    </div>
                  );
                })}
                {stageLeads.length === 0 && <div className="py-10 text-center text-slate-300 font-black text-[10px] uppercase opacity-50">Vacío</div>}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderGrid = () => (
    <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-200 overflow-hidden animate-in fade-in duration-500">
       <div className="overflow-x-auto">
          <table className="w-full text-left">
             <thead className="bg-slate-50 border-b border-slate-100 text-[9px] font-black text-slate-400 uppercase tracking-widest">
                <tr>
                   <th className="px-8 py-5">Lead / Cliente</th>
                   <th className="px-8 py-5">Ubicación</th>
                   <th className="px-8 py-5">Fuente</th>
                   <th className="px-8 py-5">Estado / Espera</th>
                   <th className="px-8 py-5">Asesor</th>
                   <th className="px-8 py-5 text-right">Valor Est.</th>
                   <th className="px-8 py-5 text-center">Acciones</th>
                </tr>
             </thead>
             <tbody className="divide-y divide-slate-50">
                {leads.map(lead => {
                  const responseMins = getResponseTime(lead.assignedAt);
                  return (
                    <tr key={lead.id} className="hover:bg-brand-50/20 transition-colors group">
                       <td className="px-8 py-6">
                          <p className="font-black text-slate-800 text-sm">{lead.clientName}</p>
                          <p className="text-[10px] font-bold text-slate-400">{lead.clientPhone}</p>
                       </td>
                       <td className="px-8 py-6">
                          <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
                             <MapPin className="w-3.5 h-3.5 text-slate-300" /> {lead.location || 'Pendiente'}
                          </div>
                       </td>
                       <td className="px-8 py-6">
                          <span className="text-[10px] font-black uppercase text-slate-500 bg-slate-50 px-2 py-1 rounded border border-slate-100">
                            {lead.source || 'Manual'}
                          </span>
                       </td>
                       <td className="px-8 py-6">
                          <div className="flex items-center gap-4">
                            <span className={`text-[9px] font-black uppercase px-3 py-1 rounded-full border ${STAGES.find(s => s.id === lead.status)?.color}`}>
                               {lead.status.replace('_',' ')}
                            </span>
                            {lead.status === LeadStatus.NEW && responseMins !== null && (
                              <span className={`text-[10px] font-black ${responseMins >= 10 ? 'text-red-500' : 'text-slate-400'}`}>
                                {responseMins} min
                              </span>
                            )}
                          </div>
                       </td>
                       <td className="px-8 py-6 text-xs font-black text-slate-500 uppercase">{lead.advisor || 'S.A.'}</td>
                       <td className="px-8 py-6 text-right font-black text-slate-800">{formatCurrency(Number(lead.estimatedValue) || 0)}</td>
                       <td className="px-8 py-6 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button onClick={() => onChat(lead.clientPhone)} title="Chatear" className="p-2.5 bg-emerald-50 text-emerald-600 hover:bg-emerald-600 hover:text-white rounded-xl transition-all border border-emerald-100">
                               <MessageCircle className="w-4 h-4" />
                            </button>
                            <button onClick={() => onEditLead(lead)} title="Editar" className="p-2.5 bg-slate-100 text-slate-400 hover:bg-brand-600 hover:text-white rounded-xl transition-all border border-slate-200">
                               <Edit3 className="w-4 h-4" />
                            </button>
                          </div>
                       </td>
                    </tr>
                  );
                })}
             </tbody>
          </table>
       </div>
       
       <div className="bg-slate-50 p-4 border-t flex items-center justify-between">
           <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
              Mostrando {leads.length} de {totalLeads} prospectos
           </div>
           <div className="flex items-center gap-3">
              <button 
                disabled={currentPage === 1}
                onClick={() => onPageChange(currentPage - 1)}
                className="p-2 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-brand-600 disabled:opacity-30 disabled:hover:text-slate-400"
              >
                 <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-xs font-black text-slate-600">Página {currentPage} de {totalPages || 1}</span>
              <button 
                disabled={currentPage >= totalPages}
                onClick={() => onPageChange(currentPage + 1)}
                className="p-2 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-brand-600 disabled:opacity-30 disabled:hover:text-slate-400"
              >
                 <ChevronRight className="w-5 h-5" />
              </button>
           </div>
        </div>
    </div>
  );

  const renderCalendar = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    // Antes: siempre 31 días desde el día 1 bajo "Lun" (en febrero los días
    // 29-31 eran en realidad de marzo y casaban leads de marzo).
    const firstWeekdayOffset = (new Date(year, month, 1).getDay() + 6) % 7; // Lun=0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1));

    return (
      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-200 p-8 animate-in fade-in duration-500">
         <div className="flex justify-between items-center mb-8">
            <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight flex items-center gap-3">
               <CalendarDays className="w-6 h-6 text-brand-600" /> Leads de {today.toLocaleString('es-CO', { month: 'long', year: 'numeric' })}
            </h3>
         </div>
         <div className="grid grid-cols-7 gap-px bg-slate-200 rounded-3xl border border-slate-200 overflow-hidden shadow-inner">
            {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(d => (
              <div key={d} className="bg-slate-50 p-4 text-[10px] font-black text-slate-400 text-center uppercase tracking-widest">{d}</div>
            ))}
            {Array.from({ length: firstWeekdayOffset }).map((_, i) => (
              <div key={`empty-${i}`} className="bg-white min-h-[140px]" />
            ))}
            {days.map((day, i) => {
              const dayLeads = leads.filter(l => {
                // Igual que ServiceList (mediodía local): createdAt es un
                // timestamp y comparar con getDate() local lo desfasaba en
                // Bogotá. Se compara la fecha de calendario en Bogotá.
                const ldBogota = new Date(l.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
                const dayBogota = day.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
                return ldBogota === dayBogota;
              });
              return (
                <div key={i} className="bg-white min-h-[140px] p-3 hover:bg-slate-50 transition-colors group">
                   <span className="text-xs font-black text-slate-300 group-hover:text-brand-500 transition-colors">{day.getDate()}</span>
                   <div className="mt-2 space-y-1">
                      {dayLeads.slice(0, 3).map(l => (
                        <div key={l.id} onClick={() => onEditLead(l)} className="text-[9px] font-black bg-brand-50 text-brand-700 p-1.5 rounded-lg border border-brand-100 truncate cursor-pointer hover:bg-brand-100">
                           {l.clientName}
                        </div>
                      ))}
                      {dayLeads.length > 3 && <p className="text-[8px] font-black text-slate-400 text-center">+{dayLeads.length - 3} más</p>}
                   </div>
                </div>
              );
            })}
         </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">Pipeline de Ventas</h1>
          <p className="text-slate-500 font-medium">Control total sobre tus prospectos y cierres</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
           <div className="bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200 flex">
              <button onClick={() => setViewMode('kanban')} className={`p-2.5 rounded-xl transition-all ${viewMode === 'kanban' ? 'bg-brand-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}><Grid className="w-5 h-5" /></button>
              <button onClick={() => setViewMode('grid')} className={`p-2.5 rounded-xl transition-all ${viewMode === 'grid' ? 'bg-brand-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}><List className="w-5 h-5" /></button>
              <button onClick={() => setViewMode('calendar')} className={`p-2.5 rounded-xl transition-all ${viewMode === 'calendar' ? 'bg-brand-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}><Calendar className="w-5 h-5" /></button>
           </div>
           <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" placeholder="Buscar cliente..." value={searchTerm} onChange={e => handleSearch(e.target.value)} className="pl-12 pr-6 py-3 bg-white border border-slate-200 rounded-2xl text-sm font-bold shadow-sm outline-none focus:border-brand-500 w-64" />
           </div>
        </div>
      </div>

      {renderFilters()}

      {overview && (
        <div className="bg-slate-900 text-white px-6 py-4 rounded-[2rem] flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] font-bold">
          <span className="text-[9px] font-black uppercase tracking-widest text-brand-400">Totales globales (toda la base, sin filtros)</span>
          <span>{overview.leadsByStage.reduce((a, s) => a + s.count, 0)} leads</span>
          {overview.leadsByStage.map(s => (
            <span key={s.status}>{s.status.replace('_', ' ')}: {s.count}</span>
          ))}
          {overview.leadLossReasons.length > 0 && (
            <span className="text-red-300">Motivos de pérdida: {overview.leadLossReasons.slice(0, 3).map(r => `${r.reason} ×${r.count}`).join(', ')}</span>
          )}
        </div>
      )}

      {viewMode === 'kanban' && renderKanban()}
      {viewMode === 'grid' && renderGrid()}
      {viewMode === 'calendar' && renderCalendar()}
    </div>
  );
};
