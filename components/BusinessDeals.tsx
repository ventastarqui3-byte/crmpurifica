
import React, { useState, useMemo, useEffect } from 'react';
import { ServiceRecord, DealStatus, StaffMember, CurrentUser, StatsOverview } from '../types';
import { formatCurrency } from '../lib/format';
import { apiFetch } from '../lib/api';
import {Lock, CheckCircle, XCircle, Clock, DollarSign, Search, ChevronRight, Calendar, User, Filter, MapPin, MessageCircle, X, RefreshCw, Save} from 'lucide-react';

interface BusinessDealsProps {
  services: ServiceRecord[];
  totalServices: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  onSearchChange: (search: string) => void;
  onFiltersChange: (filters: any) => void;
  staff: StaffMember[];
  onUpdateStatus: (id: string, status: DealStatus, reason?: string, newDate?: string, newTime?: string) => void;
  onEditService: (service: ServiceRecord) => void;
  onChat: (phone: string) => void;
  currentUser: CurrentUser;
}

const STAGES = [
  { id: DealStatus.SCHEDULED, label: 'Agendados', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: Clock },
  { id: DealStatus.CONFIRMED, label: 'Confirmados', color: 'bg-purple-100 text-purple-700 border-purple-200', icon: CheckCircle },
  { id: DealStatus.RESCHEDULED, label: 'Reagendados', color: 'bg-brand-100 text-brand-700 border-brand-200', icon: RefreshCw },
  { id: DealStatus.DONE, label: 'Realizados', color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: DollarSign },
  { id: DealStatus.PAID, label: 'Pagados', color: 'bg-slate-800 text-white border-slate-900', icon: Lock },
  { id: DealStatus.CANCELLED, label: 'Cancelados', color: 'bg-red-100 text-red-700 border-red-200', icon: XCircle }
];

