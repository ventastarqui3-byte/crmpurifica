
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Users, Calendar, Clock, ChevronUp, ChevronDown, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface AvailabilityData {
  date: string;
  am_count: string;
  pm_count: string;
}

export const CapacityWidget: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dbAvailability, setDbAvailability] = useState<AvailabilityData[]>([]);
  const [maxCapacity, setMaxCapacity] = useState(15);

  // --- LÓGICA DE ARRASTRE (DRAGGABLE) ---
  const [position, setPosition] = useState({ x: 24, y: window.innerHeight - 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const totalMovement = useRef(0);

  const handleStart = (clientX: number, clientY: number) => {
    setIsDragging(true);
    totalMovement.current = 0;
    dragStartPos.current = {
      x: clientX - position.x,
      y: clientY - position.y
    };
  };

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!isDragging) return;
    
    const newX = clientX - dragStartPos.current.x;
    const newY = clientY - dragStartPos.current.y;
    
    // Calcular distancia movida para distinguir click de drag
    const deltaX = Math.abs(newX - position.x);
    const deltaY = Math.abs(newY - position.y);
    totalMovement.current += (deltaX + deltaY);

    // Mantener dentro de los límites de la pantalla
    const boundedX = Math.max(10, Math.min(window.innerWidth - 70, newX));
    const boundedY = Math.max(10, Math.min(window.innerHeight - 70, newY));

    setPosition({ x: boundedX, y: boundedY });
  }, [isDragging, position]);

  const handleEnd = () => {
    setIsDragging(false);
  };

  // Eventos de Mouse
  const onMouseDown = (e: React.MouseEvent) => handleStart(e.clientX, e.clientY);
  // Eventos de Touch
  const onTouchStart = (e: React.TouchEvent) => handleStart(e.touches[0].clientX, e.touches[0].clientY);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => handleMove(e.touches[0].clientX, e.touches[0].clientY);
    const onEnd = () => handleEnd();

    if (isDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchmove', onTouchMove);
      window.addEventListener('touchend', onEnd);
    }

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [isDragging, handleMove]);

  const toggleWidget = (e: React.MouseEvent | React.TouchEvent) => {
    // Si el movimiento fue pequeño (menos de 5px), lo tratamos como un click para abrir
    if (totalMovement.current < 5) {
      setIsOpen(!isOpen);
    }
  };

  // --- LÓGICA DE DATOS ---
  // Fecha en America/Bogota: toISOString() es UTC y después de las 19:00
  // en Bogotá ya era "mañana" (el widget perdía el día real).
  // Sin useMemo vacío: el widget vive toda la sesión y tras medianoche
  // los 7 días quedaban viejos. Se recalcula en cada render.
  const nextSevenDays = (() => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      days.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }));
    }
    return days;
  })();

  const fetchAvailability = async () => {
    setLoading(true);
    try {
      const [resAvail, resSett] = await Promise.all([
        apiFetch('/api/availability'),
        apiFetch('/api/settings')
      ]);
      if (resAvail.ok) setDbAvailability(await resAvail.json());
      if (resSett.ok) {
        const settings = await resSett.json();
        if (settings.daily_capacity) setMaxCapacity(parseInt(settings.daily_capacity));
      }
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  useEffect(() => {
    if (isOpen) fetchAvailability();
  }, [isOpen]);

  const fullAvailability = useMemo(() => {
    return nextSevenDays.map(date => {
      const found = dbAvailability.find(db => db.date === date);
      return {
        date,
        am_count: found ? parseInt(found.am_count) : 0,
        pm_count: found ? parseInt(found.pm_count) : 0
      };
    });
  }, [nextSevenDays, dbAvailability]);

  const getStatusColor = (count: number) => {
    const usage = (count / maxCapacity) * 100;
    if (usage >= 100) return 'bg-red-500 text-white';
    if (usage >= 80) return 'bg-amber-500 text-white';
    return 'bg-emerald-500 text-white';
  };

  const getProgressWidth = (count: number) => {
    return Math.min((count / maxCapacity) * 100, 100) + '%';
  };

  return (
    <div 
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      className={`fixed z-[200] flex flex-col items-start gap-3 transition-transform ${isDragging ? 'scale-110 cursor-grabbing' : 'cursor-grab'}`}
    >
      {isOpen && (
        <div 
          className="absolute bottom-full left-0 mb-4 bg-white rounded-[2rem] shadow-2xl border border-slate-200 w-80 max-h-[450px] overflow-hidden flex flex-col animate-in slide-in-from-bottom-4 duration-300"
          onMouseDown={(e) => e.stopPropagation()} // Evitar que el drag se active al clickear el panel interno
          onTouchStart={(e) => e.stopPropagation()}
        >
          <div className="p-5 border-b bg-slate-50/50 flex items-center justify-between">
            <div>
               <h3 className="text-sm font-black text-slate-800 uppercase tracking-tighter flex items-center gap-2">
                 <Users className="w-4 h-4 text-brand-600" /> Capacidad Operativa
               </h3>
               <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Base: {maxCapacity} operarios</p>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-slate-600">
               <ChevronDown className="w-6 h-6" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
             {loading && (
               <div className="py-20 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-brand-600" /></div>
             )}
             
             {!loading && fullAvailability.map((day) => (
               <div key={day.date} className="space-y-2 pb-2 border-b border-slate-50 last:border-0">
                  <div className="flex justify-between items-center mb-2">
                     <span className="text-[10px] font-black text-slate-600 uppercase flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-brand-500" /> 
                        {new Date(day.date + 'T00:00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric' })}
                     </span>
                  </div>
                  
                  <div className="space-y-3">
                     <div className="space-y-1">
                        <div className="flex justify-between text-[9px] font-black uppercase">
                           <span className="text-slate-400 flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Mañana (AM)</span>
                           <span className={day.am_count >= maxCapacity ? 'text-red-500' : 'text-slate-500'}>
                             {day.am_count} / {maxCapacity}
                           </span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                           <div 
                             className={`h-full transition-all duration-1000 ${getStatusColor(day.am_count)}`} 
                             style={{ width: getProgressWidth(day.am_count) }} 
                           />
                        </div>
                     </div>

                     <div className="space-y-1">
                        <div className="flex justify-between text-[9px] font-black uppercase">
                           <span className="text-slate-400 flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Tarde (PM)</span>
                           <span className={day.pm_count >= maxCapacity ? 'text-red-500' : 'text-slate-500'}>
                             {day.pm_count} / {maxCapacity}
                           </span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                           <div 
                             className={`h-full transition-all duration-1000 ${getStatusColor(day.pm_count)}`} 
                             style={{ width: getProgressWidth(day.pm_count) }} 
                           />
                        </div>
                     </div>
                  </div>
               </div>
             ))}
          </div>
          
          <div className="p-4 bg-emerald-50 border-t border-emerald-100">
             <p className="text-[9px] font-black text-emerald-700 uppercase leading-relaxed flex items-center gap-2">
               <AlertCircle className="w-3.5 h-3.5" /> Se cuentan los servicios no cancelados de cada turno.
             </p>
          </div>
        </div>
      )}

      <button 
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        onClick={toggleWidget}
        className={`p-4 rounded-full shadow-2xl transition-all hover:scale-110 active:scale-95 flex items-center gap-3 border-2 border-white select-none ${isOpen ? 'bg-slate-900 text-white' : 'bg-brand-600 text-white'}`}
      >
        <Users className="w-6 h-6 pointer-events-none" />
        {!isOpen && <span className="text-xs font-black uppercase pr-2 pointer-events-none">Disponibilidad</span>}
        {isOpen ? <ChevronDown className="w-4 h-4 pointer-events-none" /> : <ChevronUp className="w-4 h-4 pointer-events-none" />}
      </button>
    </div>
  );
};
