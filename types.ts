
export enum DealStatus {
  SCHEDULED = 'AGENDADO',
  CONFIRMED = 'CONFIRMADO',
  DONE = 'REALIZADO',
  PAID = 'PAGADO',
  CANCELLED = 'CANCELADO',
  RESCHEDULED = 'REAGENDADO'
}

export enum PaymentMethod {
  CASH = 'Efectivo',
  TRANSFER = 'Transferencia',
  CARD = 'Tarjeta',
  PENDING = 'Pendiente'
}

export enum LeadStatus {
  NEW = 'NUEVO',
  QUOTED = 'COTIZADO',
  PENDING_DECISION = 'EN_DECISION',
  SCHEDULED = 'AGENDADO',
  NOT_INTERESTED = 'NO_INTERESADO',
  OUT_OF_COVERAGE = 'FUERA_COBERTURA',
  LOST = 'PERDIDO'
}

// v5.2 Roles unificados: UN solo tipo, en minúscula, igual en frontend,
// backend (JWT) y BD. Antes StaffRole venía con mayúscula ('Admin'...)
// mientras el login/JWT usaba minúscula: dos verdades que podían
// desincronizar el panel. Las claves de BD no cambian (siguen siendo
// 'admin' | 'advisor' | 'operator' | 'sales_agent'); lo que cambia es el
// NOMBRE VISIBLE: advisor = "Vendedor", sales_agent = "Líder de ventas".
export type StaffRole = 'admin' | 'advisor' | 'operator' | 'sales_agent';
export type UserRole = StaffRole;

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: 'Administrador',
  advisor: 'Vendedor',
  operator: 'Operador',
  sales_agent: 'Líder de ventas',
};

// Nombre visible de un rol (tolerante a mayúsculas viejas de la BD).
export function roleLabel(role: string | undefined | null): string {
  const r = (role || '').toLowerCase();
  return (ROLE_LABELS as Record<string, string>)[r] || role || '';
}

export interface CommissionTier {
  id: string;
  role: 'advisor' | 'sales_agent';
  min_value: number;
  max_value: number;
  percentage: number;
}

export interface CurrentUser {
  id: string;
  name: string;
  role: UserRole;
  email: string;
  commissionPct?: number;
  isOnline?: boolean;
}

export interface StaffMember {
  id: string;
  name: string;
  phone: string;
  email?: string;
  role: StaffRole;
  active: boolean;
  commissionPct?: number;
  parentId?: string;
  parentName?: string;
  isOnline?: boolean;
  lastAssignedAt?: string;
}

export interface ClientNote {
  id: string;
  client_phone: string;
  content: string;
  updated_at: string;
}

export interface ClientReminder {
  id: string;
  client_phone: string;
  client_name: string;
  title: string;
  alert_at: string;
  is_processed: boolean;
  created_by: string;
}

export interface ClientSummary {
  clientPhone: string;
  clientName: string;
  city: string;
  neighborhood: string;
  address: string;
  totalServices: number;
  totalSpent: number;
  lastServiceDate: string;
  source: string;
}

export type ViewState = 'dashboard' | 'leads' | 'services' | 'team' | 'inbox' | 'deals' | 'clients' | 'audit' | 'wa-channels' | 'branding' | 'system-status' | 'invoices';

// v5 Parte 2A Facturación: factura interna (NO es factura electrónica DIAN).
// v5.1 Tipo de factura: 'normal' (factura de venta sin DIAN, por defecto) o
// 'electronica' (DIAN-ready, lista para el proveedor certificado; el CRM no
// envía nada a la DIAN). El consecutivo FAC-XXXX es compartido por ambos tipos.
export type InvoiceType = 'normal' | 'electronica';
export type InvoiceStatus = 'pendiente' | 'parcial' | 'pagado' | 'anulado';

export interface InvoicePayment {
  id: number;
  invoiceId: number;
  amount: number;
  method: string;
  reference: string;
  createdAt: string;
}

export interface Invoice {
  id: number;
  number: string;
  type: InvoiceType;
  serviceId: string | null;
  clientName: string;
  clientPhone: string;
  clientNit: string;
  subtotal: number;
  advances: number;
  total: number;
  balance: number;
  status: InvoiceStatus;
  paymentMethod: string;
  paymentLink: string;
  createdAt: string;
  serviceDate: string | null;
  servicePerformed: string;
  payments?: InvoicePayment[];
  already_exists?: boolean;
}

// v5 Parte 2C Totales reales del servidor (GET /api/stats/overview y
// GET /api/stats/commissions). Las comisiones salen de la tabla
// commission_tiers: si no hay tramo aplicable, percentage y commission
// son null con note 'sin tramo' (nunca un porcentaje inventado).
export interface StatsOverviewRevenue {
  grossIncome: number;
  scheduledValue: number;
  confirmedValue: number;
  rescheduledValue: number;
  doneValue: number;
  paidValue: number;
  totalExpenses: number;
  totalOperatorPayments: number;
  totalServices: number;
}

export interface ServiceStatusTotal { status: string; count: number; totalValue: number; }
export interface LeadStageTotal { status: string; count: number; estimatedValue: number; }
export interface LossReasonTotal { reason: string; count: number; }
export interface DuplicateTotal { phone: string; name: string; date: string; count: number; }
export interface InvoiceStatusTotal { status: string; count: number; total: number; balance: number; }

