
import React, {useState, useEffect} from 'react';
import { ClientSummary } from '../types';
import {Search, FileSpreadsheet, MapPin, Phone, Calendar, Star, UserPlus, Trash2, MessageCircle, Filter, X, ChevronDown, Award, Target, ChevronLeft, ChevronRight} from 'lucide-react';
import * as XLSX from 'xlsx';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { formatPhoneCO } from '../lib/phone';

// Fecha del último servicio en zona Bogotá: el servidor devuelve un
// timestamp y `split('T')[0]` tomaba la fecha UTC (un día más en
// Bogotá tras las 19:00). Si ya viene como fecha de calendario
// (YYYY-MM-DD) se muestra tal cual, sin convertir.
const formatBogotaDate = (value: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (isNaN(d.getTime())) return value.split('T')[0] || value;
  return d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
};

interface ClientsListProps {
  clients: ClientSummary[];
  totalClients: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  onSearchChange: (search: string) => void;
  onFiltersChange: (filters: any) => void;
  onDeleteClient: (phone: string) => void;
  userRole: string;
  userName: string;
  onChat: (phone: string) => void;
}

export const ClientsList: React.FC<ClientsListProps> = ({ 
  clients, 
  totalClients,
  currentPage,
  onPageChange,
  onSearchChange,
  onFiltersChange,
  onDeleteClient, 
  userRole, 
  userName,
  onChat 
}) => {
  const [localSearch, setLocalSearch] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  
  const [selectedCity, setSelectedCity] = useState('all');
  const [selectedType, setSelectedType] = useState('all');
  const [selectedSpentRange, setSelectedSpentRange] = useState('all');

  // Fetch cities once
  useEffect(() => {
    apiFetch('/api/cities')
      .then(res => { if (!res.ok) throw new Error('cities'); return res.json(); })
      .then(data => { if (Array.isArray(data)) setCities(data); })
      .catch(err => console.error('Error fetching cities:', err));
  }, []);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchChange(localSearch);
      onPageChange(1);
    }, 500);
    return () => clearTimeout(timer);
    // Sin onSearchChange/onPageChange en deps: en App son arrows nuevas
    // en cada render y el efecto se disparaba en bucle (igual que ya
    // hacen LeadPipeline, BusinessDeals y ServiceList).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSearch]);

  // Handle filter changes
  useEffect(() => {
    onFiltersChange({
      city: selectedCity,
      type: selectedType,
      spentRange: selectedSpentRange
    });
    onPageChange(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCity, selectedType, selectedSpentRange]);

  const exportToExcel = async () => {
    // Para exportar todo, necesitamos pedir todos los datos al servidor sin paginación o con un límite muy alto
    try {
      // v5.2 El alcance sale del JWT: el servidor ignora role/userName.
      const res = await apiFetch(`/api/clients?limit=5000&search=${encodeURIComponent(localSearch)}&city=${encodeURIComponent(selectedCity)}&type=${selectedType}&spentRange=${selectedSpentRange}`);
      if (res.ok) {
        const result = await res.json();
        const allData = result.data;
        const worksheet = XLSX.utils.json_to_sheet(allData.map((c: any) => ({
          "Nombre": c.clientName,
          "Teléfono": c.clientPhone,
          "Ciudad": c.city,
          "Barrio": c.neighborhood,
          "Dirección": c.address,
          "Total Servicios": c.totalServices,
          "Inversión Total": c.totalSpent,
          "Último Contacto/Servicio": c.lastServiceDate,
          "Fuente": c.source
        })));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Base_Clientes");
        XLSX.writeFile(workbook, `DB_Clientes_Purifica_${new Date().toISOString().split('T')[0]}.xlsx`);
      }
    } catch (e) {
      console.error('Error exporting to excel:', e);
    }
  };

  const clearFilters = () => {
    setLocalSearch('');
    setSelectedCity('all');
    setSelectedType('all');
    setSelectedSpentRange('all');
  };



  const totalPages = Math.ceil(totalClients / 50);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">Base de Clientes</h1>
          <p className="text-slate-500 font-medium">Consolidado total: Clientes Recurrentes + Nuevos Contactos</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={exportToExcel}
            className="bg-emerald-600 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:bg-emerald-700 transition-all flex items-center gap-2"
          >
            <FileSpreadsheet className="w-4 h-4" /> Exportar a Excel
          </button>
        </div>
      </div>

      {/* PANEL DE FILTROS AVANZADOS */}
      <div className="bg-white p-6 rounded-[2.5rem] shadow-sm border border-slate-200 space-y-6">
        <div className="flex items-center justify-between">
           <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-brand-600" />
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Filtros de Segmentación</h3>
           </div>
           {(localSearch || selectedCity !== 'all' || selectedType !== 'all' || selectedSpentRange !== 'all') && (
             <button onClick={clearFilters} className="text-[9px] font-black text-red-500 uppercase flex items-center gap-1 hover:underline">
               <X className="w-3 h-3" /> Limpiar todo
             </button>
           )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
           {/* Búsqueda Principal */}
           <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input 
                type="text" 
                placeholder="Nombre o teléfono..." 
                value={localSearch}
                onChange={e => setLocalSearch(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-slate-50 border-none rounded-2xl text-sm font-bold outline-none focus:ring-2 focus:ring-brand-500/20 shadow-inner"
              />
           </div>

           {/* Filtro por Ciudad */}
           <div className="relative">
              <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <select 
                value={selectedCity}
                onChange={e => setSelectedCity(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-slate-50 border-none rounded-2xl text-sm font-bold outline-none appearance-none cursor-pointer"
              >
                <option value="all">Cualquier Ciudad</option>
                {cities.map(city => (
                  <option key={city} value={city}>{city}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300 pointer-events-none" />
           </div>

           {/* Filtro por Fidelidad */}
           <div className="relative">
              <Target className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <select 
                value={selectedType}
                onChange={e => setSelectedType(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-slate-50 border-none rounded-2xl text-sm font-bold outline-none appearance-none cursor-pointer"
              >
                <option value="all">Fidelidad: Todos</option>
                <option value="recurrent">Clientes Recurrentes (1+)</option>
                <option value="prospect">Solo Prospectos (Nuevos)</option>
              </select>
              <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300 pointer-events-none" />
           </div>

           {/* Filtro por Volumen de Compra */}
           <div className="relative">
              <Award className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <select 
                value={selectedSpentRange}
                onChange={e => setSelectedSpentRange(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-slate-50 border-none rounded-2xl text-sm font-bold outline-none appearance-none cursor-pointer"
              >
                <option value="all">Volumen Compra: Todos</option>
                <option value="zero">Sin inversión ($0)</option>
                <option value="low">Inversión Baja ($1 - $200k)</option>
                <option value="mid">Inversión Media ($200k - $800k)</option>
                <option value="high">Clientes VIP (+$800k)</option>
              </select>
              <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300 pointer-events-none" />
           </div>
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-slate-50">
           <div className="flex gap-4">
              <div className="flex items-center gap-2">
                 <div className="w-2 h-2 bg-brand-500 rounded-full" />
                 <span className="text-[10px] font-black uppercase text-slate-400 tracking-tighter">Total Registros: {totalClients}</span>
              </div>
           </div>
           
           {/* Paginación */}
           {totalPages > 1 && (
             <div className="flex items-center gap-2">
               <button 
                 disabled={currentPage === 1}
                 onClick={() => onPageChange(currentPage - 1)}
                 className="p-2 rounded-xl hover:bg-slate-100 disabled:opacity-30 transition-colors"
               >
                 <ChevronLeft className="w-4 h-4" />
               </button>
               <span className="text-[10px] font-black uppercase text-slate-500">Página {currentPage} de {totalPages}</span>
               <button 
                 disabled={currentPage === totalPages}
                 onClick={() => onPageChange(currentPage + 1)}
                 className="p-2 rounded-xl hover:bg-slate-100 disabled:opacity-30 transition-colors"
               >
                 <ChevronRight className="w-4 h-4" />
               </button>
             </div>
           )}
        </div>
      </div>

      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 text-[9px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
              <tr>
                <th className="px-8 py-5">Identidad Cliente</th>
                <th className="px-8 py-5">Ubicación</th>
                <th className="px-8 py-5 text-center">Relación</th>
                <th className="px-8 py-5 text-right">Valor Lifetime</th>
                <th className="px-8 py-5 text-center">Último Mov.</th>
                <th className="px-8 py-5">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {clients.map((client) => (
                <tr key={client.clientPhone} className="hover:bg-brand-50/30 transition-colors group">
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm uppercase ${Number(client.totalServices) > 0 ? 'bg-brand-100 text-brand-600' : 'bg-slate-100 text-slate-400'}`}>
                        {(client.clientName || 'C').charAt(0)}
                      </div>
                      <div>
                        <p className="font-black text-slate-800 text-sm leading-none mb-1">{client.clientName || 'Cliente Nuevo'}</p>
                        <p className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                          <Phone className="w-3 h-3" /> {formatPhoneCO(client.clientPhone)}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    <div className="flex items-start gap-2 max-w-[200px]">
                      <MapPin className="w-3.5 h-3.5 text-slate-300 mt-0.5" />
                      <div>
                        <p className="text-xs font-black text-slate-700 leading-tight">{client.neighborhood || 'Por definir'}</p>
                        <p className="text-[10px] font-bold text-slate-400 truncate">{client.address || client.city || 'Sin ciudad'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-6 text-center">
                    <div className="inline-flex flex-col items-center">
                       {Number(client.totalServices) > 0 ? (
                         <>
                           <div className="flex items-center gap-0.5 text-amber-500 mb-1">
                              {Array.from({ length: Math.min(Number(client.totalServices), 5) }).map((_, i) => (
                                <Star key={i} className="w-3 h-3 fill-current" />
                              ))}
                           </div>
                           <span className="text-[10px] font-black text-brand-600 uppercase bg-brand-50 px-2 py-0.5 rounded-full">
                             {client.totalServices} {Number(client.totalServices) === 1 ? 'Servicio' : 'Servicios'}
                           </span>
                         </>
                       ) : (
                         <span className="text-[10px] font-black text-slate-400 uppercase bg-slate-100 px-3 py-1 rounded-full flex items-center gap-1.5 border border-slate-200">
                           <UserPlus className="w-3 h-3" /> Prospecto Nuevo
                         </span>
                       )}
                    </div>
                  </td>
                  <td className="px-8 py-6 text-right font-black text-slate-800 text-sm">
                    {Number(client.totalSpent) > 0 ? (
                      <span className="text-brand-600 font-black">{formatCurrency(Number(client.totalSpent))}</span>
                    ) : (
                      <span className="text-slate-300">$0</span>
                    )}
                  </td>
                  <td className="px-8 py-6 text-center">
                    <div className="inline-flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase">
                      <Calendar className="w-3.5 h-3.5 text-slate-300" />
                      {client.lastServiceDate ? formatBogotaDate(client.lastServiceDate) : 'N/A'}
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => onChat(client.clientPhone)} 
                        className="inline-flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-brand-600 transition-colors shadow-sm"
                      >
                        <MessageCircle className="w-3.5 h-3.5" /> Chatear
                      </button>
                      {userRole === 'admin' && (
                        <button 
                          onClick={() => onDeleteClient(client.clientPhone)}
                          className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                          title="Eliminar cliente por completo"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {clients.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-24 text-center">
                    <div className="flex flex-col items-center opacity-30">
                       <Search className="w-12 h-12 mb-4" />
                       <p className="font-black uppercase tracking-widest text-xs">No hay resultados para estos filtros</p>
                       <button onClick={clearFilters} className="mt-4 text-brand-600 underline font-bold text-[10px] uppercase">Ver todos los clientes</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
