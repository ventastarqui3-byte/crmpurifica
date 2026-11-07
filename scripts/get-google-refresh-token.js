// Obtiene el refresh token de Google Calendar para el CRM.
// Uso:
//   1) Crea el proyecto y las credenciales OAuth en Google Cloud (ver
//      README, sección "Google Calendar").
//   2) npm install   (instala googleapis, ya está en package.json)
//   3) node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>
//      o con variables de entorno:
//      GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-google-refresh-token.js
//   4) Abre en el navegador la URL que imprime, entra con la cuenta de
//      Google de la empresa, acepta, y el script captura el código solo
//      (servidor local en http://localhost:8089) e imprime el REFRESH TOKEN.
//   5) Pon ese token en .env como GOOGLE_REFRESH_TOKEN (o en el CRM, solo
//      admin) y reinicia el servidor. El token NO se guarda en ningún
//      archivo: cópialo tú al .env y cierra esta ventana.
// IMPORTANTE: añade http://localhost:8089 como "URI de redireccionamiento
// autorizado" en la credencial OAuth de Google Cloud (es el redirect_uri
// que usa este script). Sin eso, Google rechaza el flujo con
// redirect_uri_mismatch.
import http from 'http';
import { google } from 'googleapis';

const clientId = process.argv[2] || process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.argv[3] || process.env.GOOGLE_CLIENT_SECRET || '';
if (!clientId || !clientSecret) {
  console.error('Faltan CLIENT_ID y CLIENT_SECRET.\nUso: node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:8089';
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
const url = oauth2.generateAuthUrl({
  access_type: 'offline', // offline = Google devuelve refresh token
  prompt: 'consent', // consent = fuerza a devolver refresh token aunque ya hubiera uno
  scope: ['https://www.googleapis.com/auth/calendar'],
});

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, REDIRECT_URI);
    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Error de Google</h1><p>' + error + '</p><p>Cierra esta ventana y vuelve a intentarlo.</p>');
      console.error('Google devolvió un error:', error);
      server.close();
      process.exit(1);
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Falta el código</h1><p>Vuelve a abrir la URL de autorización.</p>');
      return;
    }
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>¡Listo!</h1><p>El refresh token se imprimió en la terminal. Copia el valor de GOOGLE_REFRESH_TOKEN al .env y cierra esta ventana.</p>');
    console.log('\n================ REFRESH TOKEN ================');
    console.log('GOOGLE_REFRESH_TOKEN=' + (tokens.refresh_token || '(Google no devolvió refresh token: vuelve a correr el script; si la app ya estaba autorizada, quita el acceso en https://myaccount.google.com/permissions y repite)'));
    console.log('================================================\n');
    console.log('También necesitarás:');
    console.log('  GOOGLE_CLIENT_ID=' + clientId);
    console.log('  GOOGLE_CLIENT_SECRET=' + clientSecret);
    console.log('  GOOGLE_CALENDAR_ID=primary  (o el ID del calendario compartido)');
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Error</h1><p>' + e.message + '</p>');
    console.error('Error intercambiando el código:', e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(8089, () => {
  console.log('1) Abre esta URL en tu navegador (con la cuenta de Google de la empresa):\n');
  console.log(url);
  console.log('\n2) Acepta el acceso al calendario. El script captura el código solo.');
  console.log('   (Si el puerto 8089 está ocupado, cierra lo que lo use y repite.)\n');
});
