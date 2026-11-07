
import React, { useState, useEffect, useRef } from 'react';
import { ServiceRecord, PaymentMethod, StaffMember, DealStatus, UserRole, Invoice, InvoiceType } from '../types';
import {X, Save, Trash2, MapPin, CheckCircle2, DollarSign, CreditCard, Camera, PenTool, Eraser, Plus, User, Clock, ClipboardList, Calendar, Users, MessageCircle, AlertTriangle, Phone, Receipt, HandCoins} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { InvoiceModal } from './InvoiceModal';
import { normalizePhoneCO } from '../lib/phone';

// Obtener fecha actual en formato YYYY-MM-DD según horario local (Colombia)
const getColombianToday = () => {
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
};

const emptyService: ServiceRecord = {
  id: '',
  date: getColombianToday(),
  time: '08:00',
  clientName: '',
  clientPhone: '',
  city: 'Bogotá',
  neighborhood: '',
  address: '',
  advisor: '',
  operators: [],
  itemsToClean: '',
  servicePerformed: '',
  observations: '',
  initialValue: 0,
  additionalItems: '',
  additionalValue: 0,
  totalValue: 0,
  paymentMethod: PaymentMethod.CASH,
  expenses: 0,
  expensesNote: '',
  operatorPayment: 0,
  advances: 0,
  netProfit: 0,
  isWarranty: false,
  technicalImages: [],
  afterImages: [],
  clientSignature: ''
};

// Interface for ServiceForm component props
interface ServiceFormProps {
  initialData?: ServiceRecord | null;
  onSave: (data: ServiceRecord) => Promise<string | null>;
  onCancel: () => void;
  onChat?: (phone: string) => void;
  staff: StaffMember[];
  prefillClient?: {
    name: string;
    phone: string;
    advisor?: string;
    value?: number;
    items?: string;
    address?: string;
    location?: string;
    technicalImages?: string[];
  } | null;
  userRole?: UserRole;
}

