import React, { useEffect, useState } from 'react';
import { Receipt, Search, Eye, Link2, Copy, Check, X, Download, CreditCard, Ban, Settings2, Save } from 'lucide-react';
import { Invoice, InvoiceStatus, InvoiceType, CurrentUser } from '../types';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { InvoiceModal } from './InvoiceModal';

// Vista Facturación (admin + vendedor): lista de facturas internas, pago
// manual, links de pago Wompi/PayU, anulación, export DIAN-ready y datos
// de la empresa para la facturación. NO emite facturas electrónicas DIAN.
// v5.2 B6: el vendedor (advisor) crea facturas, registra pagos y genera
// links; NO puede anular ni exportar DIAN ni cambiar el tipo por defecto
// ni los datos de la empresa (eso es solo admin, en la vista y en el
// servidor).
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'parcial', label: 'Parciales' },
  { value: 'pagado', label: 'Pagadas' },
  { value: 'anulado', label: 'Anuladas' },
];

const STATUS_BADGE: Record<string, string> = {
  pendiente: 'bg-amber-100 text-amber-700',
  parcial: 'bg-sky-100 text-sky-700',
  pagado: 'bg-emerald-100 text-emerald-700',
  anulado: 'bg-red-100 text-red-700',
};

// v5.1 Tipos de factura. 'normal' = factura de venta sin DIAN (la que usan
// las empresas que no se conectan a la DIAN). 'electronica' = DIAN-ready.
const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Todos los tipos' },
  { value: 'normal', label: 'Normales' },
  { value: 'electronica', label: 'Electrónicas' },
];

const TYPE_LABEL: Record<InvoiceType, string> = {
  normal: 'Normal',
  electronica: 'Electrónica',
};

const TYPE_BADGE: Record<InvoiceType, string> = {
  normal: 'bg-slate-100 text-slate-600',
  electronica: 'bg-violet-100 text-violet-700',
};

const DIAN_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: 'company_nit', label: 'NIT de la empresa', placeholder: '900.123.456-7' },
  { key: 'company_regime', label: 'Régimen', placeholder: 'Responsable de IVA / No responsable' },
  { key: 'dian_resolution_number', label: 'N.º resolución de facturación', placeholder: '18764000000000' },
  { key: 'dian_resolution_range', label: 'Rango autorizado', placeholder: 'FAC-0001 a FAC-5000' },
  { key: 'dian_resolution_date', label: 'Fecha de la resolución', placeholder: '2026-01-15' },
];

