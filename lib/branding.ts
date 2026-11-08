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
  // v5.3.24 (M8): valor por defecto NEUTRO. La marca real de Purifica
  // vive en la tabla settings (branding_*) de su instalación; una
  // instalación revendida sin personalizar muestra "CRM".
  company_name: 'CRM',
  tagline: 'Sistema Integrado de Gestión CRM',
  logo_url: '',
  primary_color: '#0284c7',
  secondary_color: '#0ea5e9',
};

// v5.3.26 (B4): clave neutra. Antes 'purifica_branding' delataba la
// empresa en DevTools en instalaciones revendidas. Al cambiar la clave,
// la marca se vuelve a cargar del servidor en la próxima visita.
const CACHE_KEY = 'crm_branding';
let cached: Branding | null = null;

export function getCachedBranding(): Branding {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) cached = { ...DEFAULT_BRANDING, ...JSON.parse(raw) };
  } catch { /* noop */ }
  return cached || { ...DEFAULT_BRANDING };
}

/** Iniciales de la empresa para el logo provisional (B4, v5.3.26):
 * cuando no hay logo subido se muestran las iniciales del nombre en
 * vez de un icono fijo. "Purifica Tu Ambiente" -> "PT"; "CRM" -> "CR". */
export function companyInitials(name: string): string {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'CRM';
  const first = words[0][0] || '';
  const second = words.length > 1 ? (words[1][0] || '') : (words[0][1] || '');
  return (first + second).toUpperCase();
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

/** Hex #RRGGBB -> canales "R G B" (p. ej. "#0284c7" -> "2 132 199").
 *  Las variables --brand-* guardan canales separados, no hex, para que
 *  Tailwind pueda aplicarles opacidad (rgb(var(--brand-500) / 0.2)). */
function hexToChannels(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex;
  return `${parseInt(m[1].slice(0, 2), 16)} ${parseInt(m[1].slice(2, 4), 16)} ${parseInt(m[1].slice(4, 6), 16)}`;
}

/** Aplica nombre (título) y colores primarios (variables CSS --brand-*
 *  que Tailwind compilado usa para las clases brand-*). */
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
  Object.entries(shades).forEach(([k, v]) => root.style.setProperty(`--brand-${k}`, hexToChannels(v)));
  root.style.setProperty('--brand-secondary', b.secondary_color || DEFAULT_BRANDING.secondary_color);
  // v5.3.24 (A5): ya NO se inyecta un <style> con las clases brand-*
  // (la CSP bloquearía el <style> en línea y era la única pieza de
  // estilo en línea). Las clases brand-* de Tailwind compilado leen
  // estas mismas variables --brand-* (ver tailwind.config.js), así que
  // basta con actualizarlas aquí; index.css trae los valores por
  // defecto. Si una versión vieja inyectó el <style>, se elimina.
  const old = document.getElementById('branding-style');
  if (old) old.remove();
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
