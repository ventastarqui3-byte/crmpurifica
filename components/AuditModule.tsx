
import React, { useState, useMemo, useEffect } from 'react';
import {LeadRecord, ServiceRecord, StatsOverview} from '../types';
import {Search, Trash2, ShieldAlert, AlertTriangle, CheckCircle2, Database, User, Calendar, MapPin, X, History, ChevronRight} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';

interface AuditModuleProps {
  leads: LeadRecord[];
  services: ServiceRecord[];
  onRefresh: () => void;
}

export const AuditModule: React.FC<AuditModuleProps> = ({ leads, services, onRefresh }) => {
  const [searchTerm, setSearchTerm] = useState('');

  // Duplicados de TODA la base, del servidor (mismo teléfono y misma
  // fecha, sin CANCELADO). Antes se calculaban solo sobre la página de
  // 50 que llegaba por props, así que la mayoría no se veía.
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  useEffect(() => {
    apiFetch('/api/stats/overview?timeRange=all').then(res => { if (!res.ok) throw new Error('overview'); return res.json(); }).then(setOverview).catch(() => setOverviewFailed(true));
  }, []);

  // Respaldo si el endpoint falla: duplicados solo de la página cargada
  // (50 registros). Se etiqueta como tal en la UI, no como "sistema".
  const pageDuplicates = useMemo(() => {
    const registry: Record<string, { count: number, name: string, date: string }> = {};
    const dupeClients: Array<{ phone: string, name: string, date: string, count: number }> = [];

    services.forEach(s => {
      if (s.clientPhone && s.date && s.dealStatus !== 'CANCELADO') {
        const key = `${s.clientPhone}_${s.date}`;
        if (!registry[key]) {
          registry[key] = { count: 1, name: s.clientName, date: s.date };
        } else {
          registry[key].count++;
        }
      }
    });

    Object.entries(registry).forEach(([key, val]) => {
      if (val.count > 1) {
        const [phone] = key.split('_');
        dupeClients.push({ phone, name: val.name, date: val.date, count: val.count });
      }
    });

    return dupeClients;
  }, [services]);

  const systemWideDuplicates = overview ? overview.duplicates : pageDuplicates;

  const filteredItems = useMemo(() => {
    if (!searchTerm) return { leads: [], services: [] };
    
    const term = searchTerm.toLowerCase();
    const safeLeads = Array.isArray(leads) ? leads : [];
    const safeServices = Array.isArray(services) ? services : [];

    return {
      leads: safeLeads.filter(l => 
        (l.clientPhone || '').includes(term) || 
        (l.clientName || '').toLowerCase().includes(term)
      ),
      services: safeServices.filter(s => 
        (s.clientPhone || '').includes(term) || 
        (s.clientName || '').toLowerCase().includes(term)
      )
    };
  }, [leads, services, searchTerm]);

  // Detector de duplicados por fecha en los resultados actuales
  const duplicatesInSearch = useMemo(() => {
    const dates: Record<string, number> = {};
    const possible = new Set<string>();
    
    if (!filteredItems.services) return possible;

    filteredItems.services.forEach(s => {
      if (s.clientPhone && s.date && s.dealStatus !== 'CANCELADO') {
        const key = `${s.clientPhone}_${s.date}`;
        dates[key] = (dates[key] || 0) + 1;
        if (dates[key] > 1) possible.add(s.id);
      }
    });
    
    return possible;
  }, [filteredItems]);

  const handleDelete = async (type: 'lead' | 'service', id: string) => {
    if (!confirm(`¿Estás seguro de eliminar este ${type === 'lead' ? 'prospecto' : 'servicio'}? Esta acción es irreversible y limpiará la base de datos.`)) return;
    
    try {
      const endpoint = type === 'lead' ? `/api/leads/${id}` : `/api/services/${id}`;
      const res = await apiFetch(endpoint, { method: 'DELETE' });
      if (res.ok) {
        onRefresh();
      }
    } catch (e) {
      console.error(e);
      alert('Error de conexión al intentar eliminar el registro.');
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      <div className="bg-slate-900 rounded-[3rem] p-10 text-white relative overflow-hidden shadow-2xl">
         <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/10 blur-[100px] rounded-full translate-x-32 -translate-y-32" />
         <div className="relative z-10">
            <div className="flex items-center gap-4 mb-6">
               <div className="bg-red-500 p-4 rounded-3xl shadow-lg shadow-red-500/20">
                  <ShieldAlert className="w-8 h-8" />
               </div>
               <div>
                  <h1 className="text-3xl font-black tracking-tight">Consola de Auditoría</h1>
                  <p className="text-slate-400 font-medium">Depuración quirúrgica de duplicados y errores de base de datos</p>
               </div>
            </div>

            <div className="max-w-xl relative">
               <Search className="absolute left-6 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
               <input 
                 type="text" 
                 placeholder="Busca un cliente por nombre o teléfono para auditar..." 
                 value={searchTerm}
                 onChange={e => setSearchTerm(e.target.value)}
                 className="w-full pl-16 pr-6 py-5 bg-white/5 border-2 border-white/10 rounded-[2rem] text-lg font-bold outline-none focus:border-red-500/50 focus:bg-white/10 transition-all placeholder:text-slate-600"
               />
               {searchTerm && (
                 <button onClick={() => setSearchTerm('')} className="absolute right-6 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors">
                    <X className="w-6 h-6" />
                 </button>
               )}
            </div>
         </div>
      </div>

      {searchTerm ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
           {/* SECCIÓN LEADS */}
           <div className="space-y-6">
              <h3 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 flex items-center gap-2 px-4">
                 <History className="w-4 h-4 text-brand-500" /> Pipeline (Leads)
              </h3>
              <div className="space-y-4">
                 {filteredItems.leads.map(lead => (
                    <div key={lead.id} className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-md transition-all group">
                       <div className="flex justify-between items-start">
                          <div className="flex items-center gap-4">
                             <div className="w-12 h-12 bg-brand-50 rounded-2xl flex items-center justify-center font-black text-brand-600 uppercase">
                                {(lead.clientName || 'C').charAt(0)}
                             </div>
                             <div>
                                <h4 className="font-black text-slate-800">{lead.clientName || 'Sin Nombre'}</h4>
                                <p className="text-[10px] font-black uppercase text-slate-400">{lead.status || 'NUEVO'}</p>
                             </div>
                          </div>
                          <button 
                            onClick={() => handleDelete('lead', lead.id)}
                            className="p-3 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                          >
                             <Trash2 className="w-5 h-5" />
                          </button>
                       </div>
                       <div className="mt-4 pt-4 border-t border-slate-50 grid grid-cols-2 gap-4 text-[11px] font-bold text-slate-500">
                          <div className="flex items-center gap-2"><Calendar className="w-3.5 h-3.5" /> {lead.createdAt ? new Date(lead.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }) : 'S.F.'}</div>
                          <div className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5" /> {lead.location || 'S.A.'}</div>
                       </div>
                    </div>
                 ))}
                 {filteredItems.leads.length === 0 && (
                    <p className="text-center py-10 text-slate-300 font-bold italic">No hay leads para este criterio.</p>
                 )}
              </div>
           </div>

           {/* SECCIÓN SERVICIOS */}
           <div className="space-y-6">
              <h3 className="text-xs font-black uppercase tracking-[0.3em] text-slate-400 flex items-center gap-2 px-4">
                 <Database className="w-4 h-4 text-emerald-500" /> Historial de Servicios
              </h3>
              <div className="space-y-4">
                 {filteredItems.services.map(service => (
                    <div key={service.id} className={`bg-white p-6 rounded-[2.5rem] border-2 shadow-sm hover:shadow-md transition-all group ${duplicatesInSearch.has(service.id) ? 'border-amber-400' : 'border-slate-50'}`}>
                       <div className="flex justify-between items-start">
                          <div className="flex items-center gap-4">
                             <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black ${duplicatesInSearch.has(service.id) ? 'bg-amber-100 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                {service.id.slice(-4).toUpperCase()}
                             </div>
                             <div>
                                <div className="flex items-center gap-2">
                                   <h4 className="font-black text-slate-800">{service.date || 'Sin Fecha'}</h4>
                                   {duplicatesInSearch.has(service.id) && (
                                      <span className="bg-amber-500 text-white text-[8px] font-black px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse">
                                         <AlertTriangle className="w-2.5 h-2.5" /> POSIBLE DUPLICADO
                                      </span>
                                   )}
                                </div>
                                <p className="text-[10px] font-black uppercase text-slate-400">{service.dealStatus || 'SIN ESTADO'}</p>
                             </div>
                          </div>
                          <button 
                            onClick={() => handleDelete('service', service.id)}
                            className="p-3 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                          >
                             <Trash2 className="w-5 h-5" />
                          </button>
                       </div>
                       <div className="mt-4 pt-4 border-t border-slate-50 grid grid-cols-2 gap-4 text-[11px] font-bold text-slate-500">
                          <div className="flex items-center gap-2"><User className="w-3.5 h-3.5" /> {service.advisor || 'S.A.'}</div>
                          <div className="flex items-center gap-2 text-emerald-600 font-black"><CheckCircle2 className="w-3.5 h-3.5" /> {formatCurrency(Number(service.totalValue || 0))}</div>
                       </div>
                    </div>
                 ))}
                 {filteredItems.services.length === 0 && (
                    <p className="text-center py-10 text-slate-300 font-bold italic">No hay servicios para este criterio.</p>
                 )}
              </div>
           </div>
        </div>
      ) : (
        <div className="space-y-12">
          {/* LISTADO AUTOMÁTICO DE POSIBLES DUPLICADOS */}
          {systemWideDuplicates.length > 0 && (
            <div className="animate-in slide-in-from-bottom-8 duration-500">
               <div className="flex items-center gap-2 mb-6 px-4">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                  <h3 className="text-sm font-black uppercase tracking-[0.2em] text-slate-500">Detecciones de Alta Prioridad</h3>
               </div>
               <p className="text-[10px] font-bold text-slate-400 px-4 -mt-4 mb-6">
                 {overview
                   ? `Detectados en toda la base (${overview.revenue.totalServices} servicios en total, ${overview.clientsCount} clientes).`
                   : overviewFailed
                     ? 'El listado global no cargó: esto es solo lo de la página cargada (50 registros).'
                     : 'Cargando listado global…'}
               </p>
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {systemWideDuplicates.map((dupe, i) => (
                    <div 
                      key={i} 
                      onClick={() => setSearchTerm(dupe.phone)}
                      className="bg-white border-2 border-amber-100 p-6 rounded-[2.5rem] shadow-sm hover:shadow-xl hover:border-amber-300 transition-all cursor-pointer group relative overflow-hidden"
                    >
                       <div className="absolute top-0 right-0 bg-amber-500 text-white text-[8px] font-black px-3 py-1 rounded-bl-xl">
                          {dupe.count} REGISTROS
                       </div>
                       <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-amber-50 rounded-2xl flex items-center justify-center font-black text-amber-600">
                             {(dupe.name || '?').charAt(0)}
                          </div>
                          <div>
                             <h4 className="font-black text-slate-800 group-hover:text-amber-600 transition-colors">{dupe.name}</h4>
                             <p className="text-[10px] font-bold text-slate-400">{dupe.phone}</p>
                          </div>
                       </div>
                       <div className="mt-4 pt-4 border-t border-slate-50 flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase">
                          <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> {dupe.date}</span>
                          <span className="text-amber-500 flex items-center gap-1">Auditar <ChevronRight className="w-3 h-3" /></span>
                       </div>
                    </div>
                  ))}
               </div>
            </div>
          )}

          <div className="flex flex-col items-center justify-center py-16 opacity-30 select-none">
             <Database className="w-24 h-24 mb-6" />
             <h3 className="text-xl font-black uppercase tracking-[0.3em]">Consola en Espera</h3>
             <p className="font-bold max-w-xs text-center mt-2">
               {systemWideDuplicates.length > 0 
                ? 'Toca uno de los duplicados detectados arriba o usa el buscador para una auditoría manual.'
                : overviewFailed
                  ? 'No se detectaron duplicados en la página cargada, pero el listado global no cargó: revisa la conexión con el servidor.'
                  : 'No se detectaron duplicados en toda la base. Ingresa un dato arriba para auditar manualmente.'}
             </p>
          </div>
        </div>
      )}
    </div>
  );
};
