
import React, {useState, useEffect, useRef} from 'react';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { ServiceList } from './components/ServiceList';
import { ServiceForm } from './components/ServiceForm';
import { TeamManagement } from './components/TeamManagement';
import { ChatInbox } from './components/ChatInbox';
import { LeadPipeline } from './components/LeadPipeline';
import { BusinessDeals } from './components/BusinessDeals';
import { LoginScreen } from './components/LoginScreen';
import { ClientsList } from './components/ClientsList';
import { WhatsAppChannels } from './components/WhatsAppChannels';
import { CapacityWidget } from './components/CapacityWidget';
import { AuditModule } from './components/AuditModule';
import { DashboardSkeleton, ListSkeleton } from './components/Skeleton';
import { MessageSquare, X, BellRing, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { ServiceRecord, ViewState, StaffMember, ChatConversation, CurrentUser, ChatMessage, LeadRecord, LeadStatus, DealStatus, ClientSummary, ClientReminder } from './types';
import { notificationService } from './utils/NotificationService';
import { apiFetch, getToken, clearAuth } from './lib/api';
import { loadBranding } from './lib/branding';
import { BrandingSettings } from './components/BrandingSettings';
import { SystemStatus } from './components/SystemStatus';
import { Invoices } from './components/Invoices';

export default function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(() => {
    try {
      const savedUser = localStorage.getItem('purifica_session');
      return savedUser ? JSON.parse(savedUser) : null;
    } catch (e) {
      console.error("Error recuperando sesión", e);
      return null;
    }
  });

  const [currentView, setCurrentView] = useState<ViewState>('dashboard');
  const [isLoading, setIsLoading] = useState(true);
  const [preselectedChatPhone, setPreselectedChatPhone] = useState<string | null>(null);
  
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [totalServices, setTotalServices] = useState(0);
  const [servicesPage, setServicesPage] = useState(1);
  const [servicesSearch, setServicesSearch] = useState('');
  const [servicesFilters, setServicesFilters] = useState<any>({ startDate: '', endDate: '', location: 'all', staff: 'all', payment: 'all' });

  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [leadsPage, setLeadsPage] = useState(1);
  const [leadsSearch, setLeadsSearch] = useState('');
  const [leadsFilters, setLeadsFilters] = useState<any>({ status: 'all', startDate: '', endDate: '', location: 'all', source: 'all', minPrice: '', maxPrice: '', advisor: 'all' });

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [chats, setChats] = useState<ChatConversation[]>([]);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [totalClients, setTotalClients] = useState(0);
  const [clientsPage, setClientsPage] = useState(1);
  const [clientsSearch, setClientsSearch] = useState('');
  const [clientsFilters, setClientsFilters] = useState({ city: 'all', type: 'all', spentRange: 'all' });

  const [activeAlarms, setActiveAlarms] = useState<ClientReminder[]>([]);
  
  const prevChatUnreadTotal = useRef(0);
  // La carga inicial ya trae todo (fetchData('all')); sin esta guarda, los
  // 3 efectos de filtros disparan además 3 fetchData al montar.
  const firstFetchDone = useRef(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState({ title: '', description: '', type: 'info' as 'info' | 'success' | 'error' });
  // A dónde lleva tocar el toast (por defecto, el inbox).
  const [toastTarget, setToastTarget] = useState<ViewState>('inbox');
  
  const [isServiceFormOpen, setIsServiceFormOpen] = useState(false);
  const [editingService, setEditingService] = useState<ServiceRecord | null>(null);
  const [prefillData, setPrefillData] = useState<any>(null);

  const triggerToast = (title: string, description: string, type: 'info' | 'success' | 'error' = 'info', target: ViewState = 'inbox') => {
    setToastMessage({ title, description, type });
    setToastTarget(target);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 5000);
  };

  useEffect(() => {
    if (currentUser) {
      localStorage.setItem('purifica_session', JSON.stringify(currentUser));
      
      const socket = io(window.location.origin, { auth: { token: getToken() } });
      socket.on('connect', () => {
        socket.emit('identify', { id: currentUser.id, role: currentUser.role });
      });

      socket.on('data_update', (data: any) => {
        // Refrescar solo lo necesario basado en data.type si es posible
        if (data.type === 'chat' || data.type === 'webhook_message') fetchData('all');
        else if (data.type === 'lead') fetchData('leads');
        else if (data.type === 'service' || data.type === 'service_status') fetchData('services');
        else fetchData('all');
      });

      return () => {
        socket.disconnect();
      };
    } else {
      localStorage.removeItem('purifica_session');
    }
  }, [currentUser]);

  const fetchData = async (target?: 'leads' | 'services' | 'clients' | 'all') => {
    if (!currentUser) return;

    try {
      // v5.2 El alcance sale del JWT del servidor: ya no se mandan
      // role/userName/userId por query (el servidor los ignora).
      const leadsUrl = `/api/leads?page=${leadsPage}&search=${encodeURIComponent(leadsSearch)}&status=${leadsFilters.status}&startDate=${leadsFilters.startDate}&endDate=${leadsFilters.endDate}&location=${encodeURIComponent(leadsFilters.location)}&source=${leadsFilters.source}&minPrice=${leadsFilters.minPrice}&maxPrice=${leadsFilters.maxPrice}&advisor=${encodeURIComponent(leadsFilters.advisor)}`;
      const servicesUrl = `/api/services?page=${servicesPage}&search=${encodeURIComponent(servicesSearch)}&startDate=${servicesFilters.startDate}&endDate=${servicesFilters.endDate}&location=${encodeURIComponent(servicesFilters.location)}&staff=${encodeURIComponent(servicesFilters.staff)}&payment=${servicesFilters.payment || 'all'}&dealStatus=${servicesFilters.dealStatus || 'all'}`;
      const clientsUrl = `/api/clients?page=${clientsPage}&search=${encodeURIComponent(clientsSearch)}&city=${encodeURIComponent(clientsFilters.city)}&type=${clientsFilters.type}&spentRange=${clientsFilters.spentRange}`;

      const requests: any = {};

      if (!target || target === 'all' || target === 'leads') requests.leads = apiFetch(leadsUrl);
      if (!target || target === 'all' || target === 'services') requests.services = apiFetch(servicesUrl);
      if (!target || target === 'all' || target === 'clients') requests.clients = apiFetch(clientsUrl);

      if (!target || target === 'all') {
        requests.staff = apiFetch('/api/staff');
        requests.chats = apiFetch('/api/chats');
        requests.alarms = apiFetch('/api/active-reminders');
      }

      const keys = Object.keys(requests);
      // Un fetch fallido no descarta todo el lote: cada petición tiene
      // su propio catch (un 500 antes dejaba data.data en undefined y
      // leads.filter / staff.filter / data.reduce rompían el render).
      const responses = await Promise.all(keys.map(k => requests[k].then((res: any) => ({ key: k, res })).catch(() => ({ key: k, res: null }))));

      for (const { key, res } of responses) {
        if (!res || !res.ok) continue;

        let data: any = null;
        try { data = await res.json(); } catch { continue; }

        if (key === 'leads') {
          if (Array.isArray(data?.data)) { setLeads(data.data); setTotalLeads(data.total || 0); }
        } else if (key === 'services') {
          if (Array.isArray(data?.data)) { setServices(data.data); setTotalServices(data.total || 0); }
        } else if (key === 'clients') {
          if (Array.isArray(data?.data)) { setClients(data.data); setTotalClients(data.total || 0); }
        } else if (key === 'staff') {
          if (Array.isArray(data)) setStaff(data);
        } else if (key === 'chats') {
          if (!Array.isArray(data)) continue;
          setChats(data);
          const currentChatUnread = data.reduce((acc: number, curr: any) => acc + (curr.unreadCount || 0), 0);
          if (currentChatUnread > prevChatUnreadTotal.current && currentView !== 'inbox' && currentUser.role !== 'operator') {
            notificationService.playReceived();
            triggerToast('Mensaje Nuevo', 'Has recibido un nuevo mensaje en el inbox.', 'info');
          }
          prevChatUnreadTotal.current = currentChatUnread;
        } else if (key === 'alarms') {
          if (!Array.isArray(data)) continue;
          if (data.length > 0 && data.length > activeAlarms.length) {
            notificationService.playAlert();
            triggerToast('Recordatorio', `Tienes ${data.length} recordatorios pendientes.`, 'info');
          }
          setActiveAlarms(data);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (isLoading) setIsLoading(false);
    }
  };

  useEffect(() => {
    if (currentUser) {
      fetchData('all').finally(() => { firstFetchDone.current = true; });
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser && firstFetchDone.current) fetchData('leads');
  }, [leadsPage, leadsSearch, leadsFilters]);

  useEffect(() => {
    if (currentUser && firstFetchDone.current) fetchData('services');
  }, [servicesPage, servicesSearch, servicesFilters]);

  useEffect(() => {
    if (currentUser && firstFetchDone.current) fetchData('clients');
  }, [clientsPage, clientsSearch, clientsFilters]);

  const handleUpdateLeadStatus = async (id: string, status: LeadStatus, isConvId: boolean, reason?: string) => {
    try {
      const res = await apiFetch('/api/leads/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: isConvId ? id : undefined, leadId: !isConvId ? id : undefined, status, lostReason: reason })
      });
      if (res.ok) fetchData();
    } catch (e) { console.error(e); }
  };

  const handleUpdateDealStatus = async (serviceId: string, status: DealStatus, reason?: string, newDate?: string, newTime?: string) => {
    try {
      const body: any = { id: serviceId, status, reason };
      if (status === DealStatus.RESCHEDULED && newDate) {
        body.date = newDate;
        body.time = newTime;
      }

      const res = await apiFetch(`/api/services/update-deal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) fetchData();
    } catch (e) { console.error(e); }
  };

  const handleSaveService = async (data: ServiceRecord) => {
    try {
      const res = await apiFetch('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        fetchData();
        setIsServiceFormOpen(false);
        setEditingService(null);
        setPrefillData(null);
        return data.id;
      }
      // Antes el error del servidor se ignoraba en silencio y el
      // formulario quedaba abierto sin explicar nada.
      const errData = await res.json().catch(() => null);
      triggerToast('No se pudo guardar el servicio', errData?.error || `El servidor respondió ${res.status}.`, 'error');
    } catch (e) {
      console.error(e);
      triggerToast('No se pudo guardar el servicio', 'Sin conexión con el servidor.', 'error');
    }
    return null;
  };

  const handleDeleteClient = async (phone: string) => {
    if (currentUser?.role !== 'admin') {
      alert('Solo los administradores pueden realizar esta acción.');
      return;
    }
    if (!confirm('¿Seguro que deseas eliminar permanentemente a este cliente? Se borrarán todos sus chats, prospectos e historial de servicios. Esta acción no se puede deshacer.')) return;
    try {
      const res = await apiFetch(`/api/clients/${encodeURIComponent(phone)}`, { method: 'DELETE' });
      if (res.ok) fetchData();
    } catch (e) { console.error(e); }
  };

  const handleSaveStaff = async (member: any) => {
    try {
      const isEdit = !!member.id;
      const res = await apiFetch(isEdit ? `/api/staff/${member.id}` : '/api/staff', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(member)
      });
      if (res.ok) fetchData();
      else {
        // v5 Parte 2C: un director que intenta tocar a alguien que no es
        // su subordinado recibe 403; antes se ignoraba en silencio.
        const data = await res.json().catch(() => null);
        alert(data?.error || 'No se pudo guardar el empleado (sin permiso o error del servidor).');
      }
    } catch (e) { console.error(e); }
  };

  const handleRemoveStaff = async (id: string) => {
    if (!confirm('¿Seguro que deseas eliminar a este miembro del equipo?')) return;
    try {
      const res = await apiFetch(`/api/staff/${id}`, { method: 'DELETE' });
      if (res.ok) fetchData();
      else {
        const data = await res.json().catch(() => null);
        alert(data?.error || 'No se pudo eliminar el empleado (sin permiso o error del servidor).');
      }
    } catch (e) { console.error(e); }
  };

  const handleOpenFullService = (phone: string, leadData: any) => {
    const chat = chats.find(c => c.clientPhone === phone);
    const leadImages = leadData.technicalImages || chat?.leadData?.technicalImages || [];
    const existing = services.find(s => s.clientPhone === phone);
    
    const currentItems = leadData.items || leadData.itemsToClean || leadData.items_to_clean || chat?.leadData?.itemsToClean || '';
    const currentAddress = leadData.address || chat?.leadData?.address || '';
    const currentLocation = leadData.location || chat?.leadData?.location || '';
    // location viene como "Barrio, Ciudad": el barrio es solo la primera
    // parte (igual que en ChatInbox). Antes se guardaba la ubicación
    // completa en neighborhood y crecía en cada guardado.
    const currentNeighborhood = currentLocation.split(',')[0].trim();
    const currentName = leadData.name || leadData.clientName || chat?.clientName || '';
    const currentValue = leadData.value || leadData.estimatedValue || chat?.leadData?.estimatedValue || 0;

    if (existing) {
      setEditingService({ 
        ...existing, 
        itemsToClean: currentItems || existing.itemsToClean,
        address: currentAddress || existing.address,
        neighborhood: currentNeighborhood || existing.neighborhood,
        clientName: currentName || existing.clientName,
        initialValue: currentValue > 0 ? currentValue : existing.initialValue,
        technicalImages: [...new Set([...(existing.technicalImages || []), ...leadImages])] 
      });
    } else {
      setPrefillData({
        name: currentName,
        phone: phone,
        advisor: leadData.advisor || currentUser?.name || '',
        value: currentValue,
        items: currentItems,
        address: currentAddress,
        location: currentNeighborhood,
        technicalImages: leadImages
      });
    }
    setIsServiceFormOpen(true);
  };

  const handleLocalMessage = async (conversationId: string, message: ChatMessage) => {
    try {
      notificationService.playSent();
      const res = await apiFetch(`/api/chats/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: message.content,
          type: message.type,
          attachmentUrl: message.attachmentUrl
        })
      });
      if (res.ok) {
        // v5.3 Contrato con backend: si WhatsApp no lo envió, el
        // servidor devuelve sent:false con el error. El mensaje queda
        // guardado, pero se avisa en vez de mostrarlo como enviado.
        const data = await res.json().catch(() => null);
        if (data && data.sent === false) {
          triggerToast('WhatsApp no envió el mensaje', `Guardado, pero WhatsApp no lo envió: ${data.error || 'error desconocido'}.`, 'error');
        }
        fetchData();
      } else {
        const data = await res.json().catch(() => null);
        triggerToast('No se pudo enviar el mensaje', data?.error || `El servidor respondió ${res.status}.`, 'error');
      }
    } catch (e) {
      console.error(e);
      triggerToast('No se pudo enviar el mensaje', 'Sin conexión con el servidor.', 'error');
    }
  };

  const handleCompleteAlarm = async (id: string, phone: string) => {
    try {
      await apiFetch(`/api/reminders/${id}/complete`, { method: 'POST' });
      fetchData();
      handleGoToChat(phone);
    } catch (e) { console.error(e); }
  };

  const handleGoToChat = (phone: string) => {
    setPreselectedChatPhone(phone);
    setCurrentView('inbox');
  };

  const handleLogout = () => {
    setCurrentUser(null);
    clearAuth();
  };

  useEffect(() => { loadBranding().catch(() => {}); }, []);

  if (!currentUser) return <LoginScreen onLogin={setCurrentUser} />;

  const renderView = () => {
    if (isLoading) {
      if (currentView === 'dashboard') return <DashboardSkeleton />;
      return <ListSkeleton />;
    }

    switch (currentView) {
      case 'dashboard':
        return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'clients':
        return (
          <ClientsList 
            clients={clients} 
            totalClients={totalClients}
            currentPage={clientsPage}
            onPageChange={setClientsPage}
            onSearchChange={setClientsSearch}
            onFiltersChange={(f: any) => setClientsFilters((prev: any) => ({ ...prev, ...f }))}
            onDeleteClient={handleDeleteClient} 
            userRole={currentUser.role} 
            userName={currentUser.name} 
            onChat={handleGoToChat} 
          />
        );
      case 'leads':
        return (
          <LeadPipeline 
            leads={leads} 
            totalLeads={totalLeads}
            currentPage={leadsPage}
            onPageChange={setLeadsPage}
            onSearchChange={setLeadsSearch}
            onFiltersChange={(f: any) => setLeadsFilters((prev: any) => ({ ...prev, ...f }))}
            staff={staff} 
            onUpdateStatus={handleUpdateLeadStatus} 
            onEditLead={(l) => handleOpenFullService(l.clientPhone, l)} 
            onChat={handleGoToChat} 
            currentUser={currentUser} 
          />
        );
      case 'deals':
        // Solo admin: el menú lo oculta a otros roles, pero la vista era
        // alcanzable por estado (p. ej. desde el Dashboard). Igual que
        // branding/system-status/invoices, un no-admin ve el Dashboard.
        if (currentUser.role !== 'admin') return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
        return (
          <BusinessDeals 
            services={services} 
            totalServices={totalServices}
            currentPage={servicesPage}
            onPageChange={setServicesPage}
            onSearchChange={setServicesSearch}
            onFiltersChange={(f: any) => setServicesFilters((prev: any) => ({ ...prev, ...f }))}
            staff={staff} 
            onUpdateStatus={handleUpdateDealStatus} 
            onEditService={(s) => { setEditingService(s); setIsServiceFormOpen(true); }} 
            onChat={handleGoToChat} 
            currentUser={currentUser} 
          />
        );
      case 'audit':
        if (currentUser.role !== 'admin') return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
        return <AuditModule leads={leads} services={services} onRefresh={fetchData} />;
      case 'inbox':
        return (
          <ChatInbox 
            conversations={chats} 
            staff={staff} 
            currentUser={currentUser} 
            readOnly={currentUser.role === 'operator'}
            onLocalMessage={handleLocalMessage} 
            onOpenService={handleOpenFullService} 
            onUpdateStatus={handleUpdateLeadStatus} 
            preselectedPhone={preselectedChatPhone}
            onClearPreselection={() => setPreselectedChatPhone(null)}
          />
        );
      case 'wa-channels':
        if (currentUser.role !== 'admin') return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
        return <WhatsAppChannels currentUser={currentUser} />;
      case 'branding':
        return currentUser.role === 'admin' ? <BrandingSettings /> : <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'system-status':
        return currentUser.role === 'admin' ? <SystemStatus /> : <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'invoices':
        // v5.2 B6: el vendedor (advisor) factura y cobra; anular, export
        // DIAN y la configuración siguen siendo solo admin (dentro de la
        // vista y en el servidor).
        return (currentUser.role === 'admin' || currentUser.role === 'advisor') ? <Invoices currentUser={currentUser} /> : <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'services':
        return (
          <ServiceList 
            services={services} 
            totalServices={totalServices}
            currentPage={servicesPage}
            onPageChange={setServicesPage}
            onSearchChange={setServicesSearch}
            onFiltersChange={(f: any) => setServicesFilters((prev: any) => ({ ...prev, ...f }))}
            staff={staff} 
            onAdd={() => setIsServiceFormOpen(true)} 
            onEdit={(s) => { setEditingService(s); setIsServiceFormOpen(true); }} 
            onDelete={async (id) => { if(confirm('¿Eliminar servicio?')) { await apiFetch(`/api/services/${id}`, { method: 'DELETE' }); fetchData(); } }} 
            onChat={handleGoToChat} 
            currentUser={currentUser} 
          />
        );
      case 'team':
        // Equipo: admin y líder de ventas (misma regla que el menú).
        if (currentUser.role !== 'admin' && currentUser.role !== 'sales_agent') return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
        return <TeamManagement staff={staff} onAddStaff={handleSaveStaff} onRemoveStaff={handleRemoveStaff} currentUser={currentUser} />;
      default:
        return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
    }
  };

  const isOperator = currentUser.role === 'operator';

  return (
    <>
      <Layout 
        currentView={currentView} 
        onNavigate={setCurrentView} 
        currentUser={currentUser} 
        onLogout={handleLogout}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={currentView + (isLoading ? '-loading' : '')}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="h-full"
          >
            {renderView()}
          </motion.div>
        </AnimatePresence>

        {isServiceFormOpen && (
          <ServiceForm 
            initialData={editingService} 
            staff={staff} 
            onSave={handleSaveService} 
            onCancel={() => { setIsServiceFormOpen(false); setEditingService(null); setPrefillData(null); }} 
            onChat={handleGoToChat}
            prefillClient={prefillData}
            userRole={currentUser.role}
          />
        )}
      </Layout>

      {!isOperator && <CapacityWidget />}

      <div className="fixed top-20 right-6 z-[250] space-y-3 pointer-events-none">
         {activeAlarms.map(alarm => (
            <div 
              key={alarm.id}
              className="pointer-events-auto bg-slate-900 text-white p-5 rounded-[2rem] shadow-2xl border-2 border-red-500 flex items-center gap-4 animate-in slide-in-from-right duration-500 w-80 relative overflow-hidden"
            >
               <div className="absolute top-0 right-0 w-24 h-24 bg-red-500/10 blur-2xl rounded-full" />
               <div className="bg-red-500 p-3 rounded-2xl animate-bounce shadow-lg shadow-red-500/20">
                  <BellRing className="w-6 h-6" />
               </div>
               <div className="flex-1">
                  <p className="text-[9px] font-black uppercase text-red-400 tracking-widest mb-1">Alarma Programada</p>
                  <p className="text-sm font-black leading-tight mb-1">{alarm.title}</p>
                  <p className="text-[10px] font-bold text-slate-400">{alarm.client_name}</p>
                  <button 
                    onClick={() => handleCompleteAlarm(alarm.id, alarm.client_phone)}
                    className="mt-3 flex items-center gap-2 text-[9px] font-black uppercase text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    Atender ahora <ChevronRight className="w-3 h-3" />
                  </button>
               </div>
               <button 
                 onClick={async () => { await apiFetch(`/api/reminders/${alarm.id}/complete`, { method: 'POST' }); fetchData(); }}
                 className="p-1 hover:bg-white/10 rounded-lg text-slate-500 self-start"
               >
                  <X className="w-4 h-4" />
               </button>
            </div>
         ))}
      </div>

      <AnimatePresence>
        {showToast && (
          <motion.div 
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.9 }}
            className="fixed top-6 right-6 z-[200]"
          >
             <div 
               onClick={() => { setShowToast(false); setCurrentView(toastTarget); }}
               className={`bg-slate-900 text-white p-5 rounded-2xl shadow-2xl border flex items-center gap-4 cursor-pointer hover:bg-slate-800 transition-all active:scale-95 ${
                 toastMessage.type === 'success' ? 'border-emerald-500/50' : 
                 toastMessage.type === 'error' ? 'border-red-500/50' : 'border-white/10'
               }`}
             >
                <div className={`p-2.5 rounded-xl shadow-lg ${
                  toastMessage.type === 'success' ? 'bg-emerald-600' : 
                  toastMessage.type === 'error' ? 'bg-red-600' : 'bg-brand-600'
                }`}>
                   {toastMessage.type === 'error' ? <AlertCircle className="w-6 h-6" /> : 
                    toastMessage.type === 'success' ? <CheckCircle2 className="w-6 h-6" /> : 
                    <MessageSquare className="w-6 h-6" />}
                </div>
                <div>
                   <p className={`text-[10px] font-black uppercase tracking-widest ${
                     toastMessage.type === 'success' ? 'text-emerald-400' : 
                     toastMessage.type === 'error' ? 'text-red-400' : 'text-brand-400'
                   }`}>{toastMessage.title}</p>
                   <p className="text-sm font-bold">{toastMessage.description}</p>
                   <p className="text-[10px] text-slate-400 mt-1 uppercase">Toca para abrir</p>
                </div>
                <button 
                  onClick={(e) => { e.stopPropagation(); setShowToast(false); }}
                  className="p-1 hover:bg-white/10 rounded-lg text-slate-500"
                >
                   <X className="w-4 h-4" />
                </button>
             </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
