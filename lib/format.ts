// Formato de dinero único para todo el CRM (antes había 4 copias idénticas
// de formatCurrency en Dashboard, BusinessDeals, ClientsList y
// TeamManagement, y varias variantes con toLocaleString sin locale).
export function formatCurrency(val: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val);
}
