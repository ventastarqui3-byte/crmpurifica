
import React, { useState, useMemo, useEffect } from 'react';
import {CurrentUser, StaffMember, DealStatus, ViewState, StatsOverview, StatsCommissions, EmployeeCommission, roleLabel} from '../types';
import * as XLSX from 'xlsx';
import { motion } from 'framer-motion';
import {DollarSign, TrendingUp, Calculator, Award, ChevronRight, BarChart3, PieChart as PieChartIcon, Wallet, Percent, Users, CheckCircle, FileSpreadsheet, UserCheck, Target, Medal, Trash2, Timer} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';

interface DashboardProps {
  currentUser: CurrentUser;
  staff: StaffMember[];
  onNavigate?: (view: ViewState) => void;
}

type TimeRange = 'all' | 'month' | 'week' | 'today';
type DashboardTab = 'summary' | 'accounting' | 'ranking';

export const Dashboard: React.FC<DashboardProps> = ({ currentUser, staff, onNavigate }) => {
  const [timeRange, setTimeRange] = useState<TimeRange>('month');
  const [activeTab, setActiveTab] = useState<DashboardTab>('summary');
  const [now, setNow] = useState(new Date());
  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [commissions, setCommissions] = useState<StatsCommissions | null>(null);
  const [commissionsError, setCommissionsError] = useState(false);
  // Solo para el operario: su pago propio (dashboard-stats con su rol).
  // Los totales globales vienen de /api/stats/overview, no de aquí.
  const [myStats, setMyStats] = useState<any>(null);
  const [ranking, setRanking] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Reintento manual si el endpoint de totales falla (ver aviso abajo).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const fetchDashboardData = async () => {
      setLoading(true);
      setCommissionsError(false);
      try {
        // Totales globales del servidor (SQL sobre todos los registros,
        // sin LIMIT 50) + comisiones reales por escalafón + ranking.
        const [overviewRes, commissionsRes, rankingRes, scopedRes] = await Promise.all([
          apiFetch(`/api/stats/overview?timeRange=${timeRange}`),
          apiFetch(`/api/stats/commissions?timeRange=${timeRange}`),
          apiFetch(`/api/ranking?timeRange=${timeRange}`),
          // v5.2 El alcance sale del JWT del servidor; ya no se mandan
          // role/userName/userId por query (antes cualquiera podía
          // pedirse otro rol o usuario).
          apiFetch(`/api/dashboard-stats?timeRange=${timeRange}`)
        ]);

        if (overviewRes.ok) setStats(await overviewRes.json());
        if (commissionsRes.ok) setCommissions(await commissionsRes.json());
        else setCommissionsError(true);
        if (rankingRes.ok) setRanking(await rankingRes.json());
        if (scopedRes.ok) setMyStats(await scopedRes.json());
      } catch (e) {
        console.error('Error fetching dashboard data:', e);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, [timeRange, currentUser, reloadKey]);

  // Actualizar el reloj para los tiempos de espera cada minuto
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  
  const isOperator = currentUser.role === 'operator';
  const isAdmin = currentUser.role === 'admin' || currentUser.role === 'sales_agent';
  
  const shouldShowQueue = isAdmin;

  const dashboardStats = useMemo(() => {
    // Datos parciales: si fallan las comisiones, se renderiza igual con
    // comisiones en 0 y aviso visible (antes: spinner infinito porque
    // !stats || !commissions dejaba dashboardStats en null).
    if (!stats) return null;

    const rev = stats.revenue;
    const grossIncome = Number(rev.grossIncome) || 0;
    const totalExpenses = Number(rev.totalExpenses) || 0;
    const totalOperatorPayments = Number(rev.totalOperatorPayments) || 0;

    const operatingCosts = totalExpenses + totalOperatorPayments;
    // Comisiones reales del servidor (escalafón commission_tiers): ya no
    // hay estimación fija. Si el endpoint falló, es 0 y se avisa arriba
    // y en la pestaña Contabilidad.
    const totalCommissions = Number(commissions?.totalCommissions) || 0;
    const netCompanyProfit = grossIncome - operatingCosts - totalCommissions;

    return {
      grossIncome,
      totalExpenses,
      totalOperatorPayments,
      operatingCosts,
      totalCommissions,
      netCompanyProfit,
      totalServices: Number(rev.totalServices) || 0,
      projections: {
        [DealStatus.SCHEDULED]: Number(rev.scheduledValue) || 0,
        [DealStatus.CONFIRMED]: Number(rev.confirmedValue) || 0,
        [DealStatus.RESCHEDULED]: Number(rev.rescheduledValue) || 0,
        [DealStatus.DONE]: Number(rev.doneValue) || 0,
        [DealStatus.PAID]: Number(rev.paidValue) || 0
      }
    };
  }, [stats, commissions]);

  // Mi comisión del periodo, del servidor: el vendedor ve la suya por id;
  // admin y líder de ventas ven el total de la red. null = sin tramo aplicable.
  const myCommission = useMemo(() => {
    if (!commissions) return null;
    return commissions.commissions.find(c => c.employeeId === currentUser.id) || null;
  }, [commissions, currentUser.id]);

  const vendorRanking = useMemo(() => {
    return ranking.map(v => {
      const c: EmployeeCommission | undefined = commissions?.commissions.find(x => x.name === v.name);
      return { ...v, total: Number(v.total), comm: c?.commission ?? null, commPct: c?.percentage ?? null, commNote: c?.note ?? null };
    });
  }, [ranking, commissions]);

  const advisorQueue = useMemo(() => {
    return (staff || [])
      .filter(s => s.role?.toLowerCase() === 'advisor' && s.active !== false)
      .sort((a, b) => {
        // Priorizar Online sobre Offline
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        
        // Si ambos tienen mismo estado, ordenar por quien recibió lead hace más tiempo
        const timeA = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
        const timeB = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
        return timeA - timeB;
      });
  }, [staff]);

  const getWaitTime = (lastTime?: string) => {
    if (!lastTime) return 'Sin leads aún';
    const diff = now.getTime() - new Date(lastTime).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 0) return 'Justo ahora';
    if (mins === 0) return 'Hace < 1 min';
    return mins > 60 ? `Hace ${Math.floor(mins/60)}h ${mins%60}m` : `Hace ${mins} min`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] space-y-4">
        <motion.div 
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          className="w-12 h-12 border-4 border-brand-600 border-t-transparent rounded-full"
        />
        <motion.p 
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-slate-500 font-medium"
        >
          Cargando estadísticas...
        </motion.p>
      </div>
    );
  }

  // Sin totales del servidor no hay nada que dibujar: aviso con reintento
  // en vez del spinner infinito de antes.
  if (!dashboardStats) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] space-y-4 text-center px-6">
        <p className="text-lg font-black text-slate-700">No se pudieron cargar las estadísticas del servidor.</p>
        <p className="text-sm font-medium text-slate-500">Revisa la conexión y vuelve a intentarlo.</p>
        <button
          onClick={() => { setLoading(true); setReloadKey(k => k + 1); }}
          className="bg-brand-600 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-lg hover:bg-brand-700 transition-all"
        >
          Reintentar
        </button>
      </div>
    );
  }

  const exportAccounting = () => {
    const sheetData = [
      ["REPORTE CONTABLE - PURIFICA TU AMBIENTE"],
      ["Periodo:", timeRange.toUpperCase()],
      ["Fecha Reporte:", new Date().toLocaleDateString()],
      [],
      ["CONCEPTO", "VALOR"],
      ["Ingresos Brutos", dashboardStats.grossIncome],
      ["Gastos de Insumos", dashboardStats.totalExpenses],
      ["Pago a Operarios", dashboardStats.totalOperatorPayments],
      ["Comisiones Vendedores/Líderes de ventas (escalafón, servidor)", dashboardStats.totalCommissions],
      ["Utilidad Neta Empresa", dashboardStats.netCompanyProfit]
    ];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Contabilidad");
    XLSX.writeFile(wb, `Reporte_Contable_${timeRange}.xlsx`);
  };

  // Tarjeta principal: operario = sus pagos propios; asesor = su comisión
  // del servidor (0 con "sin tramo" si no aplica ningún escalafón);
  // admin/director = comisiones totales de la red.
  const gainValue = isOperator
    ? (Number(myStats?.totalOperatorPayments) || 0)
    : currentUser.role === 'advisor'
      ? (myCommission?.commission ?? 0)
      : dashboardStats.totalCommissions;
  const gainLabel = isOperator
    ? 'Total Acumulado'
    : currentUser.role === 'advisor'
      ? 'Mi comisión (escalafón)'
      : 'Comisiones red (escalafón)';
  const withoutTierCount = commissions?.commissions.filter(c => c.commission === null).length || 0;

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
             <BarChart3 className="w-8 h-8 text-brand-600" /> {isOperator ? 'Mis Ganancias' : 'Dashboard Operativo'}
          </h1>
          <p className="text-slate-500 font-medium">{isOperator ? 'Seguimiento de tus pagos y servicios realizados' : 'Gestión financiera y comercial - Purifica Tu Ambiente'}</p>
        </div>
        
        <div className="flex flex-col sm:flex-row items-end sm:items-center gap-4">
           <div className="flex items-center gap-2 bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200">
              {['today', 'week', 'month', 'all'].map((range) => (
                <button
                   key={range}
                   onClick={() => setTimeRange(range as TimeRange)}
                   className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${timeRange === range ? 'bg-brand-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  {range === 'all' ? 'Histórico' : range === 'today' ? 'Hoy' : range === 'week' ? 'Semana' : 'Mes'}
                </button>
              ))}
           </div>
        </div>
      </div>

      {stats?.scope && stats.scope.role !== 'admin' && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3 text-xs font-bold text-amber-800">
          Estás viendo solo tus números ({roleLabel(stats.scope.role)}). Los totales de toda la empresa solo los ve el administrador.
        </div>
      )}

      {commissionsError && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3 text-xs font-bold text-amber-800">
          No se pudieron cargar las comisiones del servidor: las comisiones y la utilidad neta se muestran en 0 en este periodo. Reintenta cambiando el periodo.
        </div>
      )}

      <div className="flex gap-1 bg-slate-200/50 p-1 rounded-2xl w-fit">
        <button onClick={() => setActiveTab('summary')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all ${activeTab === 'summary' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}><PieChartIcon className="w-4 h-4" /> Resumen</button>
        {isAdmin && (
          <button onClick={() => setActiveTab('ranking')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all ${activeTab === 'ranking' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}><Award className="w-4 h-4" /> Líderes</button>
        )}
        {currentUser.role === 'admin' && (
          <button onClick={() => setActiveTab('accounting')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all ${activeTab === 'accounting' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}><Calculator className="w-4 h-4" /> Contabilidad</button>
        )}
      </div>

      {activeTab === 'summary' && (
        <div className={`grid grid-cols-1 ${shouldShowQueue ? 'lg:grid-cols-4' : 'lg:grid-cols-1'} gap-8`}>
           <div className={shouldShowQueue ? 'lg:col-span-3 space-y-8' : 'space-y-8'}>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <motion.div 
                  whileHover={{ y: -5 }}
                  className="bg-brand-600 p-6 rounded-[2.5rem] shadow-xl shadow-brand-500/20 text-white"
                >
                  <div className="flex justify-between items-start mb-4">
                     <div className="bg-white/20 p-2 rounded-xl text-white"><Wallet className="w-5 h-5" /></div>
                     <span className="text-[10px] font-black text-brand-200 uppercase tracking-widest">{gainLabel}</span>
                  </div>
                  <h3 className="text-2xl font-black">{formatCurrency(gainValue)}</h3>
                  {currentUser.role === 'advisor' && myCommission?.commission === null && (
                    <p className="text-[10px] font-bold text-brand-200 mt-1">Sin tramo de escalafón para este periodo</p>
                  )}
                </motion.div>

                <motion.div 
                  whileHover={{ y: -5 }}
                  className="bg-white p-6 rounded-[2.5rem] shadow-sm border border-slate-100"
                >
                  <div className="flex justify-between items-start mb-4">
                     <div className="bg-emerald-50 p-2 rounded-xl text-emerald-600"><CheckCircle className="w-5 h-5" /></div>
                     <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Servicios</span>
                  </div>
                  <h3 className="text-2xl font-black text-slate-800">{dashboardStats.totalServices}</h3>
                </motion.div>

                <motion.div 
                  whileHover={{ y: -5 }}
                  className={`p-6 rounded-[2.5rem] shadow-sm border transition-all ${dashboardStats.netCompanyProfit >= 0 ? 'bg-white border-emerald-100' : 'bg-red-50 border-red-100'}`}
                >
                  <div className="flex justify-between items-start mb-4">
                     <div className={`p-2 rounded-xl ${dashboardStats.netCompanyProfit >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-100 text-red-600'}`}><TrendingUp className="w-5 h-5" /></div>
                     <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Utilidad Neta</span>
                  </div>
                  <h3 className={`text-2xl font-black ${dashboardStats.netCompanyProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(dashboardStats.netCompanyProfit)}</h3>
                </motion.div>
              </div>

              {!isOperator && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-white p-8 rounded-[3rem] shadow-sm border border-slate-100"
                >
                   <div className="flex items-center justify-between mb-8">
                      <h3 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 flex items-center gap-2"><Target className="w-4 h-4 text-brand-600" /> Proyección Pipeline</h3>
                      {/* Negocios es solo-admin (App protege la vista): el
                          botón no se muestra a otros roles. */}
                      {currentUser.role === 'admin' && (
                        <button onClick={() => onNavigate?.('deals')} className="text-[9px] font-black text-brand-600 uppercase flex items-center gap-1 hover:underline">Ver Todo <ChevronRight className="w-3 h-3" /></button>
                      )}
                   </div>
                   <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
                      {[
                        { label: 'Agendados', val: dashboardStats.projections[DealStatus.SCHEDULED], color: 'text-blue-600' },
                        { label: 'Confirmados', val: dashboardStats.projections[DealStatus.CONFIRMED], color: 'text-purple-600' },
                        { label: 'Reagendados', val: dashboardStats.projections[DealStatus.RESCHEDULED], color: 'text-orange-600' },
                        { label: 'Realizados', val: dashboardStats.projections[DealStatus.DONE], color: 'text-emerald-600' },
                        { label: 'Total Potencial', val: (Object.values(dashboardStats.projections) as number[]).reduce((a: number, b: number) => a + b, 0), color: 'text-slate-900' }
                      ].map((item, i) => (
                        <motion.div 
                          key={i}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.1 }}
                          className="space-y-1"
                        >
                           <p className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">{item.label}</p>
                           <p className={`text-sm font-black ${item.color}`}>{formatCurrency(item.val)}</p>
                        </motion.div>
                      ))}
                   </div>
                </motion.div>
              )}
           </div>

           {shouldShowQueue && (
             <motion.div 
               initial={{ opacity: 0, x: 20 }}
               animate={{ opacity: 1, x: 0 }}
               className="bg-slate-900 rounded-[2.5rem] p-8 text-white shadow-2xl relative overflow-hidden"
             >
                <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-brand-400 mb-6 flex items-center gap-2"><UserCheck className="w-4 h-4" /> Cola de Reparto</h3>
                <div className="space-y-4">
                   {advisorQueue.map((adv, i) => (
                      <motion.div 
                        key={adv.id} 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }}
                        className={`p-4 rounded-2xl border transition-all flex flex-col gap-2 ${adv.isOnline ? (i === 0 ? 'bg-emerald-500/20 border-emerald-500/50 shadow-lg shadow-emerald-500/10' : 'bg-white/5 border-white/10') : 'bg-slate-800/30 border-white/5 opacity-50'}`}
                      >
                         <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                               <div className={`w-2 h-2 rounded-full ${adv.isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
                               <p className="text-xs font-black">{adv.name}</p>
                            </div>
                            {adv.isOnline && i === 0 && (
                               <span className="text-[7px] font-black bg-emerald-500 text-white px-2 py-0.5 rounded-full uppercase">Siguiente</span>
                            )}
                         </div>
                         <div className="flex items-center justify-between text-[8px] font-bold text-slate-500">
                            <span className="uppercase">{adv.isOnline ? 'En Línea' : 'Desconectado'}</span>
                            <div className="flex items-center gap-1">
                               <Timer className="w-2.5 h-2.5" />
                               {getWaitTime(adv.lastAssignedAt)}
                            </div>
                         </div>
                      </motion.div>
                   ))}
                   {advisorQueue.length === 0 && (
                      <div className="py-10 text-center">
                         <p className="text-[10px] font-bold text-slate-500 uppercase italic">No hay vendedores activos</p>
                      </div>
                   )}
                </div>
             </motion.div>
           )}
        </div>
      )}

      {activeTab === 'ranking' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
           <div className="grid grid-cols-1 gap-4">
              {vendorRanking.map((vendor, index) => (
                <div key={vendor.name} className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm flex items-center justify-between group hover:border-brand-300 transition-all">
                   <div className="flex items-center gap-6">
                      <div className="relative">
                         <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black text-xl shadow-inner ${index === 0 ? 'bg-amber-100 text-amber-600' : 'bg-slate-50 text-slate-400'}`}>
                            {index + 1}
                         </div>
                         {index < 3 && (
                           <div className="absolute -top-2 -right-2 bg-white rounded-full p-1 shadow-md">
                              <Medal className={`w-5 h-5 ${index === 0 ? 'text-amber-500' : index === 1 ? 'text-slate-400' : 'text-orange-400'}`} />
                           </div>
                         )}
                      </div>
                      <div>
                         <h4 className="font-black text-slate-800 text-lg leading-none mb-1">{vendor.name}</h4>
                         <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">{vendor.count} servicios realizados</p>
                      </div>
                   </div>
                   <div className="text-right">
                      <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Ventas Totales</p>
                      <p className="text-xl font-black text-brand-600">{formatCurrency(vendor.total)}</p>
                      <p className="text-[9px] font-bold text-emerald-600 mt-1">Comisión (escalafón{vendor.commPct !== null ? ` ${vendor.commPct}%` : ''}): {vendor.comm === null ? 'sin tramo' : formatCurrency(vendor.comm)}</p>
                   </div>
                </div>
              ))}
           </div>
        </div>
      )}

      {activeTab === 'accounting' && (
        <div className="space-y-8 animate-in fade-in duration-500">
           {commissionsError && (
             <div className="bg-amber-50 border border-amber-200 text-amber-700 p-4 rounded-2xl text-xs font-bold">
               No se pudieron cargar las comisiones del servidor: las comisiones y la utilidad neta se muestran en 0 en este periodo. Reintenta cambiando el periodo.
             </div>
           )}
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100">
                 <p className="text-[10px] font-black text-slate-400 uppercase mb-2">Ingresos Brutos</p>
                 <h3 className="text-2xl font-black text-slate-800">{formatCurrency(dashboardStats.grossIncome)}</h3>
                 <div className="mt-4 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-500 w-full" />
                 </div>
              </div>
              <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100">
                 <p className="text-[10px] font-black text-slate-400 uppercase mb-2">Costo Operativo</p>
                 <h3 className="text-2xl font-black text-orange-600">{formatCurrency(dashboardStats.operatingCosts)}</h3>
                 <p className="text-[9px] font-bold text-slate-400 mt-1">Insumos + Pagos Operarios</p>
              </div>
              <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100">
                 <p className="text-[10px] font-black text-slate-400 uppercase mb-2">Comisiones Red</p>
                 <h3 className="text-2xl font-black text-purple-600">{formatCurrency(dashboardStats.totalCommissions)}</h3>
                 <p className="text-[9px] font-bold text-slate-400 mt-1">Asesores + Directores (Escalafón){withoutTierCount > 0 ? ` · ${withoutTierCount} sin tramo` : ''}</p>
              </div>
              <div className="bg-slate-900 p-6 rounded-[2.5rem] text-white">
                 <p className="text-[10px] font-black text-brand-400 uppercase mb-2">Utilidad Libre</p>
                 <h3 className="text-2xl font-black text-emerald-400">{formatCurrency(dashboardStats.netCompanyProfit)}</h3>
                 <p className="text-[9px] font-bold text-slate-500 mt-1">Ganancia real empresa</p>
              </div>
           </div>

           <div className="bg-white p-8 rounded-[3rem] border border-slate-100">
              <div className="flex justify-between items-center mb-8">
                 <h3 className="text-sm font-black uppercase tracking-widest text-slate-800">Detalle de Flujo (Lógica de Escalafón)</h3>
                 <button onClick={exportAccounting} className="flex items-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-2 rounded-xl text-[10px] font-black uppercase hover:bg-emerald-100 transition-all border border-emerald-200">
                    <FileSpreadsheet className="w-4 h-4" /> Exportar Reporte
                 </button>
              </div>
              
              <div className="space-y-4">
                 {[
                   { label: 'Facturación Realizada', val: dashboardStats.grossIncome, color: 'text-brand-600', icon: DollarSign },
                   { label: 'Pago Insumos y Materiales', val: dashboardStats.totalExpenses, color: 'text-red-500', icon: Trash2 },
                   { label: 'Costo de Mano de Obra (Operarios)', val: dashboardStats.totalOperatorPayments, color: 'text-orange-500', icon: Users },
                   { label: 'Comisiones Ventas (Asesores + Red)', val: dashboardStats.totalCommissions, color: 'text-purple-500', icon: Percent }
                 ].map((item, i) => (
                   <div key={i} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="flex items-center gap-4">
                         <div className="bg-white p-2 rounded-xl text-slate-400 shadow-sm"><item.icon className="w-5 h-5" /></div>
                         <span className="text-sm font-bold text-slate-600">{item.label}</span>
                      </div>
                      <span className={`text-lg font-black ${item.color}`}>{item.val > 0 && item.color === 'text-red-500' ? '-' : ''}{formatCurrency(item.val)}</span>
                   </div>
                 ))}
                 
                 <div className="flex items-center justify-between p-6 bg-slate-900 rounded-[2rem] mt-8">
                    <span className="text-lg font-black text-white uppercase tracking-widest">Resultado Operativo Neto</span>
                    <span className={`text-2xl font-black ${dashboardStats.netCompanyProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatCurrency(dashboardStats.netCompanyProfit)}</span>
                 </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};
