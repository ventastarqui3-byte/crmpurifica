// Tailwind compilado en local (v5.3.24, A5). Antes el frontend cargaba
// Tailwind desde un CDN externo con un script inline; ahora se compila
// en el build (ver index.css) y la CSP puede ser estricta.
//
// Los colores de marca son variables CSS (--brand-*): lib/branding.ts
// las actualiza con el color primario que el admin elige en
// Personalización, e index.css trae los valores por defecto (azul cielo
// de Purifica). Así las clases bg-brand-600, text-brand-700,
// focus:ring-brand-500, etc. siguen el color de la marca sin inyectar
// ningún <style> en línea.
//
// IMPORTANTE: las variables guardan los canales RGB separados
// ("14 165 233", no "#0ea5e9") y el color se declara como
// rgb(var(--brand-500) / <alpha-value>). Es el patrón documentado de
// Tailwind v3 para que funcionen los modificadores de opacidad
// (bg-brand-500/20, shadow-brand-500/20, ...): con un var() simple
// Tailwind genera la clase sin modificador pero IGNORA la de /20
// (comprobado en prueba mínima con Tailwind 3.4.17).
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
