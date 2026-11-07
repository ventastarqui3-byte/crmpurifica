
import React, { useState, useEffect } from 'react';
import { ClientNote, ClientReminder, CurrentUser } from '../types';
import {StickyNote, Bell, Save, Trash2, Clock, Calendar, Plus, Loader2, Timer} from 'lucide-react';
import { apiFetch } from '../lib/api';

interface ClientIntelligenceProps {
  clientPhone: string;
  clientName: string;
  currentUser: CurrentUser;
}

export const ClientIntelligence: React.FC<ClientIntelligenceProps> = ({ clientPhone, clientName, currentUser }) => {
  const [note, setNote] = useState<ClientNote | null>(null);
  const [reminders, setReminders] = useState<ClientReminder[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  
  // Reminder Form
  const [isAddingReminder, setIsAddingReminder] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');

  const fetchData = async () => {
    if (!clientPhone) return;
    setLoading(true);
    try {
      const [resNote, resReminders] = await Promise.all([
        apiFetch(`/api/notes/${clientPhone}`),
        apiFetch(`/api/reminders/${clientPhone}`)
      ]);
      if (resNote.ok) setNote(await resNote.json());
      if (resReminders.ok) setReminders(await resReminders.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  useEffect(() => {
    fetchData();
  }, [clientPhone]);

  const handleSaveNote = async () => {
    if (!note) return;
    setSavingNote(true);
    try {
      await apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: clientPhone, content: note.content })
      });
      setTimeout(() => setSavingNote(false), 800);
    } catch (e) { console.error(e); setSavingNote(false); }
  };

  const handleAddReminder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle || !newDate || !newTime) return;
    try {
      const alertAt = `${newDate}T${newTime}:00`;
      const res = await apiFetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: clientPhone,
          name: clientName,
          title: newTitle,
          alertAt,
          createdBy: currentUser.name
        })
      });
      if (res.ok) {
        const nr = await res.json();
        setReminders(prev => [...prev, nr]);
        setNewTitle(''); setNewDate(''); setNewTime('');
        setIsAddingReminder(false);
      }
    } catch (e) { console.error(e); }
  };

  const deleteReminder = async (id: string) => {
    try {
      const res = await apiFetch(`/api/reminders/${id}`, { method: 'DELETE' });
      if (res.ok) setReminders(prev => prev.filter(r => r.id !== id));
    } catch (e) { console.error(e); }
  };

  const formatDateTime = (iso: string) => {
    return new Date(iso).toLocaleString('es-CO', { 
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' 
    });
  };

  if (loading) return <div className="p-10 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-brand-500" /></div>;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* SECCIÓN NOTAS */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
           <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
             <StickyNote className="w-4 h-4 text-amber-500" /> Notas sobre este Cliente
           </h3>
           <div className="flex items-center gap-2">
             {savingNote && <span className="text-[8px] font-black text-emerald-500 uppercase animate-pulse">Guardado</span>}
             <button onClick={handleSaveNote} className="p-1.5 hover:bg-slate-100 rounded-lg text-brand-600 transition-all"><Save className="w-4 h-4" /></button>
           </div>
        </div>
        <div className="relative group">
           <div className="absolute -top-2 -right-2 w-8 h-8 bg-amber-100/50 rounded-bl-[1.5rem] border-b border-l border-amber-200" />
           <textarea 
             value={note?.content || ''}
             onChange={e => setNote(prev => prev ? { ...prev, content: e.target.value } : { client_phone: clientPhone, content: e.target.value, updated_at: new Date().toISOString(), id: '0' })}
             onBlur={handleSaveNote}
             placeholder="Escribe aquí datos clave que debas recordar cada vez que este cliente te hable..."
             className="w-full h-40 bg-amber-50/50 border-2 border-amber-100 rounded-2xl p-4 text-xs font-bold text-amber-900 outline-none focus:bg-amber-50 transition-all shadow-inner"
           />
        </div>
      </section>

      {/* SECCIÓN RECORDATORIOS/ALARMAS */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
           <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
             <Bell className="w-4 h-4 text-red-500" /> Alarmas y Recordatorios
           </h3>
           {!isAddingReminder && (
             <button onClick={() => setIsAddingReminder(true)} className="p-1.5 bg-brand-50 text-brand-600 rounded-lg hover:bg-brand-100 transition-all">
               <Plus className="w-4 h-4" />
             </button>
           )}
        </div>

        {isAddingReminder && (
          <form onSubmit={handleAddReminder} className="bg-slate-50 border-2 border-slate-200 p-4 rounded-2xl space-y-3 animate-in zoom-in-95 duration-200">
             <input 
               type="text" 
               required
               placeholder="¿Qué debemos recordar?" 
               value={newTitle}
               onChange={e => setNewTitle(e.target.value)}
               className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold outline-none"
             />
             <div className="grid grid-cols-2 gap-2">
                <div className="relative">
                   <Calendar className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400" />
                   <input type="date" required value={newDate} onChange={e => setNewDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl pl-8 pr-2 py-2 text-xs font-bold outline-none" />
                </div>
                <div className="relative">
                   <Clock className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400" />
                   <input type="time" required value={newTime} onChange={e => setNewTime(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl pl-8 pr-2 py-2 text-xs font-bold outline-none" />
                </div>
             </div>
             <div className="flex gap-2">
                <button type="button" onClick={() => setIsAddingReminder(false)} className="flex-1 py-2 text-[9px] font-black uppercase text-slate-400">Cancelar</button>
                <button type="submit" className="flex-1 bg-brand-600 text-white py-2 rounded-xl text-[9px] font-black uppercase shadow-lg">Programar Alarma</button>
             </div>
          </form>
        )}

        <div className="space-y-3">
           {reminders.map(rem => (
             <div key={rem.id} className={`p-4 rounded-2xl border transition-all flex flex-col gap-2 ${rem.is_processed ? 'bg-slate-50 border-slate-100 opacity-60' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className="flex justify-between items-start">
                   <p className={`text-xs font-black flex-1 leading-snug ${rem.is_processed ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                     {rem.title}
                   </p>
                   <button onClick={() => deleteReminder(rem.id)} className="text-slate-300 hover:text-red-500 transition-colors p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
                <div className="flex items-center justify-between mt-1">
                   <div className="flex items-center gap-1.5 text-[9px] font-black text-slate-400 uppercase tracking-tighter">
                      <Timer className="w-3 h-3 text-brand-500" />
                      {formatDateTime(rem.alert_at)}
                   </div>
                   {!rem.is_processed && (
                     <div className="flex items-center gap-1">
                        <div className="w-2 h-2 bg-brand-500 rounded-full animate-pulse" />
                        <span className="text-[8px] font-black text-brand-600 uppercase">Alarma Activa</span>
                     </div>
                   )}
                </div>
             </div>
           ))}
           {reminders.length === 0 && !isAddingReminder && (
             <div className="py-10 text-center opacity-20">
                <Bell className="w-10 h-10 mx-auto mb-2" />
                <p className="text-[10px] font-black uppercase">Sin alarmas pendientes</p>
             </div>
           )}
        </div>
      </section>
    </div>
  );
};