export const Invoices: React.FC<{ currentUser?: CurrentUser }> = ({ currentUser }) => {
  // v5.2 B6: sin currentUser se asume admin (compatibilidad); App.tsx
  // siempre lo pasa.
  const isAdmin = !currentUser || currentUser.role === 'admin';
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  // v5.1 Tipo de factura por defecto para las facturas nuevas.
  const [defaultType, setDefaultType] = useState<InvoiceType>('normal');
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [payFor, setPayFor] = useState<Invoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('Efectivo');
  const [payReference, setPayReference] = useState('');
  const [linkFor, setLinkFor] = useState<Invoice | null>(null);
  const [linkProvider, setLinkProvider] = useState<'wompi' | 'payu'>('wompi');
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dian, setDian] = useState<Record<string, string>>({});
  const [dianSaved, setDianSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (typeFilter !== 'all') params.set('type', typeFilter);
      const qs = params.toString();
      const res = await apiFetch(`/api/invoices${qs ? `?${qs}` : ''}`);
      if (res.ok) setInvoices(await res.json());
      else setError('No se pudieron cargar las facturas.');
    } catch { setError('Sin conexión con el servidor.'); }
    setLoading(false);
  };

  const loadDian = async () => {
    try {
      const res = await apiFetch('/api/settings');
      if (res.ok) {
        const s = await res.json();
        const next: Record<string, string> = {};
        for (const f of DIAN_FIELDS) next[f.key] = s[f.key] || '';
        setDian(next);
        // v5.1 Tipo por defecto guardado (las facturas viejas no tienen
        // tipo en settings: quedan como 'normal').
        if (s.invoice_default_type === 'electronica' || s.invoice_default_type === 'normal') {
          setDefaultType(s.invoice_default_type);
        }
      }
    } catch { /* noop */ }
  };

  useEffect(() => { load(); }, [filter, typeFilter]);
  useEffect(() => { loadDian(); }, []);

  const filtered = invoices.filter((inv) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return inv.number.toLowerCase().includes(q)
      || inv.clientName.toLowerCase().includes(q)
      || (inv.clientPhone || '').includes(q);
  });

  const openPay = (inv: Invoice) => {
    setPayFor(inv);
    setPayAmount(String(inv.balance));
    setPayMethod('Efectivo');
    setPayReference('');
  };

  const submitPayment = async () => {
    if (!payFor) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setError('El monto debe ser mayor que 0.'); return; }
    // El servidor recortaba el exceso en silencio (Math.min): se avisa
    // antes de enviar. payFor.balance es el saldo pendiente.
    if (amount > payFor.balance) { setError(`El monto (${formatCurrency(amount)}) supera el saldo pendiente (${formatCurrency(payFor.balance)}).`); return; }
    const res = await apiFetch(`/api/invoices/${payFor.id}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, method: payMethod, reference: payReference }),
    });
    if (res.ok) {
      setPayFor(null);
      setError(null);
      load();
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || 'No se pudo registrar el pago.');
    }
  };

  const generateLink = async () => {
    if (!linkFor) return;
    const res = await apiFetch(`/api/invoices/${linkFor.id}/payment-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: linkProvider }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      setError(null);
      load();
      setLinkFor({ ...linkFor, paymentLink: d.payment_url });
    } else {
      setError(d.error || 'No se pudo generar el link de pago.');
    }
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(link);
      setTimeout(() => setCopied(null), 2000);
    } catch { setError('No se pudo copiar el link.'); }
  };

  const cancelInvoice = async (inv: Invoice) => {
    if (!confirm(`¿Anular la factura ${inv.number}? Esta acción no se puede deshacer.`)) return;
    const res = await apiFetch(`/api/invoices/${inv.id}/cancel`, { method: 'POST' });
    if (res.ok) load();
    else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || 'No se pudo anular la factura.');
    }
  };

  const exportInvoice = async (inv: Invoice) => {
    // v5.1 Las facturas normales no tienen exportación DIAN: el servidor
    // responde 400 con la razón; se muestra tal cual.
    const res = await apiFetch(`/api/invoices/${inv.id}/export`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || 'No se pudo exportar la factura.');
      return;
    }
    const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${inv.number}-dian-ready.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // v5.1 Guarda el tipo de factura por defecto (Normal por defecto).
  const saveDefaultType = async () => {
    setDefaultSaved(false);
    const res = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'invoice_default_type', value: defaultType }),
    });
    if (res.ok) {
      setError(null);
      setDefaultSaved(true);
      setTimeout(() => setDefaultSaved(false), 3000);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || 'No se pudo guardar el tipo por defecto.');
    }
  };

  const saveDian = async () => {
    setDianSaved(false);
    for (const f of DIAN_FIELDS) {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: f.key, value: dian[f.key] || '' }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'No se pudieron guardar los datos DIAN.');
        return;
      }
    }
    setError(null);
    setDianSaved(true);
    setTimeout(() => setDianSaved(false), 3000);
  };

  const totals = {
    pendiente: invoices.filter((i) => i.status === 'pendiente' || i.status === 'parcial').reduce((a, i) => a + i.balance, 0),
    pagado: invoices.filter((i) => i.status === 'pagado').reduce((a, i) => a + i.total, 0),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-slate-800 tracking-tight flex items-center gap-2">
            <Receipt className="w-7 h-7 text-brand-600" /> Facturación
          </h1>
          <p className="text-xs font-bold text-slate-400 mt-1">
            Facturas internas de cobro · Saldo por cobrar: {formatCurrency(totals.pendiente)} · Cobrado (pagadas): {formatCurrency(totals.pagado)}
          </p>
          <p className="text-[11px] font-bold text-amber-600 mt-1">
            Las facturas <b>normales</b> son facturas de venta sin DIAN. Las <b>electrónicas</b> son DIAN-ready
            (listas para el proveedor certificado), pero este CRM no envía nada a la DIAN.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${filter === f.value ? 'bg-brand-600 text-white shadow-lg' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setTypeFilter(f.value)}
                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${typeFilter === f.value ? 'bg-violet-600 text-white shadow-lg' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por número de factura, cliente o teléfono..."
          className="w-full bg-white border border-slate-200 rounded-2xl pl-11 pr-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-brand-500"
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl text-sm font-bold flex items-center justify-between gap-2">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="bg-white rounded-[2rem] border border-slate-200 overflow-hidden shadow-sm">
        {loading ? (
          <p className="p-8 text-sm font-bold text-slate-400 text-center">Cargando facturas...</p>
        ) : filtered.length === 0 ? (
          <p className="p-8 text-sm font-bold text-slate-400 text-center">
            No hay facturas{filter !== 'all' ? ' en este estado' : ' todavía'}. Genera una desde un servicio realizado (botón de factura en Servicios).
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 bg-slate-50">
                <th className="px-5 py-3">Factura</th>
                <th className="px-5 py-3">Cliente</th>
                <th className="px-5 py-3">Tipo</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3 text-right">Saldo</th>
                <th className="px-5 py-3">Estado</th>
                <th className="px-5 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => (
                <tr key={inv.id} className="border-b border-slate-50 hover:bg-slate-50 font-bold text-slate-700">
                  <td className="px-5 py-3">
                    <p className="font-black text-slate-800">{inv.number}</p>
                    <p className="text-[11px] text-slate-400">{inv.createdAt ? new Date(inv.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }) : ''}</p>
                  </td>
                  <td className="px-5 py-3">
                    <p>{inv.clientName}</p>
                    <p className="text-[11px] text-slate-400">{inv.clientPhone}</p>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${TYPE_BADGE[inv.type] || TYPE_BADGE.normal}`}>{TYPE_LABEL[inv.type] || 'Normal'}</span>
                  </td>
                  <td className="px-5 py-3 text-right">{formatCurrency(inv.total)}</td>
                  <td className="px-5 py-3 text-right">{formatCurrency(inv.balance)}</td>
                  <td className="px-5 py-3">
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${STATUS_BADGE[inv.status] || ''}`}>{inv.status}</span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setSelected(inv)} title="Ver / imprimir factura" className="p-2 hover:bg-brand-50 text-slate-400 hover:text-brand-600 rounded-xl transition-all"><Eye className="w-4 h-4" /></button>
                      {inv.status !== 'pagado' && inv.status !== 'anulado' && (
                        <>
                          <button onClick={() => openPay(inv)} title="Registrar pago manual" className="p-2 hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 rounded-xl transition-all"><CreditCard className="w-4 h-4" /></button>
                          <button onClick={() => setLinkFor(inv)} title="Generar link de pago (Wompi / PayU)" className="p-2 hover:bg-sky-50 text-slate-400 hover:text-sky-600 rounded-xl transition-all"><Link2 className="w-4 h-4" /></button>
                        </>
                      )}
                      {inv.paymentLink && inv.status !== 'pagado' && (
                        <button onClick={() => copyLink(inv.paymentLink)} title="Copiar link de pago" className="p-2 hover:bg-sky-50 text-slate-400 hover:text-sky-600 rounded-xl transition-all">
                          {copied === inv.paymentLink ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                        </button>
                      )}
                      {isAdmin && (inv.type === 'electronica' ? (
                        <button onClick={() => exportInvoice(inv)} title="Exportar JSON DIAN-ready" className="p-2 hover:bg-slate-100 text-slate-400 hover:text-slate-700 rounded-xl transition-all"><Download className="w-4 h-4" /></button>
                      ) : (
                        <button disabled title="Las facturas normales no tienen exportación DIAN" className="p-2 text-slate-200 rounded-xl cursor-not-allowed"><Download className="w-4 h-4" /></button>
                      ))}
                      {isAdmin && inv.status !== 'anulado' && inv.status !== 'pagado' && (
                        <button onClick={() => cancelInvoice(inv)} title="Anular factura" className="p-2 hover:bg-red-50 text-slate-400 hover:text-red-500 rounded-xl transition-all"><Ban className="w-4 h-4" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* v5.1 Tipo de factura por defecto */}
      {isAdmin && (
      <div className="bg-white rounded-[2rem] border border-slate-200 p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <Settings2 className="w-5 h-5 text-brand-600" />
          <h2 className="font-black text-slate-800">Tipo de factura por defecto</h2>
        </div>
        <p className="text-xs font-bold text-slate-500">
          Es el tipo que se usa al generar una factura nueva cuando no se elige otro.
          <b> Normal (sin DIAN):</b> factura de venta corriente, para empresas que no se conectan a la DIAN.
          <b> Electrónica (DIAN):</b> factura lista para el proveedor certificado (Siigo, Alegra); el CRM no envía nada a la DIAN.
          El consecutivo FAC-XXXX es el mismo para los dos tipos.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 cursor-pointer">
            <input type="radio" name="default-invoice-type" checked={defaultType === 'normal'} onChange={() => setDefaultType('normal')} />
            <span className="text-sm font-black text-slate-700">Normal <span className="font-bold text-slate-400">(sin DIAN)</span></span>
          </label>
          <label className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 cursor-pointer">
            <input type="radio" name="default-invoice-type" checked={defaultType === 'electronica'} onChange={() => setDefaultType('electronica')} />
            <span className="text-sm font-black text-slate-700">Electrónica <span className="font-bold text-slate-400">(DIAN)</span></span>
          </label>
          <button onClick={saveDefaultType} className="bg-brand-600 text-white px-5 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-brand-700 shadow-lg flex items-center gap-2">
            <Save className="w-4 h-4" /> Guardar tipo por defecto
          </button>
          {defaultSaved && <p className="text-xs font-black text-emerald-600">Tipo por defecto guardado.</p>}
        </div>
      </div>
      )}

      {/* Datos DIAN-ready de la empresa (solo admin) */}
      {isAdmin && (
      <div className="bg-white rounded-[2rem] border border-slate-200 p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <Settings2 className="w-5 h-5 text-brand-600" />
          <h2 className="font-black text-slate-800">Datos de la empresa para facturación electrónica (DIAN-ready)</h2>
        </div>
        <p className="text-xs font-bold text-slate-500">
          Estos datos <b>solo aplican a las facturas electrónicas</b>: salen en la factura impresa electrónica y en el
          export JSON. Las facturas normales no los usan. Para facturar electrónicamente de verdad
          falta: un <b>proveedor certificado</b> (Siigo, Alegra u otro), sus <b>credenciales</b> y una{' '}
          <b>resolución DIAN vigente</b>. Este CRM no envía nada a la DIAN.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {DIAN_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{f.label}</span>
              <input
                value={dian[f.key] || ''}
                onChange={(e) => setDian((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-700 outline-none focus:border-brand-500"
              />
            </label>
          ))}
        </div>
        <button onClick={saveDian} className="bg-brand-600 text-white px-5 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-brand-700 shadow-lg flex items-center gap-2">
          <Save className="w-4 h-4" /> Guardar datos DIAN
        </button>
        {dianSaved && <p className="text-xs font-black text-emerald-600">Datos guardados.</p>}
      </div>
      )}

      {/* Registrar pago manual */}
      {payFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-black text-slate-800 text-lg">Registrar pago · {payFor.number}</h3>
            <p className="text-xs font-bold text-slate-500">Saldo pendiente: {formatCurrency(payFor.balance)}</p>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Monto (COP)</span>
              <input type="number" min={1} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-black text-slate-800 outline-none focus:border-brand-500" />
            </label>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Método</span>
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-700 outline-none">
                <option>Efectivo</option>
                <option>Transferencia</option>
                <option>Tarjeta</option>
                <option>Nequi</option>
                <option>Daviplata</option>
                <option>Wompi</option>
                <option>PayU</option>
                <option>Otro</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Referencia (opcional)</span>
              <input value={payReference} onChange={(e) => setPayReference(e.target.value)} placeholder="N.º comprobante, transacción..." className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-700 outline-none" />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPayFor(null)} className="px-4 py-3 rounded-2xl text-xs font-black uppercase text-slate-500 hover:bg-slate-100">Cancelar</button>
              <button onClick={submitPayment} className="px-5 py-3 rounded-2xl text-xs font-black uppercase bg-emerald-600 text-white hover:bg-emerald-700 shadow-lg">Registrar pago</button>
            </div>
          </div>
        </div>
      )}

      {/* Generar link de pago */}
      {linkFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-black text-slate-800 text-lg">Link de pago · {linkFor.number}</h3>
            <p className="text-xs font-bold text-slate-500">Saldo a cobrar: {formatCurrency(linkFor.balance)}</p>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Pasarela</span>
              <select value={linkProvider} onChange={(e) => setLinkProvider(e.target.value as 'wompi' | 'payu')} className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-700 outline-none">
                <option value="wompi">Wompi (checkout)</option>
                <option value="payu">PayU (WebCheckout Colombia)</option>
              </select>
            </label>
            <p className="text-[11px] font-bold text-slate-400">
              {linkProvider === 'wompi'
                ? 'Se genera el link de checkout de Wompi con el saldo en centavos y la referencia = número de factura.'
                : 'Se genera la URL de PayU con firma MD5. PayU oficialmente espera un formulario POST; el link generado es el equivalente GET con los mismos parámetros firmados.'}
            </p>
            {linkFor.paymentLink && (
              <div className="bg-sky-50 border border-sky-100 rounded-xl p-3 break-all text-xs font-bold text-sky-700 flex items-start gap-2">
                <span className="flex-1">{linkFor.paymentLink}</span>
                <button onClick={() => copyLink(linkFor.paymentLink)} title="Copiar link" className="shrink-0 p-1 hover:bg-sky-100 rounded-lg">
                  {copied === linkFor.paymentLink ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setLinkFor(null)} className="px-4 py-3 rounded-2xl text-xs font-black uppercase text-slate-500 hover:bg-slate-100">Cerrar</button>
              <button onClick={generateLink} className="px-5 py-3 rounded-2xl text-xs font-black uppercase bg-brand-600 text-white hover:bg-brand-700 shadow-lg">Generar link</button>
            </div>
          </div>
        </div>
      )}

      {selected && <InvoiceModal invoice={selected} onClose={() => { setSelected(null); load(); }} />}
    </div>
  );
};