export const BusinessDeals: React.FC<BusinessDealsProps> = ({ 
  services, totalServices, currentPage, onPageChange, onSearchChange, onFiltersChange,
  staff, onUpdateStatus, onEditService, onChat, currentUser 
}) => {
  const isAdvisor = currentUser.role === 'advisor';

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  // Advanced Filter States
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedAdvisor, setSelectedAdvisor] = useState(isAdvisor ? currentUser.name : 'all');
  const [selectedLocation, setSelectedLocation] = useState('all');

  // Modal states
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [modalType, setModalType] = useState<'CANCEL' | 'RESCHEDULE' | null>(null);
  const [activeDealId, setActiveDealId] = useState<string | null>(null);
  const [modalReason, setModalReason] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');
  const [modalError, setModalError] = useState('');

  useEffect(() => {
    onFiltersChange({
      dealStatus: selectedStatus,
      startDate,
      endDate,
      location: selectedLocation,
      staff: selectedAdvisor,
      payment: 'all', // Negocios no tiene filtro de pago en la UI: antes llegaba undefined y el backend filtraba payment_method='undefined' (0 servicios)
    });
    onPageChange(1);
  }, [selectedStatus, startDate, endDate, selectedLocation, selectedAdvisor]);

  // Totales globales del servidor (toda la base, sin filtros ni límite
  // de 50): los totales por columna de la página solo describen lo
  // visible, no el negocio entero.
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  useEffect(() => {
    apiFetch('/api/stats/overview?timeRange=all').then(res => { if (!res.ok) throw new Error('overview'); return res.json(); }).then(setOverview).catch(console.error);
  }, []);
  const globalByStatus = useMemo(() => {
    const map = new Map<string, { count: number; totalValue: number }>();
    (overview?.servicesByStatus || []).forEach(s => map.set(s.status, { count: s.count, totalValue: s.totalValue }));
    return map;
  }, [overview]);



  const locations = useMemo(() => {
    const locs = new Set(services.map(s => s.neighborhood).filter(Boolean));
    return Array.from(locs).sort();
  }, [services]);

  const handleSearch = (val: string) => {
    setSearchTerm(val);
    onSearchChange(val);
    onPageChange(1);
  };

  const handleDragStart = (e: React.DragEvent, dealId: string) => {
    e.dataTransfer.setData('text/plain', dealId);
  };

  const handleDrop = (e: React.DragEvent, targetStage: DealStatus) => {
    e.preventDefault();
    const dealId = e.dataTransfer.getData('text/plain');
    if (!dealId) return;

    if (targetStage === DealStatus.CANCELLED) {
      setActiveDealId(dealId);
      setModalType('CANCEL');
      setShowReasonModal(true);
    } else if (targetStage === DealStatus.RESCHEDULED) {
      setActiveDealId(dealId);
      setModalType('RESCHEDULE');
      setShowReasonModal(true);
    } else {
      onUpdateStatus(dealId, targetStage);
    }
  };

  const submitModal = () => {
    if (!activeDealId || !modalType) return;
    if (modalType === 'CANCEL') {
      onUpdateStatus(activeDealId, DealStatus.CANCELLED, modalReason);
    } else if (modalType === 'RESCHEDULE') {
      // Sin fecha/hora el servidor ponía la fecha en NULL y el servicio
      // perdía su fecha: se exige la nueva fecha y hora antes de enviar.
      if (!newDate || !newTime) {
        setModalError('Elige la nueva fecha y la nueva hora para reagendar. Sin ellas el servicio quedaría sin fecha.');
        return;
      }
      onUpdateStatus(activeDealId, DealStatus.RESCHEDULED, modalReason, newDate, newTime);
    }
    closeModal();
  };

  const closeModal = () => {
    setShowReasonModal(false);
    setModalType(null);
    setActiveDealId(null);
    setModalReason('');
    setNewDate('');
    setNewTime('');
    setModalError('');
  };

  const renderFilters = () => (
    <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 mb-6 space-y-4 animate-in slide-in-from-top-4 duration-500">
       <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-brand-600" />
            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Panel de Control de Negocios</h3>
          </div>
          <button 
            onClick={() => {
              setSearchTerm('');
              setSelectedStatus('all');
              setSelectedAdvisor(isAdvisor ? currentUser.name : 'all');
              setSelectedLocation('all');
              setStartDate('');
              setEndDate('');
              onSearchChange('');
            }}
            className="text-[9px] font-black text-slate-400 uppercase hover:text-red-500 transition-colors flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Limpiar filtros
          </button>
       </div>
       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4">
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Etapa Negocio</label>
             <select value={selectedStatus} onChange={e => setSelectedStatus(e.target.value)} className="w-full text-xs font-black bg-brand-50 border-brand-100 text-brand-700 rounded-xl p-2.5 outline-none shadow-inner">
                <option value="all">Todas las etapas</option>
                {STAGES.map(s => <option key={s.id} value={s.id}>{s.label.toUpperCase()}</option>)}
             </select>
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Fecha Inicio</label>
             <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Fecha Fin</label>
             <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Asesor</label>
             <select 
               value={isAdvisor ? currentUser.name : selectedAdvisor} 
               disabled={isAdvisor}
               onChange={e => setSelectedAdvisor(e.target.value)} 
               className={`w-full text-xs font-bold border-none rounded-xl p-2.5 outline-none ${isAdvisor ? 'bg-slate-100 text-slate-500' : 'bg-slate-50'}`}
             >
                {!isAdvisor && <option value="all">Todos los asesores</option>}
                {staff.filter(s => s.role !== 'operator').map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
             </select>
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Zona/Barrio</label>
             <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none">
                <option value="all">Todas las zonas</option>
                {locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
             </select>
          </div>
          <div className="flex items-end">
             <div className="w-full bg-slate-900 rounded-xl p-2 flex items-center justify-center gap-2">
                <span className="text-[10px] font-black text-white uppercase">{services.length}</span>
                <span className="text-[8px] font-bold text-slate-400 uppercase">Filtrados</span>
             </div>
          </div>
       </div>
    </div>
  );

  const renderCanvas = () => {
    const stagesToShow = selectedStatus === 'all' 
      ? STAGES 
      : STAGES.filter(s => s.id === selectedStatus);

    return (
      <div className="flex gap-4 overflow-x-auto pb-6">
        {stagesToShow.map(stage => {
          const stageServices = services.filter(d => (d.dealStatus || DealStatus.SCHEDULED) === stage.id);
          const columnTotalValue = stageServices.reduce((acc, curr) => acc + (Number(curr.totalValue) || 0), 0);

          return (
            <div 
              key={stage.id} 
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => handleDrop(e, stage.id as DealStatus)}
              className="flex-1 min-w-[320px] rounded-[2.5rem] border bg-slate-100/30 border-slate-200 flex flex-col h-[75vh] animate-in fade-in zoom-in-95 duration-300"
            >
              <div className="p-5 border-b flex flex-col gap-2 bg-white rounded-t-[2.5rem] shadow-sm">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <stage.icon className="w-4 h-4 text-slate-400" />
                    <span className={`text-[9px] font-black uppercase px-2 py-1 rounded-md border ${stage.color}`}>{stage.label}</span>
                  </div>
                  <span className="text-xs font-black text-slate-400 bg-slate-100 px-3 py-1 rounded-full" title="Servicios de esta etapa en la página cargada (50 máx.)">{stageServices.length} en página</span>
                </div>
                
                <div className="flex flex-col gap-0.5 px-1">
                   <div className="flex items-center gap-1.5">
                     <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">En página:</span>
                     <span className="text-sm font-black text-brand-600">{formatCurrency(columnTotalValue)}</span>
                   </div>
                   {globalByStatus.get(stage.id) && (
                     <div className="flex items-center gap-1.5">
                       <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Global:</span>
                       <span className="text-xs font-black text-slate-500">{globalByStatus.get(stage.id)!.count} servicios · {formatCurrency(globalByStatus.get(stage.id)!.totalValue)}</span>
                     </div>
                   )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {stageServices.map(deal => (
                  <div 
                    key={deal.id} 
                    draggable
                    onDragStart={(e) => handleDragStart(e, deal.id)}
                    className="bg-white p-5 rounded-3xl border-2 border-white hover:border-brand-300 shadow-sm cursor-grab active:cursor-grabbing hover:shadow-xl transition-all group relative overflow-hidden"
                  >
                    <div className="flex justify-between items-start mb-3">
                      <h4 className="font-black text-slate-800 text-sm truncate flex-1 leading-tight group-hover:text-brand-600">{deal.clientName}</h4>
                      <span className="text-[10px] font-black text-brand-500 bg-brand-50 px-2 rounded-full">{formatCurrency(Number(deal.totalValue) || 0)}</span>
                    </div>
                    <div className="space-y-2 text-[11px] text-slate-500 font-bold">
                      <div className="flex items-center gap-2"><Calendar className="w-3.5 h-3.5 text-slate-300" /> {deal.date} | {deal.time}</div>
                      <div className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-slate-300" /> {deal.neighborhood || 'Sin ubicación'}</div>
                    </div>

                    {deal.dealStatus === DealStatus.CANCELLED && deal.cancellationReason && (
                      <div className="mt-3 bg-red-50 p-2.5 rounded-xl border border-red-100">
                        <p className="text-[9px] font-black text-red-600 uppercase tracking-tighter mb-1">Motivo Cancelación:</p>
                        <p className="text-[10px] font-bold text-red-700 italic leading-tight">{deal.cancellationReason}</p>
                      </div>
                    )}

                    {deal.dealStatus === DealStatus.RESCHEDULED && (
                      <div className="mt-3 bg-brand-50 p-2.5 rounded-xl border border-brand-100">
                         <p className="text-[9px] font-black text-brand-600 uppercase tracking-tighter mb-1">Reagendado ({deal.rescheduleCount || 1}):</p>
                         <p className="text-[10px] font-bold text-brand-700 italic leading-tight">{deal.observations || 'Esperando nueva fecha...'}</p>
                      </div>
                    )}

                    <div className="mt-4 pt-4 border-t border-slate-50 flex items-center justify-between">
                       <div className="flex items-center gap-1.5 text-[9px] font-black text-slate-400 uppercase">
                          <User className="w-3 h-3" /> {deal.advisor || 'S.A.'}
                       </div>
                       <div className="flex items-center gap-2">
                          <button onClick={() => onChat(deal.clientPhone)} title="Chatear con cliente" className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 border border-emerald-100 transition-all">
                             <MessageCircle className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => onEditService(deal)} title="Gestionar negocio" className="text-[9px] font-black text-brand-600 uppercase flex items-center gap-1">
                             Gestionar <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                       </div>
                    </div>
                  </div>
                ))}
                {stageServices.length === 0 && <div className="py-10 text-center text-slate-300 font-black text-[10px] uppercase opacity-50">Sin registros</div>}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">Gestión de Negocios</h1>
          <p className="text-slate-500 font-medium">Control comercial y seguimiento de cierres</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
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
          <span>{overview.revenue.totalServices} servicios</span>
          <span>Pagado: {formatCurrency(overview.revenue.grossIncome)}</span>
          <span>Clientes: {overview.clientsCount}</span>
          {overview.lossReasons.length > 0 && (
            <span className="text-red-300">Pérdidas/cancelaciones: {overview.lossReasons.reduce((a, r) => a + r.count, 0)} ({overview.lossReasons.slice(0, 2).map(r => `${r.reason} ×${r.count}`).join(', ')})</span>
          )}
        </div>
      )}

      {renderCanvas()}

      {showReasonModal && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
           <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-300">
              <div className={`p-6 border-b flex items-center justify-between ${modalType === 'CANCEL' ? 'bg-red-50' : 'bg-brand-50'}`}>
                 <h3 className={`text-lg font-black uppercase tracking-tight ${modalType === 'CANCEL' ? 'text-red-600' : 'text-brand-600'}`}>
                    {modalType === 'CANCEL' ? 'Cancelar Servicio' : 'Reagendar Servicio'}
                 </h3>
                 <button onClick={closeModal} className="text-slate-400 hover:text-slate-600"><X className="w-6 h-6" /></button>
              </div>
              <div className="p-8 space-y-6">
                 <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Motivo / Observación</label>
                    <textarea 
                      value={modalReason} 
                      onChange={e => setModalReason(e.target.value)}
                      placeholder={modalType === 'CANCEL' ? "Ej: Cliente no estará en casa..." : "Ej: Cliente solicita cambio por lluvia..."}
                      className="w-full bg-slate-50 border border-slate-100 rounded-2xl p-4 text-sm font-medium outline-none focus:bg-white focus:border-brand-300 h-32 resize-none shadow-inner"
                    />
                 </div>

                 {modalType === 'RESCHEDULE' && (
                    <div className="grid grid-cols-2 gap-4 animate-in slide-in-from-top-4">
                       <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Nueva Fecha *</label>
                          <input type="date" value={newDate} onChange={e => { setNewDate(e.target.value); setModalError(''); }} className="w-full bg-slate-50 border border-slate-100 rounded-xl p-3 text-xs font-bold outline-none" />
                       </div>
                       <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Nueva Hora *</label>
                          <input type="time" value={newTime} onChange={e => { setNewTime(e.target.value); setModalError(''); }} className="w-full bg-slate-50 border border-slate-100 rounded-xl p-3 text-xs font-bold outline-none" />
                       </div>
                    </div>
                 )}

                 {modalError && (
                   <p className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl text-xs font-bold">{modalError}</p>
                 )}

                 <button 
                   onClick={submitModal}
                   className={`w-full py-4 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-xl flex items-center justify-center gap-2 transition-all active:scale-95 ${modalType === 'CANCEL' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-brand-600 text-white hover:bg-brand-700'}`}
                 >
                    <Save className="w-4 h-4" /> Finalizar Gestión
                 </button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};
