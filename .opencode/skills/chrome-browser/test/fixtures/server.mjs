// Opt-in manual Chrome smoke fixture. Run separately; Ctrl+C stops the loopback server.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./browser.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.url !== '/') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(html);
});
server.listen(18089, '127.0.0.1', () => console.log('Local Chrome smoke fixture: http://127.0.0.1:18089/'));
