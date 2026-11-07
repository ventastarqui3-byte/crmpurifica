
import React, { useState, useMemo, useEffect } from 'react';
import { ServiceRecord, CurrentUser, PaymentMethod, StaffMember, Invoice, InvoiceType } from '../types';
import {Edit2, Plus, Search, MapPin, Calendar, Trash2, CalendarDays, CalendarCheck, RefreshCw, PenTool, Filter, List, MessageCircle, ChevronLeft, ChevronRight, Receipt} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { InvoiceModal } from './InvoiceModal';

interface ServiceListProps {
  services: ServiceRecord[];
  totalServices: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  onSearchChange: (search: string) => void;
  onFiltersChange: (filters: any) => void;
  onAdd: () => void;
  onEdit: (service: ServiceRecord) => void;
  onDelete: (id: string) => void;
  onChat: (phone: string) => void;
  currentUser: CurrentUser;
  staff: StaffMember[];
}

type ViewMode = 'table' | 'calendar';

export const ServiceList: React.FC<ServiceListProps> = ({ 
  services, totalServices, currentPage, onPageChange, onSearchChange, onFiltersChange,
  onAdd, onEdit, onDelete, onChat, currentUser, staff 
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  // v5 Facturación: factura del servicio que se está viendo (modal).
  const [invoiceToShow, setInvoiceToShow] = useState<Invoice | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState<string | null>(null);
  // v5.1 Si el servicio aún no tiene factura, se pregunta el tipo antes
  // de crearla (Normal sin DIAN / Electrónica DIAN).
  const [invoiceChoiceFor, setInvoiceChoiceFor] = useState<ServiceRecord | null>(null);
  const [invoiceChoiceType, setInvoiceChoiceType] = useState<InvoiceType>('normal');
  // v5.3 Google Calendar: servicios sincronizados en esta sesión (el icono
  // verde también se pinta si el servicio ya trae googleCalendarEventId).
  const [gcalSynced, setGcalSynced] = useState<Set<string>>(new Set());
  const [gcalBusy, setGcalBusy] = useState<string | null>(null);
  const syncCalendar = async (service: ServiceRecord) => {
    setGcalBusy(service.id);
    try {
      const res = await apiFetch(`/api/services/${encodeURIComponent(service.id)}/sync-calendar`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { alert(json.error || 'No se pudo sincronizar con Google Calendar.'); return; }
      setGcalSynced((prev) => new Set(prev).add(service.id));
      alert(`Sincronizado con Google Calendar (${json.action === 'updated' ? 'evento actualizado' : 'evento creado'}).`);
    } catch { alert('Sin conexión con el servidor.'); }
    finally { setGcalBusy(null); }
  };

  // Abre la factura del servicio: si ya existe se muestra; si no, se
  // pregunta el tipo y se crea (solo servicios realizados/pagados, admin).
  const openInvoice = async (service: ServiceRecord) => {
    setInvoiceBusy(service.id);
    try {
      const res = await apiFetch(`/api/invoices?service_id=${encodeURIComponent(service.id)}`);
      if (res.ok) {
        const list: Invoice[] = await res.json();
        if (list[0]) { setInvoiceToShow(list[0]); return; }
      }
      // Sin factura: cargar el tipo por defecto y preguntar el tipo.
      try {
        const s = await apiFetch('/api/settings');
        if (s.ok) {
          const sett = await s.json();
          if (sett.invoice_default_type === 'electronica' || sett.invoice_default_type === 'normal') {
            setInvoiceChoiceType(sett.invoice_default_type);
          }
        }
      } catch { /* sin conexión: queda 'normal' */ }
      setInvoiceChoiceFor(service);
    } catch { alert('Sin conexión con el servidor.'); }
    finally { setInvoiceBusy(null); }
  };

  const createInvoiceWithType = async () => {
    if (!invoiceChoiceFor) return;
    const service = invoiceChoiceFor;
    setInvoiceChoiceFor(null);
    setInvoiceBusy(service.id);
    try {
      const created = await apiFetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_id: service.id, type: invoiceChoiceType }),
      });
      if (created.ok) setInvoiceToShow(await created.json());
      else {
        const d = await created.json().catch(() => ({}));
        alert(d.error || 'No se pudo generar la factura.');
      }
    } catch { alert('Sin conexión con el servidor.'); }
    finally { setInvoiceBusy(null); }
  };
  // v5.3 Bug: antes solo el admin veía el botón de factura, pero el backend
  // (requireBilling, v5.2) ya permite al asesor (vendedor) facturar y
  // cobrar. Sin este cambio el vendedor no podía facturar desde Servicios.
  const canInvoice = currentUser.role === 'admin' || currentUser.role === 'advisor';
  
  // Advanced Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedLocation, setSelectedLocation] = useState('all');
  const [selectedStaff, setSelectedStaff] = useState('all');
  const [selectedPayment, setSelectedPayment] = useState<string>('all');

  const locations = useMemo(() => {
    const locs = new Set(services.map(s => s.neighborhood).filter(Boolean));
    return Array.from(locs);
  }, [services]);

  useEffect(() => {
    onFiltersChange({
      startDate,
      endDate,
      location: selectedLocation,
      staff: selectedStaff,
      payment: selectedPayment
    });
    onPageChange(1);
  }, [startDate, endDate, selectedLocation, selectedStaff, selectedPayment]);

  const handleSearch = (val: string) => {
    setSearchTerm(val);
    onSearchChange(val);
    onPageChange(1); // Reset to first page on search
  };

  const totalPages = Math.ceil(totalServices / 50);

  const canSeePrices = currentUser.role !== 'operator';
  const canCreate = currentUser.role !== 'operator';
  // Solo admin borra servicios: el asesor no (el servidor también lo
  // exige; antes el asesor veía el botón y el borrado se perdía).
  const canDelete = currentUser.role === 'admin';

  const renderFilters = () => (
    <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 mb-6 space-y-4 animate-in slide-in-from-top-4 duration-500">
       <div className="flex items-center gap-2 mb-2">
          <Filter className="w-4 h-4 text-brand-600" />
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Panel de Filtros Avanzados (Servicios)</h3>
       </div>
       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Fecha Inicio</label>
             <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Fecha Fin</label>
             <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Zona/Barrio</label>
             <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none">
                <option value="all">Todas las zonas</option>
                {locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
             </select>
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Pago</label>
             <select value={selectedPayment} onChange={e => setSelectedPayment(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none">
                <option value="all">Cualquier medio</option>
                {Object.values(PaymentMethod).map(m => <option key={m} value={m}>{m}</option>)}
             </select>
          </div>
          <div>
             <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Personal</label>
             <select value={selectedStaff} onChange={e => setSelectedStaff(e.target.value)} className="w-full text-xs font-bold bg-slate-50 border-none rounded-xl p-2.5 outline-none">
                <option value="all">Todo el equipo</option>
                {staff.map(s => <option key={s.id} value={s.name}>{s.name} ({s.role})</option>)}
             </select>
          </div>
       </div>
    </div>
  );

  const renderTable = () => (
    <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden animate-in fade-in duration-500">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="px-8 py-4">Fecha / Hora</th>
                <th className="px-8 py-4">Cliente / ID</th>
                <th className="px-8 py-4">Ubicación</th>
                <th className="px-8 py-4">Equipo</th>
                {canSeePrices && <th className="px-8 py-4 text-right">Valor</th>}
                <th className="px-8 py-4 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {services.map(service => (
                <tr key={service.id} className="hover:bg-slate-50 transition-colors group">
                  <td className="px-8 py-4">
                    <div className="flex items-center font-bold text-slate-700 text-xs gap-1.5"><Calendar className="w-3.5 h-3.5 text-slate-400" /> {service.date}</div>
                    <span className="text-slate-400 text-[10px] font-black">{service.time}</span>
                    {(service.googleCalendarEventId || gcalSynced.has(service.id)) ? (
                      <span title="Sincronizado con Google Calendar" className="inline-flex items-center gap-1 mt-1 text-[9px] font-black text-emerald-600"><CalendarCheck className="w-3 h-3" /> Google Calendar</span>
                    ) : (
                      <span title="Sin evento en Google Calendar" className="inline-flex items-center gap-1 mt-1 text-[9px] font-black text-slate-300"><Calendar className="w-3 h-3" /> Sin sincronizar</span>
                    )}
                  </td>
                  <td className="px-8 py-4">
                    <div className="font-black text-slate-800 text-sm flex items-center gap-2">
                      {service.clientName}
                      {service.clientSignature && <span title="Servicio Firmado"><PenTool className="w-3.5 h-3.5 text-emerald-500" /></span>}
                    </div>
                    <div className="text-[10px] text-slate-500 font-bold">#{service.id.slice(-6).toUpperCase()}</div>
                  </td>
                  <td className="px-8 py-4">
                    <div className="flex items-center text-xs font-bold text-slate-600 gap-1.5"><MapPin className="w-3.5 h-3.5 text-slate-300" /> {service.neighborhood}</div>
                    <div className="text-[10px] text-slate-400 font-medium truncate max-w-[150px]">{service.address}</div>
                  </td>
                  <td className="px-8 py-4">
                    <div className="flex -space-x-2">
                      {(service.operators || []).map((op, i) => (
                         <span key={i} title={op} className="inline-flex items-center justify-center w-6 h-6 text-[8px] font-black text-white bg-brand-600 rounded-full ring-2 ring-white uppercase shadow-sm">{op.charAt(0)}</span>
                      ))}
                    </div>
                  </td>
                  {canSeePrices && <td className="px-8 py-4 text-right font-black text-slate-800 text-sm">{formatCurrency(Number(service.totalValue) || 0)}</td>}
                  <td className="px-8 py-4 text-center">
                    <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                      <button onClick={() => onChat(service.clientPhone)} title="Chatear con cliente" className="p-2 hover:bg-emerald-50 text-emerald-500 hover:text-emerald-700 rounded-xl transition-all border border-emerald-50/50"><MessageCircle className="w-4 h-4" /></button>
                      {(currentUser.role === 'admin' || currentUser.role === 'advisor') && service.dealStatus !== 'CANCELADO' && (
                        <button onClick={() => syncCalendar(service)} disabled={gcalBusy === service.id} title="Sincronizar con Google Calendar" className="p-2 hover:bg-sky-50 text-slate-400 hover:text-sky-600 rounded-xl transition-all disabled:opacity-40"><RefreshCw className={`w-4 h-4 ${gcalBusy === service.id ? 'animate-spin' : ''}`} /></button>
                      )}
                      <button onClick={() => onEdit(service)} className="p-2 hover:bg-brand-50 text-slate-400 hover:text-brand-600 rounded-xl transition-all"><Edit2 className="w-4 h-4" /></button>
                      {canInvoice && (service.dealStatus === 'REALIZADO' || service.dealStatus === 'PAGADO') && (
                        <button onClick={() => openInvoice(service)} disabled={invoiceBusy === service.id} title="Ver / generar factura" className="p-2 hover:bg-amber-50 text-slate-400 hover:text-amber-600 rounded-xl transition-all disabled:opacity-40"><Receipt className="w-4 h-4" /></button>
                      )}
                      {canDelete && <button onClick={() => onDelete(service.id)} className="p-2 hover:bg-red-50 text-slate-400 hover:text-red-500 rounded-xl transition-all"><Trash2 className="w-4 h-4" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
              {services.length === 0 && <tr><td colSpan={canSeePrices ? 6 : 5} className="py-20 text-center text-slate-300 font-black uppercase tracking-widest text-xs">No se encontraron servicios</td></tr>}
            </tbody>
          </table>
        </div>
        
        {/* Pagination Controls */}
        <div className="bg-slate-50 p-4 border-t flex items-center justify-between">
           <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
              Mostrando {services.length} de {totalServices} servicios
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
    // 29-31 eran en realidad de marzo y casaban servicios de marzo).
    const firstWeekdayOffset = (new Date(year, month, 1).getDay() + 6) % 7; // Lun=0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1));
    return (
      <div className="bg-white rounded-[2.5rem] shadow-sm border border-slate-200 p-8 animate-in fade-in duration-500">
         <div className="grid grid-cols-7 gap-px bg-slate-200 rounded-3xl border border-slate-200 overflow-hidden shadow-inner">
            {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(d => (
              <div key={d} className="bg-slate-50 p-4 text-[10px] font-black text-slate-400 text-center uppercase tracking-widest">{d}</div>
            ))}
            {Array.from({ length: firstWeekdayOffset }).map((_, i) => (
              <div key={`empty-${i}`} className="bg-white min-h-[140px]" />
            ))}
            {days.map((day, i) => {
              const dayServices = services.filter(s => {
                const sd = new Date(s.date + 'T12:00:00'); // YYYY-MM-DD sin hora: al mediodía local, no UTC (si no, caía en el día anterior en Bogotá)
                return sd.getDate() === day.getDate() && sd.getMonth() === day.getMonth() && sd.getFullYear() === day.getFullYear();
              });
              return (
                <div key={i} className="bg-white min-h-[140px] p-3 hover:bg-slate-50 transition-colors group">
                   <span className="text-xs font-black text-slate-300 group-hover:text-brand-500 transition-colors">{day.getDate()}</span>
                   <div className="mt-2 space-y-1">
                      {dayServices.slice(0, 3).map(s => (
                        <div key={s.id} onClick={() => onEdit(s)} className="text-[9px] font-black bg-white border border-emerald-100 text-emerald-700 p-1.5 rounded-lg truncate cursor-pointer hover:bg-emerald-50">
                           {s.clientName}
                        </div>
                      ))}
                      {dayServices.length > 3 && <p className="text-[8px] font-black text-slate-400 text-center">+{dayServices.length - 3} más</p>}
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
      <div className="flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">Historial de Servicios</h1>
          <p className="text-slate-500 font-medium">Gestión técnica y operativa de trabajos realizados</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
           <div className="bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200 flex">
              <button onClick={() => setViewMode('table')} className={`p-2.5 rounded-xl transition-all ${viewMode === 'table' ? 'bg-brand-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}><List className="w-5 h-5" /></button>
              <button onClick={() => setViewMode('calendar')} className={`p-2.5 rounded-xl transition-all ${viewMode === 'calendar' ? 'bg-brand-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}><CalendarDays className="w-5 h-5" /></button>
           </div>
           <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" placeholder="Buscar por cliente o ID..." value={searchTerm} onChange={e => handleSearch(e.target.value)} className="pl-12 pr-6 py-3 bg-white border border-slate-200 rounded-2xl text-sm font-bold shadow-sm outline-none focus:border-brand-500 w-64" />
           </div>
           {canCreate && (
            <button onClick={onAdd} className="bg-brand-600 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-brand-500/20 hover:bg-brand-700 transition-all flex items-center gap-2"><Plus className="w-4 h-4" /> Nuevo Servicio</button>
           )}
        </div>
      </div>

      {renderFilters()}

      {viewMode === 'table' ? renderTable() : renderCalendar()}

      {invoiceToShow && <InvoiceModal invoice={invoiceToShow} onClose={() => setInvoiceToShow(null)} />}

      {/* v5.1 Elegir el tipo antes de generar la factura */}
      {invoiceChoiceFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-black text-slate-800 text-lg">Generar factura · {invoiceChoiceFor.clientName}</h3>
            <p className="text-xs font-bold text-slate-500">¿Qué tipo de factura necesitas para este servicio?</p>
            <label className="flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 cursor-pointer">
              <input type="radio" name="choice-invoice-type" checked={invoiceChoiceType === 'normal'} onChange={() => setInvoiceChoiceType('normal')} className="mt-1" />
              <span>
                <span className="block text-sm font-black text-slate-700">Normal <span className="font-bold text-slate-400">(sin DIAN)</span></span>
                <span className="block text-xs font-bold text-slate-500">Factura de venta corriente, para empresas que no se conectan a la DIAN.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 cursor-pointer">
              <input type="radio" name="choice-invoice-type" checked={invoiceChoiceType === 'electronica'} onChange={() => setInvoiceChoiceType('electronica')} className="mt-1" />
              <span>
                <span className="block text-sm font-black text-slate-700">Electrónica <span className="font-bold text-slate-400">(DIAN)</span></span>
                <span className="block text-xs font-bold text-slate-500">DIAN-ready, lista para el proveedor certificado. El CRM no envía nada a la DIAN.</span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setInvoiceChoiceFor(null)} className="px-4 py-3 rounded-2xl text-xs font-black uppercase text-slate-500 hover:bg-slate-100">Cancelar</button>
              <button onClick={createInvoiceWithType} className="px-5 py-3 rounded-2xl text-xs font-black uppercase bg-amber-500 text-white hover:bg-amber-600 shadow-lg">Generar factura</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
