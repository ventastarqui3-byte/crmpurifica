// Cliente HTTP central del CRM v5.3.24: todas las llamadas a /api pasan
// por aquí.
//
// v5.3.24 (A5): el JWT ya NO vive en localStorage (cualquier script en el
// origen lo leía y suplanta al usuario). El servidor lo emite en cookie
// HttpOnly al iniciar sesión y el navegador la envía solo (mismo origen),
// así que este cliente ya no guarda ni manda ningún token: solo pide
// `credentials: 'same-origin'` para que la cookie viaje con cada llamada.
// Si el servidor responde 401 (sesión vencida o inválida) cierra la
// sesión y recarga una sola vez, salvo en el propio login y en
// /api/auth/me (donde el 401 solo significa "sin sesión").

let reloading = false;

/** Igual que fetch, pero con la cookie de sesión y manejo del 401. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(input, { ...init, headers, credentials: 'same-origin' });
  if (
    res.status === 401 &&
    !input.includes('/api/auth/login') &&
    !input.includes('/api/auth/me') &&
    !reloading
  ) {
    reloading = true;
    clearAuth();
    window.location.reload();
  }
  return res;
}

/** Cerrar sesión: borra la cookie en el servidor (con fetch directo, no
 *  con apiFetch, para no entrar en bucle si el 401 viene de aquí) y deja
 *  la app en el login. */
export function clearAuth(): void {
  try {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  } catch { /* sin conexión: la cookie caduca sola en 24 h */ }
}
