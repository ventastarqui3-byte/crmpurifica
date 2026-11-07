// Marca blanca: nombre, logo y colores de la empresa. Se guardan en el
// servidor (tabla settings, claves branding_*) y se aplican sin tocar código.
// El login y el menú leen esta configuración; la página Personalización la edita.
import { apiFetch } from './api';

export interface Branding {
  company_name: string;
  tagline: string;
  logo_url: string;
  primary_color: string;
  secondary_color: string;
}

export const DEFAULT_BRANDING: Branding = {
  company_name: 'Purifica Tu Ambiente',
  tagline: 'Sistema Integrado de Gestión CRM',
  logo_url: '',
  primary_color: '#0284c7',
  secondary_color: '#0ea5e9',
};

const CACHE_KEY = 'purifica_branding';
let cached: Branding | null = null;

export function getCachedBranding(): Branding {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) cached = { ...DEFAULT_BRANDING, ...JSON.parse(raw) };
  } catch { /* noop */ }
  return cached || { ...DEFAULT_BRANDING };
}

function mix(hex: string, target: string, amount: number): string {
  // Sin validar, un color de 3 dígitos (#fff) o inválido producía NaN y
  // variables CSS rotas. Se devuelve el color tal cual si no es #RRGGBB.
  if (!/^#[0-9a-fA-F]{6}$/.test(hex) || !/^#[0-9a-fA-F]{6}$/.test(target)) return hex;
  const p = (h: string) => parseInt(h, 16);
  const r = Math.round(p(hex.slice(1, 3)) + (p(target.slice(1, 3)) - p(hex.slice(1, 3))) * amount);
  const g = Math.round(p(hex.slice(3, 5)) + (p(target.slice(3, 5)) - p(hex.slice(3, 5))) * amount);
  const b = Math.round(p(hex.slice(5, 7)) + (p(target.slice(5, 7)) - p(hex.slice(5, 7))) * amount);
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

/** Aplica nombre (título), colores primarios (variables CSS + overrides de las
 *  clases brand-* de Tailwind CDN) y avisa al resto de la app. */
export function applyBranding(b: Branding): void {
  cached = b;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(b)); } catch { /* noop */ }
  document.title = `${b.company_name} CRM`;
  const root = document.documentElement;
  const p = b.primary_color || DEFAULT_BRANDING.primary_color;
  const shades: Record<string, string> = {
    '50': mix(p, '#ffffff', 0.93),
    '100': mix(p, '#ffffff', 0.85),
    '200': mix(p, '#ffffff', 0.68),
    '300': mix(p, '#ffffff', 0.45),
    '400': mix(p, '#ffffff', 0.25),
    '500': mix(p, '#ffffff', 0.12),
    '600': p,
    '700': mix(p, '#000000', 0.14),
    '800': mix(p, '#000000', 0.30),
    '900': mix(p, '#000000', 0.45),
  };
  Object.entries(shades).forEach(([k, v]) => root.style.setProperty(`--brand-${k}`, v));
  root.style.setProperty('--brand-secondary', b.secondary_color || DEFAULT_BRANDING.secondary_color);
  let style = document.getElementById('branding-style') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'branding-style';
    document.head.appendChild(style);
  }
  style.textContent = `
    .bg-brand-600{background-color:var(--brand-600)!important}
    .bg-brand-500{background-color:var(--brand-500)!important}
    .bg-brand-50{background-color:var(--brand-50)!important}
    .bg-brand-100{background-color:var(--brand-100)!important}
    .bg-brand-200{background-color:var(--brand-200)!important}
    .bg-brand-300{background-color:var(--brand-300)!important}
    .bg-brand-400{background-color:var(--brand-400)!important}
    .bg-brand-700{background-color:var(--brand-700)!important}
    .bg-brand-800{background-color:var(--brand-800)!important}
    .bg-brand-900{background-color:var(--brand-900)!important}
    .text-brand-100{color:var(--brand-100)!important}
    .text-brand-200{color:var(--brand-200)!important}
    .text-brand-300{color:var(--brand-300)!important}
    .text-brand-600{color:var(--brand-600)!important}
    .text-brand-700{color:var(--brand-700)!important}
    .text-brand-500{color:var(--brand-500)!important}
    .text-brand-400{color:var(--brand-400)!important}
    .text-brand-800{color:var(--brand-800)!important}
    .text-brand-900{color:var(--brand-900)!important}
    .border-brand-200{border-color:var(--brand-200)!important}
    .border-brand-500{border-color:var(--brand-500)!important}
    .border-brand-600{border-color:var(--brand-600)!important}
    .hover\\:bg-brand-700:hover{background-color:var(--brand-700)!important}
    .focus\\:ring-brand-500:focus{--tw-ring-color:var(--brand-500)!important}
    .focus\\:border-brand-500:focus{border-color:var(--brand-500)!important}
  `;
  window.dispatchEvent(new CustomEvent('branding-updated', { detail: b }));
}

export async function loadBranding(): Promise<Branding> {
  try {
    const res = await apiFetch('/api/settings/branding');
    if (res.ok) {
      const data = await res.json();
      const b: Branding = { ...DEFAULT_BRANDING, ...data };
      applyBranding(b);
      return b;
    }
  } catch { /* sin conexión: se usa la caché o los valores por defecto */ }
  const fallback = getCachedBranding();
  applyBranding(fallback);
  return fallback;
}
