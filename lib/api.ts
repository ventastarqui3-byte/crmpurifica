// Cliente HTTP central del CRM v3: todas las llamadas a /api pasan por aquí
// para enviar el token JWT (Bearer) guardado al iniciar sesión.
const TOKEN_KEY = 'purifica_token';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* almacenamiento no disponible */ }
}

export function clearAuth(): void {
  setToken(null);
  try { localStorage.removeItem('purifica_session'); } catch { /* noop */ }
}

let reloading = false;

/** Igual que fetch, pero añade Authorization: Bearer <token> cuando hay sesión.
 *  Si el servidor responde 401 (token vencido o inválido) cierra la sesión y
 *  recarga una sola vez, salvo en el propio login (donde el 401 es esperado). */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 && !input.includes('/api/auth/login') && !reloading) {
    reloading = true;
    clearAuth();
    window.location.reload();
  }
  return res;
}
