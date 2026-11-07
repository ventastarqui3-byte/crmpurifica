import React, { useEffect, useState } from 'react';
import { X, Printer, Building2 } from 'lucide-react';
import { Invoice } from '../types';
import { apiFetch } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { getCachedBranding } from '../lib/branding';

// Factura imprimible (documento interno de cobro).
// v5.1 Tipo: 'normal' → "Factura de venta" (sin DIAN, sin CUFE, sin
// resolución). 'electronica' → "Factura electrónica" DIAN-ready (con NIT,
// régimen y resolución; NO se envió a la DIAN). Ver README v5.1.
interface InvoiceModalProps {
  invoice: Invoice;
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  pendiente: 'PENDIENTE',
  parcial: 'PARCIAL',
  pagado: 'PAGADO',
  anulado: 'ANULADO',
};

const STATUS_CLASS: Record<string, string> = {
  pendiente: 'bg-amber-100 text-amber-700 border-amber-300',
  parcial: 'bg-sky-100 text-sky-700 border-sky-300',
  pagado: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  anulado: 'bg-red-100 text-red-700 border-red-300',
};

export const InvoiceModal: React.FC<InvoiceModalProps> = ({ invoice, onClose }) => {
  const [company, setCompany] = useState<Record<string, string>>({});
  const [payments, setPayments] = useState(invoice.payments || []);
  const branding = getCachedBranding();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [resSett, resInv] = await Promise.all([
          apiFetch('/api/settings'),
          apiFetch(`/api/invoices/${invoice.id}`),
        ]);
        if (!alive) return;
        if (resSett.ok) setCompany(await resSett.json());
        if (resInv.ok) {
          const data = await resInv.json();
          if (data.payments) setPayments(data.payments);
        }
      } catch { /* sin conexión: se muestra la factura con lo que llegó */ }
    })();
    return () => { alive = false; };
  }, [invoice.id]);

  const paidTotal = payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
  const dateStr = invoice.createdAt
    ? new Date(invoice.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 overflow-y-auto">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .invoice-print-area, .invoice-print-area * { visibility: visible !important; }
          .invoice-print-area { position: absolute !important; inset: 0 !important; width: 100% !important; max-height: none !important; overflow: visible !important; border: none !important; box-shadow: none !important; border-radius: 0 !important; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="invoice-print-area bg-white rounded-[2rem] shadow-2xl w-full max-w-2xl max-h-[95vh] overflow-y-auto border border-slate-200">
        <div className="p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {branding.logo_url ? (
                <img src={branding.logo_url} alt={branding.company_name} className="w-12 h-12 object-contain" />
              ) : (
                <div className="bg-brand-100 text-brand-600 p-3 rounded-2xl"><Building2 className="w-6 h-6" /></div>
              )}
              <div>
                <h2 className="text-xl font-black text-slate-800 tracking-tight leading-none">{branding.company_name}</h2>
                {company.company_nit && <p className="text-xs font-bold text-slate-500 mt-1">NIT: {company.company_nit}</p>}
                {company.company_regime && <p className="text-xs font-bold text-slate-500">Régimen: {company.company_regime}</p>}
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                {invoice.type === 'electronica' ? 'Factura electrónica' : 'Factura de venta'}
              </p>
              <p className="text-2xl font-black text-slate-800">{invoice.number}</p>
              <p className="text-xs font-bold text-slate-500">{dateStr}</p>
              <span className={`inline-block mt-2 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border ${STATUS_CLASS[invoice.status] || ''}`}>
                {STATUS_LABEL[invoice.status] || invoice.status}
              </span>
            </div>
          </div>

          {/* v5.1 La resolución DIAN solo se muestra en facturas
              electrónicas; una factura normal nunca la lleva. */}
          {invoice.type === 'electronica' && (company.dian_resolution_number || company.dian_resolution_range) && (
            <p className="text-[11px] font-bold text-slate-500 bg-slate-50 border border-slate-100 rounded-xl px-4 py-2">
              Resolución de facturación: {company.dian_resolution_number || '—'}
              {company.dian_resolution_range ? ` · Rango ${company.dian_resolution_range}` : ''}
              {company.dian_resolution_date ? ` · ${company.dian_resolution_date}` : ''}
            </p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-2xl border border-slate-100 p-4">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Cliente</p>
              <p className="font-black text-slate-800">{invoice.clientName}</p>
              <p className="text-xs font-bold text-slate-500">{invoice.clientPhone}</p>
              {invoice.clientNit && <p className="text-xs font-bold text-slate-500">NIT/CC: {invoice.clientNit}</p>}
            </div>
            <div className="bg-slate-50 rounded-2xl border border-slate-100 p-4">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Servicio</p>
              <p className="font-black text-slate-800">{invoice.servicePerformed || 'Servicio de limpieza'}</p>
              <p className="text-xs font-bold text-slate-500">
                {invoice.serviceDate ? `Realizado: ${invoice.serviceDate}` : ''}
                {invoice.serviceId ? ` · ID ${invoice.serviceId.slice(-6).toUpperCase()}` : ''}
              </p>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-black uppercase tracking-widest text-slate-400 border-b-2 border-slate-100">
                <th className="py-2">Concepto</th>
                <th className="py-2 text-right">Valor</th>
              </tr>
            </thead>
            <tbody className="font-bold text-slate-700">
              <tr className="border-b border-slate-100">
                <td className="py-3">Servicio de limpieza</td>
                <td className="py-3 text-right">{formatCurrency(invoice.subtotal)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-3">Abonos recibidos</td>
                <td className="py-3 text-right text-emerald-600">− {formatCurrency(invoice.advances)}</td>
              </tr>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="py-3">Pago · {p.method || 'Manual'}{p.reference ? ` (${p.reference})` : ''}</td>
                  <td className="py-3 text-right text-emerald-600">− {formatCurrency(p.amount)}</td>
                </tr>
              ))}
              <tr className="text-base">
                <td className="py-3 font-black text-slate-800">Saldo pendiente</td>
                <td className="py-3 text-right font-black text-slate-800">{formatCurrency(invoice.balance)}</td>
              </tr>
              <tr className="text-xs text-slate-400">
                <td className="py-1">Total del servicio</td>
                <td className="py-1 text-right">{formatCurrency(invoice.total)}</td>
              </tr>
            </tbody>
          </table>

          {paidTotal > 0 && (
            <p className="text-xs font-bold text-emerald-600">Total abonado (pagos registrados): {formatCurrency(paidTotal + invoice.advances)}</p>
          )}

          {invoice.paymentLink && invoice.status !== 'pagado' && (
            <p className="text-xs font-bold text-slate-500 break-all bg-sky-50 border border-sky-100 rounded-xl px-4 py-2">
              Link de pago: {invoice.paymentLink}
            </p>
          )}

          <p className="text-[10px] font-bold text-slate-400 text-center">
            {invoice.type === 'electronica'
              ? 'Factura electrónica DIAN-ready: lista para el proveedor certificado. Este CRM no la envió a la DIAN.'
              : 'Factura de venta (sin DIAN). Documento interno de cobro, no es una factura electrónica.'}
          </p>

          <div className="no-print flex gap-3 justify-end pt-2">
            <button onClick={onClose} className="px-5 py-3 rounded-2xl text-xs font-black uppercase tracking-widest text-slate-500 hover:bg-slate-100 flex items-center gap-2">
              <X className="w-4 h-4" /> Cerrar
            </button>
            <button onClick={() => window.print()} className="px-5 py-3 rounded-2xl text-xs font-black uppercase tracking-widest bg-brand-600 text-white hover:bg-brand-700 shadow-lg flex items-center gap-2">
              <Printer className="w-4 h-4" /> Imprimir
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
