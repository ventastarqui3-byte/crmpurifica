
import React, { useState, useEffect, useMemo } from 'react';
import {StaffMember, ChatTemplate, CurrentUser, CommissionTier, roleLabel} from '../types';
import {Plus, Trash2, Save, X, Mail, Edit3, Network, Users, AlertCircle, Timer, Coffee, Activity, Loader2, MessageSquare, ChevronRight, SlidersHorizontal, TrendingUp} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { normalizePhoneCO } from '../lib/phone';

interface TeamManagementProps {
  staff: StaffMember[];
  onAddStaff: (member: any) => void;
  onRemoveStaff: (id: string) => void;
  currentUser: CurrentUser;
}

export const TeamManagement: React.FC<TeamManagementProps> = ({ staff, onAddStaff, onRemoveStaff, currentUser }) => {
  const [activeTab, setActiveTab] = useState<string>('advisor');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  
  const [reassignmentTimeout, setReassignmentTimeout] = useState(10);
  const [dailyCapacity, setDailyCapacity] = useState(15);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  const [templates, setTemplates] = useState<ChatTemplate[]>([]);
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateContent, setTemplateContent] = useState('');

  // Estados para Escalafones
  const [tiers, setTiers] = useState<CommissionTier[]>([]);
  const [newTier, setNewTier] = useState<Partial<CommissionTier>>({ role: 'advisor', min_value: 0, max_value: 0, percentage: 0 });
  const [tierError, setTierError] = useState<string | null>(null);

  const fetchTemplates = () => {
    // Igual que fetchTiers: un 403/500 deja la lista vacía en vez de
    // guardar el objeto de error y romper templates.map.
    apiFetch('/api/templates').then(res => { if (!res.ok) throw new Error('templates'); return res.json(); }).then(data => { if (Array.isArray(data)) setTemplates(data); }).catch(console.error);
  };

  const fetchTiers = () => {
    // Solo admin puede leer escalafones (v5 Parte 2C): un 403 deja la
    // lista vacía en vez de romper la pestaña con un objeto de error.
    apiFetch('/api/commission-tiers').then(res => { if (!res.ok) throw new Error('commission-tiers'); return res.json(); }).then(data => { if (Array.isArray(data)) setTiers(data); }).catch(console.error);
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (activeTab === 'Distribution') {
      apiFetch('/api/settings').then(res => res.json()).then(data => {
          // parseInt de un valor vacío/raro da NaN y se guardaba "NaN":
          // solo se aplica si el número es finito.
          const timeout = parseInt(data.reassignment_timeout);
          if (Number.isFinite(timeout)) setReassignmentTimeout(timeout);
          const capacity = parseInt(data.daily_capacity);
          if (Number.isFinite(capacity)) setDailyCapacity(capacity);
        });
    }
    if (activeTab === 'Templates') {
      fetchTemplates();
    }
    if (activeTab === 'CommissionTiers') {
      fetchTiers();
    }
  }, [activeTab]);

  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [commissionPct, setCommissionPct] = useState(0);
  const [parentId, setParentId] = useState<string>('');

  const baseAdvisors = useMemo(() => {
    return staff.filter(s => (s.role || '').toLowerCase() === 'advisor' && s.active !== false);
  }, [staff]);

  const filteredStaff = useMemo(() => {
    if (currentUser.role === 'sales_agent') {
      return staff.filter(s => s.parentId === currentUser.id && s.active !== false);
    }
    return staff.filter(s => (s.role || '').toLowerCase() === activeTab.toLowerCase() && s.active !== false);
  }, [staff, activeTab, currentUser]);

  const salesAgents = useMemo(() => staff.filter(s => (s.role || '').toLowerCase() === 'sales_agent' && s.active !== false), [staff]);

  const distributionQueue = useMemo(() => {
    return baseAdvisors.filter(s => s.isOnline === true).sort((a, b) => {
        const timeA = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
        const timeB = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
        return timeA - timeB;
      });
  }, [baseAdvisors]);

  const getWaitTime = (lastTime?: string) => {
    if (!lastTime) return 'Esperando primer lead';
    const diff = now.getTime() - new Date(lastTime).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 0) return 'Justo ahora';
    if (mins === 0) return 'Menos de 1 min';
    return mins > 60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins} min`;
  };

  const handleSaveDistributionSettings = async () => {
     // Si el campo se vació, el estado puede ser NaN: se guarda un valor
     // sensato en vez de "NaN".
     const timeout = Number.isFinite(reassignmentTimeout) ? Math.max(1, Math.round(reassignmentTimeout)) : 10;
     const capacity = Number.isFinite(dailyCapacity) ? Math.max(1, Math.round(dailyCapacity)) : 15;
     setIsSavingSettings(true);
     try {
       await apiFetch('/api/settings', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ key: 'reassignment_timeout', value: timeout.toString() })
       });
       await apiFetch('/api/settings', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ key: 'daily_capacity', value: capacity.toString() })
       });
       setReassignmentTimeout(timeout);
       setDailyCapacity(capacity);
       alert('Configuración guardada correctamente');
     } catch (e) { console.error(e); } finally { setIsSavingSettings(false); }
  };

  const handleAddTier = async () => {
    const min = Number(newTier.min_value);
    const max = Number(newTier.max_value);
    const pct = Number(newTier.percentage);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(pct)) { setTierError('Completa mínimo, máximo y porcentaje con números.'); return; }
    if (min < 0) { setTierError('El mínimo recaudado no puede ser negativo.'); return; }
    if (max <= min) { setTierError('El máximo debe ser mayor que el mínimo.'); return; }
    if (pct < 0 || pct > 100) { setTierError('El porcentaje de comisión debe estar entre 0 y 100.'); return; }
    setTierError(null);
    try {
      const res = await apiFetch('/api/commission-tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTier)
      });
      if (res.ok) {
        fetchTiers();
        setNewTier({ role: 'advisor', min_value: 0, max_value: 0, percentage: 0 });
      } else {
        const d = await res.json().catch(() => ({}));
        setTierError(d.error || 'No se pudo guardar el rango.');
      }
    } catch (e) { console.error(e); setTierError('Sin conexión con el servidor.'); }
  };

  const handleDeleteTier = async (id: string) => {
    if (!confirm('¿Eliminar este rango?')) return;
    try {
      await apiFetch(`/api/commission-tiers/${id}`, { method: 'DELETE' });
      fetchTiers();
    } catch (e) { console.error(e); }
  };

  const resetForm = () => {
    setNewName(''); setNewPhone(''); setNewEmail(''); setNewPassword(''); setCommissionPct(0); setParentId('');
    setTemplateTitle(''); setTemplateContent('');
    setIsAdding(false); setEditingId(null);
  };

  const handleEdit = (member: StaffMember) => {
    setEditingId(member.id);
    setNewName(member.name);
    setNewPhone(member.phone);
    setNewEmail(member.email || '');
    setCommissionPct(member.commissionPct || 0);
    setParentId(member.parentId || '');
    setNewPassword('');
    setIsAdding(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (activeTab === 'Templates') {
      if (!templateTitle || !templateContent) return;
      try {
        const res = await apiFetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editingId, title: templateTitle, content: templateContent })
        });
        if (res.ok) { fetchTemplates(); resetForm(); }
      } catch (err) { console.error(err); }
      return;
    }

    if (!newName || !newPhone || !newEmail) { alert("Campos obligatorios: Nombre, Celular y Correo"); return; }
    if (!Number.isFinite(Number(commissionPct)) || Number(commissionPct) < 0 || Number(commissionPct) > 100) { alert("La comisión base debe estar entre 0 y 100."); return; }
    onAddStaff({
      id: editingId || undefined,
      name: newName,
      phone: normalizePhoneCO(newPhone),
      // v5.2 El rol se guarda en minúscula (antes se mandaba el valor de
      // la pestaña con mayúscula: 'Advisor'/'Sales_Agent').
      role: (activeTab === 'Distribution' || activeTab === 'CommissionTiers') ? 'advisor' : activeTab,
      email: newEmail,
      password: newPassword || undefined,
      commissionPct: Number(commissionPct),
      parentId: parentId || undefined,
      active: true
    });
    resetForm();
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('¿Seguro que deseas eliminar esta plantilla?')) return;
    try {
      const res = await apiFetch(`/api/templates/${id}`, { method: 'DELETE' });
      if (res.ok) fetchTemplates();
    } catch (err) { console.error(err); }
  };

  // v5.2 Pestañas de rol en minúscula, igual que en la BD y el JWT.
  const tabs = currentUser.role === 'admin' 
    ? ['admin', 'sales_agent', 'advisor', 'operator', 'Templates', 'Distribution', 'CommissionTiers']
    : currentUser.role === 'sales_agent'
    ? ['advisor', 'Templates']
    : [];

  const getSubordinates = (agentId: string) => {
    return staff.filter(s => s.parentId?.toString() === agentId.toString());
  };



  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-black text-slate-800">
            {currentUser.role === 'sales_agent' ? 'Gestión de mi red de ventas' : 'Equipo & Recursos'}
          </h1>
          <p className="text-slate-500 text-sm font-medium">
            Administra personal y supervisa el reparto automático en tiempo real
          </p>
        </div>
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="flex border-b border-slate-200 overflow-x-auto bg-slate-50/50">
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); resetForm(); }}
              className={`flex-1 py-5 px-4 text-[10px] font-black uppercase tracking-widest text-center transition-all whitespace-nowrap ${
                activeTab === tab ? 'text-brand-600 border-b-2 border-brand-600 bg-white' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {tab === 'Distribution' ? 'Config. Reparto' : 
               tab === 'Templates' ? 'Plantillas Chat' : 
               tab === 'CommissionTiers' ? 'Escalafón Comisiones' :
               // v5.2 B4: nombre claro del rol (Vendedor / Líder de ventas).
               roleLabel(tab)}
            </button>
          ))}
        </div>

        <div className="p-8">
          {activeTab === 'CommissionTiers' ? (
             <div className="space-y-10 animate-in fade-in duration-500">
                <div className="bg-brand-600 rounded-[2rem] p-8 text-white relative overflow-hidden shadow-xl shadow-brand-500/20">
                   <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 blur-[100px] rounded-full" />
                   <div className="relative">
                      <div className="flex items-center gap-3 mb-2">
                        <TrendingUp className="w-6 h-6" />
                        <h3 className="text-[10px] font-black uppercase tracking-[0.3em]">Gestión de Rangos</h3>
                      </div>
                      <h2 className="text-xl font-black">Escalafón Dinámico de Ventas</h2>
                      <p className="text-brand-100 text-xs font-medium max-w-lg mt-2">
                        Configura cuánto ganan los vendedores y líderes de ventas según su recaudo mensual. El sistema aplicará el porcentaje automáticamente.
                      </p>
                   </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                   {/* Formulario Nuevo Rango */}
                   <div className="bg-slate-50 p-6 rounded-[2rem] border-2 border-slate-200 space-y-4">
                      <h4 className="text-[10px] font-black uppercase text-slate-400 mb-4">Añadir Nuevo Rango</h4>
                      <div>
                        <label className="text-[9px] font-black uppercase text-slate-400 block mb-1">Rol</label>
                        <select 
                          value={newTier.role} 
                          onChange={e => setNewTier({...newTier, role: e.target.value as any})}
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-black outline-none"
                        >
                          <option value="advisor">Vendedor</option>
                          <option value="sales_agent">Líder de ventas</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[9px] font-black uppercase text-slate-400 block mb-1">Mínimo Recaudado</label>
                        <input 
                          type="number" 
                          value={newTier.min_value} 
                          onChange={e => setNewTier({...newTier, min_value: Number(e.target.value)})}
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-black outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] font-black uppercase text-slate-400 block mb-1">Máximo Recaudado</label>
                        <input 
                          type="number" 
                          value={newTier.max_value} 
                          onChange={e => setNewTier({...newTier, max_value: Number(e.target.value)})}
                          className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-black outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] font-black uppercase text-slate-400 block mb-1">% Comisión</label>
                        <input 
                          type="number" step="0.1" 
                          value={newTier.percentage} 
                          onChange={e => setNewTier({...newTier, percentage: Number(e.target.value)})}
                          className="w-full bg-white border border-brand-200 rounded-xl px-4 py-2 text-base font-black text-brand-600 outline-none"
                        />
                      </div>
                      {tierError && (
                        <p className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl text-xs font-bold">{tierError}</p>
                      )}
                      <button 
                        onClick={handleAddTier}
                        className="w-full bg-brand-600 text-white py-3 rounded-xl text-[10px] font-black uppercase shadow-lg shadow-brand-500/20"
                      >
                        Guardar Rango
                      </button>
                   </div>

                   {/* Listado de Rangos */}
                   <div className="lg:col-span-2 space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {['advisor', 'sales_agent'].map(role => (
                          <div key={role} className="space-y-3">
                             <h5 className="text-[10px] font-black uppercase text-brand-500 px-2 flex items-center gap-2">
                               {role === 'advisor' ? <Users className="w-3 h-3" /> : <Network className="w-3 h-3" />}
                               Escalafón {roleLabel(role)}
                             </h5>
                             <div className="space-y-2">
                               {tiers.filter(t => (t.role || '').toLowerCase() === role).map(tier => (
                                 <div key={tier.id} className="bg-white border border-slate-100 p-4 rounded-2xl flex items-center justify-between group hover:border-brand-200 shadow-sm transition-all">
                                    <div className="flex-1">
                                       <div className="flex items-center gap-2">
                                          <span className="text-[10px] font-black text-slate-800">{formatCurrency(Number(tier.min_value))}</span>
                                          <ChevronRight className="w-3 h-3 text-slate-300" />
                                          <span className="text-[10px] font-black text-slate-800">{tier.max_value > 500000000 ? 'Más' : formatCurrency(Number(tier.max_value))}</span>
                                       </div>
                                       <p className="text-[9px] font-bold text-slate-400 uppercase mt-1">Gana el {tier.percentage}%</p>
                                    </div>
                                    <button onClick={() => handleDeleteTier(tier.id)} className="p-2 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"><Trash2 className="w-4 h-4" /></button>
                                 </div>
                               ))}
                             </div>
                          </div>
                        ))}
                      </div>
                   </div>
                </div>
             </div>
          ) : activeTab === 'Distribution' ? (
             <div className="space-y-10 animate-in fade-in duration-500">
                <div className="bg-slate-900 rounded-[2rem] p-8 text-white relative overflow-hidden shadow-xl">
                   <div className="absolute top-0 right-0 w-64 h-64 bg-brand-500/10 blur-[100px] rounded-full" />
                   <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-8">
                      <div className="space-y-2">
                         <div className="flex items-center gap-2 text-brand-400">
                            <SlidersHorizontal className="w-5 h-5" />
                            <h3 className="text-[10px] font-black uppercase tracking-[0.3em]">Reglas Operativas</h3>
                         </div>
                         <h2 className="text-xl font-black">Asignación y Capacidad</h2>
                         <p className="text-slate-400 text-xs font-medium max-w-md">Define tiempos de reasignación y la capacidad diaria de tus operarios por turno.</p>
                      </div>
                      
                      <div className="bg-white/5 border border-white/10 p-6 rounded-2xl flex flex-col md:flex-row items-center gap-8">
                         <div className="text-center md:text-left">
                            <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Reasignación (Min)</p>
                            <input 
                              type="number" 
                              value={Number.isFinite(reassignmentTimeout) ? reassignmentTimeout : ''} 
                              onChange={e => { const v = parseInt(e.target.value); setReassignmentTimeout(Number.isFinite(v) ? v : 0); }} 
                              className="w-16 bg-white/10 border-none rounded-xl text-center font-black text-xl outline-none" 
                            />
                         </div>
                         <div className="text-center md:text-left">
                            <p className="text-[9px] font-black uppercase tracking-widest text-brand-400 mb-1">Operarios por Turno</p>
                            <div className="flex items-center gap-2">
                              <Users className="w-4 h-4 text-brand-400" />
                              <input 
                                type="number" 
                                value={Number.isFinite(dailyCapacity) ? dailyCapacity : ''} 
                                onChange={e => { const v = parseInt(e.target.value); setDailyCapacity(Number.isFinite(v) ? v : 0); }} 
                                className="w-16 bg-brand-500/20 border border-brand-500/30 rounded-xl text-center font-black text-xl text-brand-400 outline-none" 
                              />
                            </div>
                         </div>
                         <button 
                           onClick={handleSaveDistributionSettings}
                           disabled={isSavingSettings}
                           className="bg-brand-600 hover:bg-brand-700 text-white px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg flex items-center gap-2 disabled:opacity-50 transition-all"
                         >
                            {isSavingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Guardar
                         </button>
                      </div>
                   </div>
                </div>

                <div className="space-y-6">
                   <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                      <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                        <Activity className="w-4 h-4 text-emerald-500" /> Cola de vendedores en línea
                      </h3>
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                           <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                           <span className="text-[10px] font-black uppercase text-slate-400 tracking-tighter">{distributionQueue.length} Disponibles</span>
                        </div>
                      </div>
                   </div>

                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                     {distributionQueue.map((adv, i) => (
                       <div key={adv.id} className={`group relative p-6 rounded-[2rem] border-2 transition-all flex flex-col gap-4 overflow-hidden ${i === 0 ? 'bg-brand-50 border-brand-500 shadow-xl shadow-brand-500/10' : 'bg-white border-slate-100'}`}>
                          {i === 0 && (
                             <div className="absolute top-0 right-0 bg-brand-600 text-white text-[8px] font-black uppercase px-4 py-1 rounded-bl-xl shadow-md">
                               Próximo Turno
                             </div>
                          )}
                          <div className="flex items-center gap-4">
                             <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black text-xl shadow-sm ${i === 0 ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                                {adv.name.charAt(0)}
                             </div>
                             <div>
                                <h4 className="font-black text-slate-800 text-sm leading-tight">{adv.name}</h4>
                                <p className="text-[9px] font-bold uppercase text-slate-400 mt-0.5">{adv.parentName ? `Líder: ${adv.parentName}` : 'Venta Directa'}</p>
                             </div>
                          </div>
                          <div className={`mt-2 p-4 rounded-xl flex items-center justify-between ${i === 0 ? 'bg-white/50 border border-brand-200' : 'bg-slate-50 border border-slate-100'}`}>
                             <div className="flex items-center gap-2">
                                <Timer className={`w-4 h-4 ${i === 0 ? 'text-brand-600' : 'text-slate-300'}`} />
                                <span className="text-[9px] font-black text-slate-400 uppercase">Tiempo de Espera</span>
                             </div>
                             <span className={`text-sm font-black ${i === 0 ? 'text-brand-700' : 'text-slate-700'}`}>{getWaitTime(adv.lastAssignedAt)}</span>
                          </div>
                       </div>
                     ))}
                   </div>
                   
                   {distributionQueue.length === 0 && (
                     <div className="py-24 text-center bg-slate-50 border-2 border-dashed border-slate-200 rounded-[3rem] animate-pulse">
                        <Coffee className="w-16 h-16 mx-auto mb-4 text-slate-300" />
                        <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">No hay asesores disponibles</h3>
                        <p className="text-xs text-slate-300 font-bold mt-2">Los asesores deben marcarse como "Disponibles" para recibir leads.</p>
                     </div>
                   )}
                </div>
             </div>
          ) : (
            <>
              {!isAdding ? (
                <div className="flex justify-between items-center mb-8">
                   <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                     <Users className="w-4 h-4" /> {activeTab === 'Templates' ? 'Respuestas Rápidas' : `Listado de ${roleLabel(activeTab)}`}
                   </h3>
                   <button onClick={() => setIsAdding(true)} className="bg-brand-600 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-lg hover:shadow-brand-500/20 transition-all active:scale-95 flex items-center gap-2">
                     <Plus className="w-4 h-4" /> Agregar
                   </button>
                </div>
              ) : (
                <div className="mb-10 bg-slate-50 p-8 rounded-[2rem] border-2 border-slate-200 shadow-inner">
                   <div className="flex justify-between items-center mb-8">
                     <h4 className="font-black text-slate-800 uppercase tracking-widest text-sm">
                       {editingId ? 'Editar Registro' : 'Nuevo Registro'}
                     </h4>
                     <button onClick={resetForm} className="text-slate-400 hover:text-slate-600"><X className="w-6 h-6"/></button>
                   </div>
                   {(activeTab === 'advisor' || activeTab === 'sales_agent') && (
                     <p className="text-xs font-bold text-slate-500 bg-white border border-slate-200 rounded-xl px-4 py-3 mb-6">
                       {activeTab === 'advisor'
                         ? 'Vendedor: vende solo y atiende a sus propios clientes.'
                         : 'Líder de ventas: vende y tiene su red — los vendedores que dependen de él y cuyas ventas también cuentan para su comisión.'}
                     </p>
                   )}
                   <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {activeTab === 'Templates' ? (
                        <>
                          <div className="col-span-full">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Título</label>
                            <input type="text" required value={templateTitle} onChange={e => setTemplateTitle(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none" />
                          </div>
                          <div className="col-span-full">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Mensaje</label>
                            <textarea required value={templateContent} onChange={e => setTemplateContent(e.target.value)} rows={5} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none resize-none" />
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Nombre Completo</label>
                            <input type="text" required value={newName} onChange={e => setNewName(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none" />
                          </div>
                          <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">WhatsApp (sin +)</label>
                            <input type="tel" required value={newPhone} onChange={e => setNewPhone(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none" />
                          </div>
                          <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Correo Acceso</label>
                            <input type="email" required value={newEmail} onChange={e => setNewEmail(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none" />
                          </div>
                          <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Contraseña</label>
                            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder={editingId ? 'Mantener actual' : '******'} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none" />
                          </div>
                          <div className="bg-brand-50 p-5 rounded-2xl border border-brand-100">
                            <label className="text-[10px] font-black text-brand-600 uppercase tracking-widest mb-2 block">% Comisión Base (Falla-Safe)</label>
                            <input type="number" step="0.1" value={commissionPct} onChange={e => setCommissionPct(Number(e.target.value))} className="w-full bg-white border border-brand-200 rounded-xl px-4 py-3 text-lg font-black text-brand-700 outline-none" />
                          </div>
                          {activeTab === 'advisor' && (
                            <div className="bg-slate-100 p-5 rounded-2xl border border-slate-200">
                              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Líder (Sales Agent)</label>
                              <select value={parentId} onChange={e => setParentId(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none">
                                <option value="">Venta Directa (Sin Líder)</option>
                                {salesAgents.map(sa => <option key={sa.id} value={sa.id}>{sa.name} ({sa.commissionPct}%)</option>)}
                              </select>
                            </div>
                          )}
                        </>
                      )}
                      <div className="col-span-full flex justify-end gap-3 pt-4">
                         <button type="button" onClick={resetForm} className="px-6 py-3 text-[10px] font-black uppercase text-slate-400">Cerrar</button>
                         <button type="submit" className="bg-brand-600 text-white px-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-brand-500/30">Guardar</button>
                      </div>
                   </form>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4">
                 {activeTab === 'Templates' ? (
                   templates.map(tpl => (
                     <div key={tpl.id} className="bg-white border-2 border-slate-50 p-6 rounded-[2rem] flex items-center justify-between">
                        <div className="flex items-center gap-6">
                           <MessageSquare className="w-8 h-8 text-brand-600" />
                           <div>
                              <h4 className="font-black text-slate-800 text-lg leading-tight">{tpl.title}</h4>
                              <p className="text-[11px] font-medium text-slate-500 mt-2 line-clamp-1 italic">"{tpl.content}"</p>
                           </div>
                        </div>
                        <div className="flex gap-2">
                           <button onClick={() => handleDeleteTemplate(tpl.id)} className="p-3 bg-red-50 text-red-500 rounded-xl hover:bg-red-100 transition-colors"><Trash2 className="w-5 h-5" /></button>
                        </div>
                     </div>
                   ))
                 ) : (
                   filteredStaff.map(member => {
                     const subMembers = (member.role || '').toLowerCase() === 'sales_agent' ? getSubordinates(member.id) : [];
                     return (
                       <div key={member.id} className={`group bg-white border-2 p-6 rounded-[2rem] flex flex-col gap-4 relative overflow-hidden ${member.role === 'sales_agent' ? 'border-brand-100 shadow-sm' : 'border-slate-50'}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-6">
                               <div className="relative">
                                  <div className={`w-16 h-16 rounded-[1.5rem] flex items-center justify-center font-black text-2xl shadow-inner uppercase ${member.role === 'sales_agent' ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-600'}`}>
                                    {member.name.charAt(0)}
                                  </div>
                                  {(member.role || '').toLowerCase() !== 'operator' && (
                                    <div className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white ${member.isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                  )}
                               </div>
                               <div>
                                  <div className="flex items-center gap-3">
                                     <h4 className="font-black text-slate-800 text-lg leading-tight">{member.name}</h4>
                                     <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest ${member.role === 'sales_agent' ? 'bg-slate-800 text-white' : 'bg-brand-100 text-brand-600'}`}>
                                       Base: {member.commissionPct}%
                                     </span>
                                  </div>
                                  <div className="flex items-center gap-4 mt-1">
                                     <span className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> {member.email}</span>
                                     {member.parentName && (
                                       <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded flex items-center gap-1.5">
                                          <Network className="w-3 h-3" /> LÍDER: {member.parentName.toUpperCase()}
                                       </span>
                                     )}
                                     {member.role === 'sales_agent' && (
                                       <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded flex items-center gap-1.5 ${subMembers.length > 0 ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-400'}`}>
                                          <Users className="w-3 h-3" /> RED ACTIVA: {subMembers.length} vendedores
                                       </span>
                                     )}
                                  </div>
                               </div>
                            </div>
                            <div className="flex items-center gap-2">
                               <button onClick={() => handleEdit(member)} className="p-3 bg-slate-50 text-slate-400 hover:bg-brand-50 hover:text-brand-600 rounded-xl transition-all"><Edit3 className="w-5 h-5" /></button>
                               <button onClick={() => onRemoveStaff(member.id)} className="p-3 bg-slate-50 text-slate-400 hover:bg-red-50 hover:text-red-500 rounded-xl transition-all"><Trash2 className="w-5 h-5" /></button>
                            </div>
                          </div>
                          {member.role === 'sales_agent' && subMembers.length > 0 && (
                            <div className="mt-2 pt-4 border-t border-slate-50">
                               <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                                 <ChevronRight className="w-3 h-3 text-brand-400" /> Vendedores en su red:
                               </p>
                               <div className="flex flex-wrap gap-2">
                                  {subMembers.map(sub => (
                                    <div key={sub.id} className="bg-slate-50 border border-slate-100 px-3 py-1.5 rounded-xl flex items-center gap-2">
                                       <div className="w-5 h-5 bg-brand-600 text-white rounded-md flex items-center justify-center text-[8px] font-black uppercase">{sub.name.charAt(0)}</div>
                                       <span className="text-[10px] font-bold text-slate-700">{sub.name}</span>
                                       <span className="text-[8px] font-black text-slate-300 uppercase">{sub.commissionPct}%</span>
                                    </div>
                                  ))}
                               </div>
                            </div>
                          )}
                          {member.role === 'sales_agent' && subMembers.length === 0 && (
                            <div className="mt-2 pt-4 border-t border-slate-50">
                               <p className="text-[9px] font-bold text-slate-300 italic flex items-center gap-2">
                                 <AlertCircle className="w-3 h-3" /> Este líder aún no tiene vendedores asignados a su red.
                               </p>
                            </div>
                          )}
                       </div>
                     );
                   })
                 )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
