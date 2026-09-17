import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { requestJson } from '../src/protocol.mjs';

test('HTTP client rejects interrupted responses and enforces a deadline', async t => {
  const server = createServer((request, response) => {
    if (request.url === '/interrupted') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      response.write('{');
      setImmediate(() => response.destroy());
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  await assert.rejects(requestJson('/interrupted', { port, timeout: 1_000 }));
  await assert.rejects(requestJson('/wait', { port, timeout: 50 }), /timed out/);
});