export const ServiceForm: React.FC<ServiceFormProps> = ({ 
  initialData, 
  onSave, 
  onCancel, 
  onChat,
  staff, 
  prefillClient,
  userRole = 'admin'
}) => {
  const [formData, setFormData] = useState<ServiceRecord>(() => {
    if (initialData) {
      return { ...emptyService, ...initialData, operators: initialData.operators || [], technicalImages: initialData.technicalImages || [], afterImages: initialData.afterImages || [] };
    }
    return { ...emptyService, id: Date.now().toString() };
  });

  const isOperator = userRole === 'operator';
  const isAdmin = userRole === 'admin' || userRole === 'sales_agent';
  const [availabilityWarning, setAvailabilityWarning] = useState<string | null>(null);
  // v5 Facturación: factura generada desde un servicio realizado.
  const [invoiceToShow, setInvoiceToShow] = useState<Invoice | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  // v5.1 Tipo de la factura a generar (por defecto, el de settings).
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('normal');
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (res.ok) {
          const s = await res.json();
          if (s.invoice_default_type === 'electronica' || s.invoice_default_type === 'normal') {
            setInvoiceType(s.invoice_default_type);
          }
        }
      } catch { /* sin conexión: queda 'normal' */ }
    })();
  }, []);
  const [formError, setFormError] = useState<string | null>(null);

  // Validación antes de guardar: nombre y teléfono requeridos, valores
  // no negativos, abonos dentro del total y fecha no pasada (la fecha
  // del formulario es formData.date, YYYY-MM-DD en hora de Bogotá).
  const validateForm = (opts?: { checkDate?: boolean }): string | null => {
    if (!formData.clientName.trim()) return 'Falta el nombre del cliente.';
    if (!formData.clientPhone.trim()) return 'Falta el teléfono del cliente.';
    if (!Number.isFinite(Number(formData.initialValue)) || Number(formData.initialValue) < 0) return 'El valor inicial no puede ser negativo.';
    const total = (Number(formData.initialValue) || 0) + (Number(formData.additionalValue) || 0);
    if (!Number.isFinite(Number(formData.advances)) || Number(formData.advances) < 0) return 'Los abonos no pueden ser negativos.';
    if (Number(formData.advances) > total) return `Los abonos (${formatCurrency(Number(formData.advances))}) no pueden superar el total (${formatCurrency(total)}).`;
    if (opts?.checkDate !== false && !initialData) {
      // Solo al crear: al editar un servicio ya realizado la fecha
      // pasada es historia, no un error (bloquearla impediría corregir
      // registros viejos).
      if (!formData.date) return 'Falta la fecha del servicio.';
      if (formData.date < getColombianToday()) return 'La fecha del servicio no puede ser pasada.';
    }
    return null;
  };

  const handleSaveClick = async () => {
    const err = validateForm();
    if (err) { setFormError(err); return; }
    setFormError(null);
    await onSave({ ...formData, clientPhone: normalizePhoneCO(formData.clientPhone) });
  };

  const balanceDue = Math.max(0, (Number(formData.totalValue) || 0) - (Number(formData.advances) || 0));

  const handleGenerateInvoice = async () => {
    setInvoiceBusy(true);
    setInvoiceError(null);
    try {
      // Se guarda el servicio directo por API (el onSave de App cierra el
      // formulario y desmontaría el modal de la factura).
      const saved = await apiFetch('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (!saved.ok) { setInvoiceError('No se pudo guardar el servicio antes de facturar.'); return; }
      const res = await apiFetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_id: formData.id, type: invoiceType }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setInvoiceToShow(data);
      else setInvoiceError(data.error || 'No se pudo generar la factura.');
    } catch { setInvoiceError('Sin conexión con el servidor.'); }
    finally { setInvoiceBusy(false); }
  };
  
  // Firma Pad
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  // ¿Hubo trazos en esta sesión? Un canvas vacío devuelve un PNG en
  // blanco válido que sobrescribía la firma existente al terminar.
  const hasDrawnRef = useRef(false);

  useEffect(() => {
    if (formData.clientSignature && canvasRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
        };
        img.src = formData.clientSignature;
      }
    }
  }, [formData.clientSignature, isOperator, formData.dealStatus]);

  useEffect(() => {
    if (initialData) {
      setFormData({ ...emptyService, ...initialData, operators: initialData.operators || [], technicalImages: initialData.technicalImages || [], afterImages: initialData.afterImages || [] });
    }
  }, [initialData]);

  useEffect(() => {
    if (prefillClient && !initialData) {
      // location puede venir como "Barrio, Ciudad": el barrio es solo
      // la primera parte (igual que en ChatInbox/App).
      const locParts = (prefillClient.location || '').split(',');
      setFormData(prev => ({
        ...prev,
        clientName: prefillClient.name,
        clientPhone: prefillClient.phone,
        advisor: prefillClient.advisor || prev.advisor,
        initialValue: prefillClient.value || prev.initialValue,
        itemsToClean: prefillClient.items || prev.itemsToClean,
        address: prefillClient.address || prev.address,
        neighborhood: locParts[0]?.trim() || prev.neighborhood,
        city: locParts[1]?.trim() || prev.city,
        technicalImages: prefillClient.technicalImages || []
      }));
    }
  }, [prefillClient, initialData]);

  // Chequeo de Disponibilidad AM/PM
  useEffect(() => {
    const checkAvailability = async () => {
      if (!formData.date || !formData.time || isOperator) return;
      try {
        const [resAvail, resSett] = await Promise.all([
          apiFetch('/api/availability'),
          apiFetch('/api/settings')
        ]);
        if (resAvail.ok && resSett.ok) {
          const avail = await resAvail.json();
          const settings = await resSett.json();
          const capacity = parseInt(settings.daily_capacity || '15');
          const isPM = formData.time >= '13:00';
          const dayData = avail.find((d: any) => d.date === formData.date);
          
          if (dayData) {
            const count = isPM ? parseInt(dayData.pm_count) : parseInt(dayData.am_count);
            if (count >= capacity) {
              setAvailabilityWarning(`¡Atención! El turno ${isPM ? 'TARDE' : 'MAÑANA'} ya tiene ${count} servicios agendados.`);
            } else {
              setAvailabilityWarning(null);
            }
          } else {
            setAvailabilityWarning(null);
          }
        }
      } catch (e) { console.error(e); }
    };
    checkAvailability();
  }, [formData.date, formData.time, isOperator]);

  // Lógica de cálculo automático de Costo de Operario y Utilidad Neta
  useEffect(() => {
    const selectedStaff = staff.filter(s => formData.operators.includes(s.name));
    const calculatedOpPayment = selectedStaff.reduce((acc, curr) => {
      const pct = Number(curr.commissionPct) || 0;
      return acc + ((Number(formData.initialValue) || 0) * pct / 100);
    }, 0);
    const total = (Number(formData.initialValue) || 0) + (Number(formData.additionalValue) || 0);
    const net = total - (Number(formData.expenses) || 0) - calculatedOpPayment;
    setFormData(prev => {
      if (prev.operatorPayment === calculatedOpPayment && prev.totalValue === total && prev.netProfit === net) return prev;
      return { ...prev, operatorPayment: calculatedOpPayment, totalValue: total, netProfit: net };
    });
  }, [formData.initialValue, formData.additionalValue, formData.expenses, formData.operators, staff]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'number' ? Number(value) : value }));
  };

  const toggleOperator = (name: string) => {
    if (isOperator) return;
    setFormData(prev => ({
      ...prev,
      operators: prev.operators.includes(name) 
        ? prev.operators.filter(n => n !== name) 
        : [...prev.operators, name]
    }));
  };

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isOperator) return;
    setIsDrawing(true);
    hasDrawnRef.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { x, y } = getCoordinates(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2.5;
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || !isOperator) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { x, y } = getCoordinates(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const clearCanvas = () => {
    if (!isOperator) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawnRef.current = false;
    setFormData(prev => ({ ...prev, clientSignature: '' }));
  };

  const handleFinishOperator = async (method: PaymentMethod) => {
    // Sin trazos nuevos no se envía la firma: un canvas vacío devuelve
    // un PNG en blanco que sobrescribiría la firma ya guardada. La
    // firma no es obligatoria: si no hay trazos ni firma previa, va vacía.
    const canvas = canvasRef.current;
    const signature = hasDrawnRef.current && canvas ? canvas.toDataURL() : formData.clientSignature;
    const finalData = {
      ...formData,
      clientPhone: normalizePhoneCO(formData.clientPhone),
      paymentMethod: method,
      dealStatus: method === PaymentMethod.CASH ? DealStatus.PAID : DealStatus.DONE,
      clientSignature: signature
    };
    await onSave(finalData);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, field: 'technicalImages' | 'afterImages') => {
    const files = e.target.files;
    if (files) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setFormData(prev => ({ ...prev, [field]: [...(prev[field] || []), event.target?.result as string] }));
        }
      };
      reader.readAsDataURL(files[0]);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 overflow-y-auto">
        <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-5xl max-h-[95vh] overflow-y-auto flex flex-col border border-slate-200">
          <div className="flex items-center justify-between p-6 border-b sticky top-0 bg-white/90 backdrop-blur z-10">
            <div className="flex items-center gap-3">
               <div className={`p-2 rounded-xl ${isOperator ? 'bg-orange-100 text-orange-600' : 'bg-brand-100 text-brand-600'}`}>
                 {isOperator ? <ClipboardList className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
               </div>
               <div>
                  <h2 className="text-xl font-black text-slate-800 tracking-tight leading-none">
                    {isOperator ? 'Hoja de Trabajo Operativa' : 'Programación de Servicio'}
                  </h2>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">ID: {formData.id.slice(-6).toUpperCase()}</p>
               </div>
            </div>
            <button onClick={onCancel} className="text-slate-400 hover:text-slate-700 p-2"><X className="w-8 h-8" /></button>
          </div>

          <div className="p-8 space-y-12">
            {availabilityWarning && (
              <div className="bg-red-50 border-2 border-red-200 p-6 rounded-[2rem] flex items-center gap-4 animate-bounce">
                 <div className="bg-red-500 p-3 rounded-2xl text-white shadow-lg shadow-red-500/20">
                    <AlertTriangle className="w-6 h-6" />
                 </div>
                 <div>
                    <h4 className="font-black text-red-600 uppercase text-xs tracking-widest">Alerta de Capacidad</h4>
                    <p className="text-sm font-bold text-red-700">{availabilityWarning}</p>
                    <p className="text-[9px] font-black uppercase text-red-400 mt-1">Se recomienda mover a otro turno o día.</p>
                 </div>
              </div>
            )}

            <section className="space-y-6">
               <div className="flex items-center gap-2 border-l-4 border-brand-500 pl-4 py-1">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">Información de Destino</h3>
               </div>
               
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 relative group">
                     <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2">Cliente</label>
                     <div className="flex justify-between items-start">
                        <div className="flex-1 mr-2">
                           <input 
                             type="text" 
                             name="clientName" 
                             value={formData.clientName} 
                             onChange={handleChange} 
                             disabled={isOperator} 
                             placeholder="Nombre del cliente..." 
                             className="w-full bg-transparent border-none text-base font-black text-slate-800 outline-none p-0 h-auto placeholder:text-slate-400" 
                           />
                           <div className="flex items-center gap-1 mt-1">
                              <Phone className="w-3 h-3 text-brand-400" />
                              <input 
                                type="tel" 
                                name="clientPhone" 
                                value={formData.clientPhone} 
                                onChange={handleChange} 
                                disabled={isOperator} 
                                placeholder="Número de celular..." 
                                className="w-full bg-transparent border-none text-xs font-bold text-brand-600 outline-none p-0 h-auto placeholder:text-brand-300" 
                              />
                           </div>
                        </div>
                        {onChat && formData.clientPhone && (
                           <button 
                             onClick={() => { onChat(formData.clientPhone); onCancel(); }}
                             className="p-2.5 bg-emerald-500 text-white rounded-xl shadow-lg hover:bg-emerald-600 transition-all active:scale-95"
                             title="Abrir chat con cliente"
                           >
                             <MessageCircle className="w-5 h-5" />
                           </button>
                        )}
                     </div>
                  </div>
                  
                  <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 lg:col-span-2">
                     <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2">Dirección de Servicio</label>
                     <div className="flex items-start gap-3">
                        <MapPin className="w-5 h-5 text-brand-500 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                           <input type="text" name="address" value={formData.address} onChange={handleChange} disabled={isOperator} placeholder="Dirección exacta..." className="w-full bg-transparent border-none text-base font-black text-slate-800 outline-none p-0 h-auto" />
                           <div className="flex gap-2 mt-1">
                             <input type="text" name="neighborhood" value={formData.neighborhood} onChange={handleChange} disabled={isOperator} placeholder="Barrio..." className="bg-transparent border-none text-xs font-bold text-slate-500 outline-none w-1/2 p-0" />
                             <input type="text" name="city" value={formData.city} onChange={handleChange} disabled={isOperator} placeholder="Ciudad..." className="bg-transparent border-none text-xs font-bold text-slate-500 outline-none w-1/2 p-0" />
                           </div>
                        </div>
                     </div>
                  </div>

                  <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                     <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2">Programación</label>
                     <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-3 bg-white p-2 rounded-xl border border-slate-200">
                           <Calendar className="w-4 h-4 text-brand-500" />
                           {isOperator ? <span className="text-sm font-black text-slate-700">{formData.date}</span> : <input type="date" name="date" value={formData.date} onChange={handleChange} className="w-full bg-transparent border-none text-sm font-black text-slate-700 outline-none" />}
                        </div>
                        <div className="flex items-center gap-3 bg-white p-2 rounded-xl border border-slate-200">
                           <Clock className="w-4 h-4 text-brand-500" />
                           {isOperator ? <span className="text-sm font-black text-slate-700">{formData.time}</span> : <input type="time" name="time" value={formData.time} onChange={handleChange} className="w-full bg-transparent border-none text-sm font-black text-slate-700 outline-none" />}
                        </div>
                     </div>
                  </div>

                  <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                     <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2">Asesor Responsable</label>
                     <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-slate-400" />
                        {!isOperator && isAdmin ? (
                           <select name="advisor" value={formData.advisor} onChange={handleChange} className="w-full bg-transparent border-none text-sm font-black text-slate-700 outline-none">
                              <option value="">Seleccionar asesor...</option>
                              {staff.filter(s => s.role !== 'operator').map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                           </select>
                        ) : (
                           <span className="text-sm font-black text-slate-700">{formData.advisor || 'Sin asignar'}</span>
                        )}
                     </div>
                  </div>

                  <div className="bg-brand-50 p-5 rounded-2xl border border-brand-100 lg:col-span-1">
                     <label className="text-[9px] font-black text-brand-500 uppercase tracking-widest block mb-2">¿Qué se debe limpiar?</label>
                     {isOperator ? <p className="text-sm font-black text-brand-900 whitespace-pre-wrap">{formData.itemsToClean || 'No se especificaron items'}</p> : <textarea name="itemsToClean" value={formData.itemsToClean} onChange={handleChange} rows={2} className="w-full bg-transparent border-none text-sm font-black text-brand-900 outline-none resize-none p-0" placeholder="Items..." />}
                  </div>
               </div>
            </section>

            <section className="space-y-4">
               <div className="flex items-center gap-2 border-l-4 border-orange-500 pl-4 py-1">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">Fotos de Referencia (Chat)</h3>
               </div>
               <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                  {formData.technicalImages.map((img, i) => (
                     <div key={i} className="aspect-square rounded-2xl overflow-hidden border-2 border-white shadow-md relative group">
                        <img src={img} className="w-full h-full object-cover" />
                        {!isOperator && <button type="button" onClick={() => setFormData(prev => ({ ...prev, technicalImages: prev.technicalImages.filter((_, idx) => idx !== i) }))} className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3 h-3" /></button>}
                     </div>
                  ))}
               </div>
            </section>

            {!isOperator && (
               <section className="space-y-4">
                  <div className="flex items-center gap-2 border-l-4 border-purple-500 pl-4 py-1">
                     <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">Asignación de Personal</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                     {staff.filter(s => s.role === 'operator').map(op => (
                        <button key={op.id} type="button" onClick={() => toggleOperator(op.name)} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all border-2 ${formData.operators.includes(op.name) ? 'bg-purple-600 text-white border-purple-600 shadow-lg' : 'bg-white text-slate-400 border-slate-100 hover:border-purple-200'}`}>{op.name}</button>
                     ))}
                  </div>
               </section>
            )}

            {(isOperator || formData.dealStatus === DealStatus.DONE || formData.dealStatus === DealStatus.PAID) && (
               <section className="pt-8 border-t-2 border-slate-100 space-y-10">
                  <div className="flex flex-col md:flex-row gap-10">
                     <div className="flex-1 space-y-4">
                        <h3 className="text-sm font-black text-emerald-600 uppercase tracking-wider flex items-center gap-2"><Camera className="w-4 h-4" /> Fotos Trabajo Terminado</h3>
                        <div className="grid grid-cols-3 gap-3">
                           {formData.afterImages?.map((img, i) => (
                              <div key={i} className="aspect-square rounded-2xl overflow-hidden border border-slate-200 relative group shadow-sm">
                                 <img src={img} className="w-full h-full object-cover" />
                                 {isOperator && (
                                   <button onClick={() => setFormData(prev => ({ ...prev, afterImages: prev.afterImages?.filter((_, idx) => idx !== i) }))} className="absolute top-2 right-2 bg-red-500 text-white p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="w-4 h-4" /></button>
                                 )}
                              </div>
                           ))}
                           {isOperator && (
                             <label className="aspect-square bg-emerald-50 border-2 border-dashed border-emerald-200 rounded-2xl flex flex-col items-center justify-center text-emerald-400 hover:bg-emerald-100 cursor-pointer transition-all">
                                <Plus className="w-8 h-8 mb-1" />
                                <span className="text-[9px] font-black uppercase tracking-widest">Subir Foto</span>
                                <input type="file" className="hidden" accept="image/*" onChange={(e) => handleFileUpload(e, 'afterImages')} />
                             </label>
                           )}
                        </div>
                     </div>
                     <div className="flex-1 space-y-4">
                        <div className="flex items-center justify-between">
                           <h3 className="text-sm font-black text-brand-600 uppercase tracking-wider flex items-center gap-2"><PenTool className="w-4 h-4" /> Firma del Cliente</h3>
                           {isOperator && (
                            <button onClick={clearCanvas} className="text-red-500 flex items-center gap-1 text-[9px] font-black uppercase hover:bg-red-50 px-2 py-1 rounded"><Eraser className="w-3.5 h-3.5" /> Limpiar</button>
                           )}
                        </div>
                        <div className={`bg-slate-50 border-2 border-slate-200 rounded-2xl overflow-hidden touch-none relative h-[180px] shadow-inner ${!isOperator ? 'bg-slate-100' : ''}`}>
                           <canvas ref={canvasRef} width={500} height={180} className={`w-full h-full ${isOperator ? 'cursor-crosshair' : 'cursor-default'}`} onMouseDown={startDrawing} onMouseMove={draw} onMouseUp={() => setIsDrawing(false)} onMouseLeave={() => setIsDrawing(false)} onTouchStart={startDrawing} onTouchMove={draw} onTouchEnd={() => setIsDrawing(false)} />
                        </div>
                     </div>
                  </div>
               </section>
            )}

            <section className="bg-slate-900 p-8 rounded-[3rem] text-center space-y-8 shadow-2xl relative overflow-hidden">
               <div className="absolute top-0 right-0 w-64 h-64 bg-brand-500/10 blur-[100px] rounded-full" />
               <div className="relative">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-10 max-w-4xl mx-auto items-center">
                     <div>
                        <p className="text-brand-400 text-[10px] font-black uppercase tracking-[0.3em] mb-2">Facturación Total</p>
                        {!isOperator ? (
                           <div className="flex items-center justify-center gap-2 border-b-2 border-white/20 pb-2">
                              <DollarSign className="w-8 h-8 text-emerald-400" />
                              <input type="number" name="initialValue" value={formData.initialValue} onChange={handleChange} className="bg-transparent border-none text-white text-5xl font-black w-full text-center outline-none focus:ring-0" />
                           </div>
                        ) : <h3 className="text-white text-6xl font-black">{formatCurrency(formData.totalValue)}</h3>}
                     </div>
                     {!isOperator && isAdmin && (
                        <div className="bg-white/5 p-6 rounded-[2rem] border border-white/10">
                           <p className="text-orange-400 text-[10px] font-black uppercase tracking-[0.3em] mb-2">Pago a Operarios (Costo)</p>
                           <div className="flex items-center justify-center gap-2 border-b-2 border-orange-500/30 pb-2">
                              <Users className="w-6 h-6 text-orange-400" />
                              <input type="number" name="operatorPayment" value={formData.operatorPayment} readOnly className="bg-transparent border-none text-white text-3xl font-black w-full text-center outline-none focus:ring-0" placeholder="0" />
                           </div>
                           <p className="text-[9px] text-slate-500 font-bold uppercase mt-2">Calculado automáticamente por comisión</p>
                        </div>
                     )}
                  </div>
                  {/* v5 Facturación: abonos y saldo pendiente (total − abonos). */}
                  {!isOperator && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl mx-auto mt-8">
                      <div className="bg-white/5 p-5 rounded-[2rem] border border-white/10">
                        <p className="text-emerald-400 text-[10px] font-black uppercase tracking-[0.3em] mb-2 flex items-center justify-center gap-2"><HandCoins className="w-4 h-4" /> Abonos recibidos</p>
                        <div className="flex items-center justify-center gap-2 border-b-2 border-emerald-500/30 pb-2">
                          <DollarSign className="w-6 h-6 text-emerald-400" />
                          <input type="number" min={0} name="advances" value={formData.advances} onChange={handleChange} className="bg-transparent border-none text-white text-3xl font-black w-full text-center outline-none focus:ring-0" placeholder="0" />
                        </div>
                        <p className="text-[9px] text-slate-500 font-bold uppercase mt-2">Se descuentan del total al facturar</p>
                      </div>
                      <div className="bg-white/5 p-5 rounded-[2rem] border border-white/10 flex flex-col items-center justify-center">
                        <p className="text-amber-400 text-[10px] font-black uppercase tracking-[0.3em] mb-2">Saldo pendiente</p>
                        <p className="text-white text-3xl font-black">{formatCurrency(balanceDue)}</p>
                        <p className="text-[9px] text-slate-500 font-bold uppercase mt-2">Total − abonos</p>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl mx-auto mt-12">
                     {isOperator ? (
                        <>
                           <button onClick={() => handleFinishOperator(PaymentMethod.CASH)} className="group bg-emerald-500 hover:bg-emerald-600 p-6 rounded-[2rem] flex flex-col items-center gap-3 transition-all transform hover:scale-105 active:scale-95 shadow-xl"><div className="bg-white/20 p-4 rounded-full group-hover:bg-white/30 transition-colors"><DollarSign className="w-10 h-10 text-white" /></div><span className="text-white font-black uppercase tracking-widest text-xs">Pago en Efectivo</span></button>
                           <button onClick={() => handleFinishOperator(PaymentMethod.TRANSFER)} className="group bg-brand-500 hover:bg-brand-600 p-6 rounded-[2rem] flex flex-col items-center gap-3 transition-all transform hover:scale-105 active:scale-95 shadow-xl"><div className="bg-white/20 p-4 rounded-full group-hover:bg-white/30 transition-colors"><CreditCard className="w-10 h-10 text-white" /></div><span className="text-white font-black uppercase tracking-widest text-xs">Pago Transferencia</span></button>
                        </>
                     ) : (
                        <div className="col-span-full space-y-3">
                           {formError && (
                             <p className="bg-red-500/20 border border-red-400/50 text-red-200 px-4 py-3 rounded-2xl text-xs font-bold text-center">{formError}</p>
                           )}
                           <button type="button" onClick={handleSaveClick} className="w-full bg-brand-600 text-white py-5 rounded-2xl font-black uppercase tracking-widest text-sm hover:bg-brand-700 shadow-xl flex items-center justify-center gap-3"><Save className="w-6 h-6" /> Guardar Cambios</button>
                           {initialData && (formData.dealStatus === DealStatus.DONE || formData.dealStatus === DealStatus.PAID) && (
                             <>
                               {/* v5.1 Tipo de factura: Normal (sin DIAN) o Electrónica (DIAN). */}
                               <div className="flex flex-wrap items-center justify-center gap-3">
                                 <label className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 cursor-pointer">
                                   <input type="radio" name="invoice-type" checked={invoiceType === 'normal'} onChange={() => setInvoiceType('normal')} />
                                   <span className="text-xs font-black text-white uppercase tracking-widest">Normal <span className="text-slate-400 normal-case tracking-normal">(sin DIAN)</span></span>
                                 </label>
                                 <label className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 cursor-pointer">
                                   <input type="radio" name="invoice-type" checked={invoiceType === 'electronica'} onChange={() => setInvoiceType('electronica')} />
                                   <span className="text-xs font-black text-white uppercase tracking-widest">Electrónica <span className="text-slate-400 normal-case tracking-normal">(DIAN)</span></span>
                                 </label>
                               </div>
                               <p className="text-[11px] font-bold text-slate-400 text-center">
                                 {invoiceType === 'normal'
                                   ? 'Factura de venta corriente, para empresas que no se conectan a la DIAN.'
                                   : 'Factura electrónica DIAN-ready (lista para el proveedor certificado; el CRM no envía nada a la DIAN).'}
                               </p>
                               <button type="button" onClick={handleGenerateInvoice} disabled={invoiceBusy} className="w-full bg-amber-500 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-sm hover:bg-amber-600 shadow-xl flex items-center justify-center gap-3 disabled:opacity-50"><Receipt className="w-5 h-5" /> {invoiceBusy ? 'Generando...' : 'Generar factura'}</button>
                               {invoiceError && <p className="text-xs font-bold text-red-400 text-center">{invoiceError}</p>}
                             </>
                           )}
                        </div>
                     )}
                  </div>
               </div>
            </section>
          </div>
        </div>
      </div>
      {invoiceToShow && <InvoiceModal invoice={invoiceToShow} onClose={() => setInvoiceToShow(null)} />}
    </>
  );
};