export interface StatsOverview {
  timeRange: string;
  // v5.2 Alcance de los totales (del JWT): 'admin' = toda la empresa;
  // otros roles = solo sus números. El frontend avisa cuando no son
  // los totales de la empresa.
  scope?: { role: string; userName: string | null };
  revenue: StatsOverviewRevenue;
  servicesByStatus: ServiceStatusTotal[];
  leadsByStage: LeadStageTotal[];
  leadLossReasons: LossReasonTotal[];
  serviceCancellationReasons: LossReasonTotal[];
  lossReasons: LossReasonTotal[];
  clientsCount: number;
  duplicates: DuplicateTotal[];
  invoicesByStatus: InvoiceStatusTotal[];
}

export interface EmployeeCommission {
  employeeId: string;
  name: string;
  role: string;
  revenue: number;
  paidRevenue: number;
  totalServices: number;
  percentage: number | null;
  commission: number | null;
  note: string | null;
}

export interface StatsCommissions {
  period: string;
  basis: string;
  scope?: { role: string; userName: string | null };
  commissions: EmployeeCommission[];
  totalCommissions: number;
  totalPaidRevenue: number;
}

export interface SystemComponentStatus {
  key: string;
  label: string;
  status: 'green' | 'yellow' | 'red';
  detail: string;
  // v5.3 Google Calendar: el check 'google-calendar' trae si está
  // configurado y el último error (si lo hubo).
  configured?: boolean;
  lastError?: { at: string; message: string } | null;
  latencyMs?: number;
  instances?: { id: string; name: string; status: string; phone: string | null; lastSeen: string | null; lastMessageAt: string | null }[];
  memoryMB?: number;
  disk?: { freeMB: number; totalMB: number } | null;
  recentMessages1h?: number | null;
  unreadConversations?: number | null;
  backup?: { at: string | null; ok: boolean | null; file: string | null; sizeBytes: number | null; error: string | null };
}

export interface SystemEvent {
  id?: number;
  level: 'info' | 'warn' | 'error' | 'critical';
  component: string;
  message: string;
  details?: Record<string, unknown>;
  created_at: string;
}

export interface SelfTestResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface WhatsAppInstance {
  id: string;
  name: string;
  status: 'initializing' | 'qr_ready' | 'ready' | 'authenticated' | 'auth_failure' | 'disconnected' | 'error';
  hasQr: boolean;
  qr?: string;
  // v5 Parte 2B: canal de envío. 'qr' = WhatsApp Web (whatsapp-web.js),
  // 'meta' = Meta Cloud API oficial. Por defecto 'qr'.
  channel?: 'qr' | 'meta';
}

export interface ChatMessage {
  id: string;
  sender: 'client' | 'agent' | 'bot';
  content: string;
  timestamp: string;
  // El servidor no devuelve fullDate en /api/chats (solo timestamp);
  // el inbox lo genera al enviar. Opcional para no mentir en el tipo.
  fullDate?: string;
  type?: 'text' | 'media' | 'image' | 'audio' | 'video' | 'file' | 'document' | 'sticker';
  attachmentUrl?: string;
}

export interface ChatConversation {
  id: string;
  clientName: string;
  clientPhone: string;
  source: 'whatsapp' | 'instagram' | 'messenger' | 'web';
  unreadCount: number;
  messages: ChatMessage[];
  inboxName?: string;
  lastMessageTimeFormatted?: string;
  leadStatus?: LeadStatus;
  // El servidor devuelve el nº de tareas pendientes del cliente.
  pendingTasksCount?: number;
  leadData?: {
    itemsToClean?: string;
    location?: string;
    address?: string;
    estimatedValue?: number;
    advisor?: string;
    technicalImages: string[];
  };
}

export interface ChatTemplate {
  id: string;
  title: string;
  content: string;
}

export interface ServiceRecord {
  id: string;
  date: string;
  time: string;
  clientName: string;
  clientPhone: string;
  city: string;
  neighborhood: string;
  address: string;
  advisor: string;
  operators: string[];
  itemsToClean: string;
  servicePerformed: string;
  observations: string;
  initialValue: number;
  additionalItems: string;
  additionalValue: number;
  totalValue: number;
  paymentMethod: PaymentMethod;
  expenses: number;
  expensesNote: string;
  operatorPayment: number;
  advances: number;
  netProfit: number;
  isWarranty: boolean;
  dealStatus?: DealStatus;
  technicalImages: string[];
  afterImages: string[];
  clientSignature: string;
  cancellationReason?: string;
  source?: string;
  rescheduleCount?: number;
  // v5.3 Google Calendar: id del evento en Calendar (null = sin sincronizar).
  googleCalendarEventId?: string | null;
}

export interface LeadRecord {
  id: string;
  conversationId?: string;
  clientName: string;
  clientPhone: string;
  status: LeadStatus;
  itemsToClean: string;
  location: string;
  address: string;
  estimatedValue: number;
  advisor: string;
  assignedAt?: string;
  lostReason?: string;
  technicalImages: string[];
  createdAt: string;
  source?: string;
}
