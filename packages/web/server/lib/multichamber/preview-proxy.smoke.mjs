#!/usr/bin/env bun
/*
 * Smoke-тест прокси превью по настоящему пути запуска: startPreviewProxy поднимает
 * дочерний `node`, а запросы идут к нему по сети. Не входит в vitest: нужен
 * исполняемый `node` в PATH и реальные порты. Запуск (из корня репозитория):
 *   bun packages/web/server/lib/multichamber/preview-proxy.smoke.mjs
 *   node packages/web/server/lib/multichamber/preview-proxy.smoke.mjs
 * Выход 0 только если все проверки прошли.
 *
 * Апстримы живут в отдельном процессе `node`: на Linux порт, который держит сам
 * родитель, прокси закрывает правилом владельца, а сервер Bun не отдаёт сырой сокет
 * при upgrade (замерено 2026-10-11).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';

import { resolveNodeBinary, startPreviewProxy } from './preview-proxy-process.js';

const DOMAIN = 'preview.smoke.test';
const KEY = 'abcdefghijk2';
const REQUEST_TIMEOUT_MS = 5_000;
const runtime = process.versions.bun === undefined ? `node ${process.version}` : `bun ${process.versions.bun}`;

const watchdog = setTimeout(() => {
  console.log('FAIL watchdog: smoke test took longer than 60s');
  process.exit(1);
}, 60_000);

const isPortFree = (port, host = '0.0.0.0') => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, host, () => probe.close(() => resolve(true)));
});

// Высокие порты вне 47xxx, чтобы не задеть боевой 47801 и порты OpenCode.
const pickPorts = async (count) => {
  const picked = new Set();
  while (picked.size < count) {
    const port = 50_000 + Math.floor(Math.random() * 9_000);
    if (!picked.has(port) && await isPortFree(port) && await isPortFree(port, '127.0.0.1')) picked.add(port);
  }
  return [...picked];
};

const UPSTREAM_SCRIPT = `
import http from 'node:http';
import net from 'node:net';
const [httpPort, wsPort, secretPort] = [process.env.UP_HTTP, process.env.UP_WS, process.env.UP_SECRET].map(Number);
const api = http.createServer((req, res) => {
  if (req.url === '/redir') { res.writeHead(302, { location: 'http://localhost:' + httpPort + '/next?a=1' }); res.end(); return; }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
});
const secret = http.createServer((_req, res) => res.end('secret'));
const ws = net.createServer((socket) => {
  let head = '';
  let upgraded = false;
  let seen = '';
  socket.on('data', (data) => {
    if (upgraded) { socket.write('echo:' + data.toString() + '|' + seen); return; }
    head += data.toString();
    if (!head.includes('\\r\\n\\r\\n')) return;
    const lines = head.split('\\r\\n');
    const get = (name) => (lines.find((line) => line.toLowerCase().startsWith(name + ':')) ?? '').slice(name.length + 1).trim();
    seen = JSON.stringify({ host: get('host'), origin: get('origin'), protocol: get('sec-websocket-protocol') });
    upgraded = true;
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Protocol: ' + get('sec-websocket-protocol') + '\\r\\n\\r\\n');
  });
  socket.on('error', () => socket.destroy());
});
await Promise.all([[api, httpPort], [ws, wsPort], [secret, secretPort]].map(([server, port]) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))));
console.log('upstream ready');
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

const startUpstreams = async (nodeBinary, ports) => {
  const child = spawn(nodeBinary, ['--input-type=module', '-e', UPSTREAM_SCRIPT], {
    env: { PATH: process.env.PATH ?? '', UP_HTTP: String(ports.http), UP_WS: String(ports.ws), UP_SECRET: String(ports.secret) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    readline.createInterface({ input: child.stdout }).on('line', (line) => { if (line === 'upstream ready') resolve(); });
    child.once('exit', (code) => reject(new Error(`upstream exited with ${code}`)));
  });
  return child;
};

const request = (proxyPort, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path, headers, agent: false, timeout: REQUEST_TIMEOUT_MS }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('request timed out')));
  req.on('error', reject);
  if (body !== undefined) req.write(body);
  req.end();
});

const websocketRoundTrip = (proxyPort, wsPort) => new Promise((resolve) => {
  const host = `${wsPort}-${KEY}.${DOMAIN}`;
  const socket = net.connect(proxyPort, '127.0.0.1', () => {
    socket.write([
      'GET /hmr HTTP/1.1', `Host: ${host}`, `X-Zeny-Preview-Port: ${wsPort}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Origin: https://${host}`, 'Sec-WebSocket-Protocol: vite-hmr', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: c21va2Utc21va2Utc21va2U=', '', '',
    ].join('\r\n'));
  });
  let buffer = '';
  const finish = (result) => {
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  };
  socket.on('data', (data) => {
    buffer += data.toString();
    if (buffer.includes('\r\n\r\n') && !buffer.includes('echo:') && !buffer.includes('ping-sent')) {
      buffer += 'ping-sent';
      socket.write('ping');
    }
    if (buffer.includes('echo:')) finish({ ok: true, buffer });
  });
  socket.on('error', (error) => finish({ ok: false, buffer: `error ${error.message}` }));
  const timer = setTimeout(() => finish({ ok: false, buffer: `timeout: ${JSON.stringify(buffer)}` }), REQUEST_TIMEOUT_MS);
});

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const nodeBinary = resolveNodeBinary(process.env);
if (!nodeBinary) {
  console.log('FAIL node binary not found in PATH');
  process.exit(1);
}
const [proxyPort, httpPort, wsPort, secretPort, emptyPort, selfPort] = await pickPorts(6);
console.log(`parent ${runtime}, child ${nodeBinary}; proxy ${proxyPort}, upstream ${httpPort}/${wsPort}, denied ${secretPort}, empty ${emptyPort}`);
const upstreams = await startUpstreams(nodeBinary, { http: httpPort, ws: wsPort, secret: secretPort });
// Порт самого родителя: на Linux его закрывает правило владельца, на macOS (без /proc) он открыт.
const selfServer = http.createServer((_req, res) => res.end('parent secret'));
await new Promise((resolve) => selfServer.listen(selfPort, '127.0.0.1', resolve));

const logs = [];
const proxy = await startPreviewProxy({
  env: { PATH: process.env.PATH, HOME: process.env.HOME, MULTICHAMBER_PREVIEW_NODE: process.env.MULTICHAMBER_PREVIEW_NODE, MULTICHAMBER_PREVIEW_PORT: String(proxyPort), MULTICHAMBER_PREVIEW_DOMAIN: DOMAIN, MULTICHAMBER_LLM_KEY: 'must-not-leak' },
  logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  getDeniedPorts: () => [secretPort],
});
check('startPreviewProxy returned a handle', proxy !== null);

const previewHost = (port) => `${port}-${KEY}.${DOMAIN}`;
const headersFor = (port, extra = {}) => ({ host: previewHost(port), 'x-zeny-preview-port': String(port), ...extra });

try {
  const get = await request(proxyPort, { path: '/a?b=1', headers: headersFor(httpPort, { origin: `https://${previewHost(httpPort)}` }) });
  const seen = get.status === 200 ? JSON.parse(get.body) : null;
  check('GET 200', get.status === 200, `status ${get.status}`);
  check('upstream Host localhost:<port>', seen?.headers.host === `localhost:${httpPort}`, seen?.headers.host);
  check('upstream Origin http://localhost:<port>', seen?.headers.origin === `http://localhost:${httpPort}`, seen?.headers.origin);
  check('X-Zeny-Preview-Port stripped', seen !== null && seen.headers['x-zeny-preview-port'] === undefined);

  const post = await request(proxyPort, { method: 'POST', path: '/p', headers: headersFor(httpPort, { 'content-type': 'text/plain' }), body: 'hello body' });
  check('POST body passes', post.status === 200 && JSON.parse(post.body).body === 'hello body', `status ${post.status}`);

  const redirect = await request(proxyPort, { path: '/redir', headers: headersFor(httpPort) });
  const expectedLocation = `https://${previewHost(httpPort)}/next?a=1`;
  check('Location rewritten', redirect.status === 302 && redirect.headers.location === expectedLocation, `${redirect.status} ${redirect.headers.location}`);

  const mismatch = await request(proxyPort, { headers: headersFor(httpPort, { 'x-zeny-preview-port': String(wsPort) }) });
  check('header/Host mismatch 421', mismatch.status === 421, `status ${mismatch.status}`);
  const noHeader = await request(proxyPort, { headers: { host: previewHost(httpPort) } });
  check('missing port header 421', noHeader.status === 421, `status ${noHeader.status}`);

  const denied = await request(proxyPort, { headers: headersFor(secretPort) });
  check('denied port 403', denied.status === 403 && !denied.body.includes('secret'), `status ${denied.status}`);

  const empty = await request(proxyPort, { headers: headersFor(emptyPort) });
  check('empty port 502 page', empty.status === 502 && empty.body.includes(`На порту ${emptyPort} ничего не запущено`), `status ${empty.status}`);

  const parentOwned = await request(proxyPort, { headers: headersFor(selfPort) });
  if (process.platform === 'linux') check('parent-owned port 403 (owner rule)', parentOwned.status === 403, `status ${parentOwned.status}`);
  else console.log(`skip parent-owned port owner rule (no /proc on ${process.platform}; got ${parentOwned.status})`);

  const ws = await websocketRoundTrip(proxyPort, wsPort);
  const wsSeen = ws.ok ? JSON.parse(ws.buffer.slice(ws.buffer.indexOf('|') + 1)) : null;
  check('WebSocket 101 + echo', ws.ok && ws.buffer.startsWith('HTTP/1.1 101') && ws.buffer.includes('echo:ping'), ws.ok ? '' : ws.buffer);
  check('WebSocket Sec-WebSocket-Protocol: vite-hmr reached upstream', wsSeen?.protocol === 'vite-hmr', wsSeen?.protocol);
  check('WebSocket Host/Origin rewritten', wsSeen?.host === `localhost:${wsPort}` && wsSeen?.origin === `http://localhost:${wsPort}`, JSON.stringify(wsSeen));

  const firstPid = proxy.getPid();
  if (process.platform === 'linux') {
    const environ = (await readFile(`/proc/${firstPid}/environ`, 'utf8')).split('\0').filter(Boolean);
    const names = environ.map((entry) => entry.slice(0, entry.indexOf('=')));
    check('child env is minimal', !names.includes('MULTICHAMBER_LLM_KEY') && names.every((name) => /^(PATH|HOME|NODE_ENV|LANG|MULTICHAMBER_PREVIEW_[A-Z_]+)$/.test(name)), names.join(','));
  } else {
    console.log(`skip child env check (environment of another process is not readable on ${process.platform})`);
  }
  process.kill(firstPid, 'SIGKILL');
  const restarted = await waitFor(async () => {
    const pid = proxy.getPid();
    if (pid === null || pid === firstPid) return false;
    return (await request(proxyPort, { headers: headersFor(httpPort) }).catch(() => ({ status: 0 }))).status === 200;
  }, 10_000);
  check('child restarted after SIGKILL', restarted, `pid ${firstPid} -> ${proxy.getPid()}`);
} finally {
  const lastPid = proxy?.getPid() ?? null;
  await proxy?.stop();
  check('child process gone after stop()', lastPid === null || !isProcessAlive(lastPid), `pid ${lastPid}`);
  check('proxy port free after stop()', await waitFor(() => isPortFree(proxyPort), 2_000), `port ${proxyPort}`);
  upstreams.stdin.end();
  upstreams.kill('SIGTERM');
  selfServer.close();
  console.log('child log:');
  for (const line of logs) console.log(`  ${line}`);
}

clearTimeout(watchdog);
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `PASS ${results.length} checks (${runtime})` : `FAILED ${failed}/${results.length} checks (${runtime})`);
process.exit(failed === 0 ? 0 : 1);
