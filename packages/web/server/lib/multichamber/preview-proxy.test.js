import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { createPreviewProxy, readPreviewProxyConfig, rewriteLocation } from './preview-proxy.js';

const DOMAIN = 'p.example.test';
const KEY = 'abcdefghijk2';

const silentLogger = () => {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args.join(' ')) };
};

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const listen = (server, host = '127.0.0.1') => new Promise((resolve) => {
  server.listen(0, host, () => resolve(server.address().port));
  cleanups.push(() => new Promise((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  }));
});

const startUpstream = async (handler, host = '127.0.0.1') => {
  const server = http.createServer(handler);
  const port = await listen(server, host);
  return { server, port };
};

const startProxy = async (options = {}) => {
  const server = createPreviewProxy({ domain: DOMAIN, logger: silentLogger(), ...options });
  const port = await listen(server);
  return { server, port };
};

const previewHost = (port) => `${port}-${KEY}.${DOMAIN}`;

/** Сырой HTTP-запрос: supertest и fetch не дают задать произвольный Host. */
const send = (proxyPort, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', reject);
  });
  req.on('error', reject);
  if (body !== undefined) req.write(body);
  req.end();
});

const previewHeaders = (port, extra = {}) => ({ host: previewHost(port), 'x-zeny-preview-port': String(port), ...extra });

const freePort = async () => {
  const probe = net.createServer();
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

describe('readPreviewProxyConfig', () => {
  it('needs both the port and the domain', () => {
    expect(readPreviewProxyConfig({})).toBeNull();
    expect(readPreviewProxyConfig({ MULTICHAMBER_PREVIEW_PORT: '47801' })).toBeNull();
    expect(readPreviewProxyConfig({ MULTICHAMBER_PREVIEW_DOMAIN: DOMAIN })).toBeNull();
  });

  it('parses a valid pair and lowercases the domain', () => {
    expect(readPreviewProxyConfig({ MULTICHAMBER_PREVIEW_PORT: ' 47801 ', MULTICHAMBER_PREVIEW_DOMAIN: ' P.Example.Test. ' }))
      .toEqual({ port: 47801, domain: DOMAIN });
  });

  it.each([
    ['0', DOMAIN], ['70000', DOMAIN], ['47801x', DOMAIN], ['47801', 'bad domain'], ['47801', '*.p.example.test'],
  ])('rejects port %s with domain %s', (port, domain) => {
    expect(readPreviewProxyConfig({ MULTICHAMBER_PREVIEW_PORT: port, MULTICHAMBER_PREVIEW_DOMAIN: domain })).toBeNull();
  });
});

describe('rewriteLocation', () => {
  const host = previewHost(5173);

  it('moves loopback redirects of the same port to the public host', () => {
    expect(rewriteLocation('http://localhost:5173/login?next=%2F#top', 5173, host)).toBe(`https://${host}/login?next=%2F#top`);
    expect(rewriteLocation('http://127.0.0.1:5173/a', 5173, host)).toBe(`https://${host}/a`);
    expect(rewriteLocation('http://[::1]:5173/a', 5173, host)).toBe(`https://${host}/a`);
  });

  it('keeps relative, foreign and other-port redirects', () => {
    expect(rewriteLocation('/login', 5173, host)).toBe('/login');
    expect(rewriteLocation('https://example.com/', 5173, host)).toBe('https://example.com/');
    expect(rewriteLocation('http://localhost:3000/', 5173, host)).toBe('http://localhost:3000/');
  });
});

describe('preview proxy: request checks', () => {
  it('answers 421 without the port header', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = await startProxy();
    const response = await send(proxy.port, { headers: { host: previewHost(upstream.port) } });
    expect(response.status).toBe(421);
    expect(response.body).not.toContain('upstream');
  });

  it('answers 421 when Host is not a preview host of the domain', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = await startProxy();
    for (const host of [`${upstream.port}-${KEY}.evil.test`, `localhost:${upstream.port}`, `${upstream.port}-ABCDEFGHIJK2.${DOMAIN}`, `x${upstream.port}-${KEY}.${DOMAIN}`]) {
      const response = await send(proxy.port, { headers: { host, 'x-zeny-preview-port': String(upstream.port) } });
      expect(response.status).toBe(421);
    }
  });

  it('answers 421 when the Host port and the header port differ', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = await startProxy();
    const response = await send(proxy.port, { headers: { host: previewHost(upstream.port), 'x-zeny-preview-port': '5173' } });
    expect(response.status).toBe(421);
  });

  it('accepts a Host with an explicit port', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = await startProxy();
    const response = await send(proxy.port, { headers: previewHeaders(upstream.port, { host: `${previewHost(upstream.port)}:443` }) });
    expect(response.status).toBe(200);
  });

  it('answers 403 for a denied port without contacting it', async () => {
    let hits = 0;
    const upstream = await startUpstream((_req, res) => { hits += 1; res.end('secret'); });
    const proxy = await startProxy({ getDeniedPorts: () => [upstream.port] });
    const response = await send(proxy.port, { headers: previewHeaders(upstream.port) });
    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).not.toContain('secret');
    expect(hits).toBe(0);
  });

  it.each([22, 1000, 1023, 47765])('answers 403 for the always-denied port %i', async (port) => {
    const proxy = await startProxy();
    const response = await send(proxy.port, { headers: { host: `${port}-${KEY}.${DOMAIN}`, 'x-zeny-preview-port': String(port) } });
    expect(response.status).toBe(port === 22 ? 421 : 403);
  });

  const OPENCODE_PID = 424_242;

  it.each([
    ['this server', process.pid],
    ['an environment process such as opencode serve', OPENCODE_PID],
  ])('answers 403 for a port whose listening socket belongs to %s', async (_owner, ownerPid) => {
    const upstream = await startUpstream((_req, res) => res.end('secret'));
    const proxy = await startProxy({ resolvePortOwners: async () => [ownerPid], isEnvironmentOwner: async (pid) => pid === OPENCODE_PID });
    const response = await send(proxy.port, { headers: previewHeaders(upstream.port) });
    expect(response.status).toBe(403);
    expect(response.body).not.toContain('secret');
  });

  it('proxies a port owned by an unrelated process such as an orphan reparented to PID 1', async () => {
    const upstream = await startUpstream((_req, res) => res.end('dev server'));
    const asked = [];
    const proxy = await startProxy({
      resolvePortOwners: async (port) => { asked.push(port); return [OPENCODE_PID + 1]; },
      isEnvironmentOwner: (pid) => pid === OPENCODE_PID,
    });
    const response = await send(proxy.port, { headers: previewHeaders(upstream.port) });
    expect(response.status).toBe(200);
    expect(response.body).toBe('dev server');
    expect(asked).toEqual([upstream.port]);
  });

  it('proxies when the owner lookup fails but still enforces the static list', async () => {
    const upstream = await startUpstream((_req, res) => res.end('dev server'));
    const denied = await startUpstream((_req, res) => res.end('secret'));
    const proxy = await startProxy({
      resolvePortOwners: async () => { throw new Error('EACCES'); },
      getDeniedPorts: () => [denied.port],
    });
    expect((await send(proxy.port, { headers: previewHeaders(upstream.port) })).status).toBe(200);
    expect((await send(proxy.port, { headers: previewHeaders(denied.port) })).status).toBe(403);
  });

  it('does not cache a denial: the port opens once its owner changes', async () => {
    const upstream = await startUpstream((_req, res) => res.end('dev server'));
    let owner = process.pid;
    const proxy = await startProxy({ resolvePortOwners: async () => [owner] });
    expect((await send(proxy.port, { headers: previewHeaders(upstream.port) })).status).toBe(403);
    owner = OPENCODE_PID + 1;
    expect((await send(proxy.port, { headers: previewHeaders(upstream.port) })).status).toBe(200);
  });

  it('answers 502, not 403, when nothing listens even if the lookup would deny', async () => {
    const port = await freePort();
    const proxy = await startProxy({ resolvePortOwners: async () => [process.pid] });
    const response = await send(proxy.port, { headers: previewHeaders(port) });
    expect(response.status).toBe(502);
  });

  it('shows a page instead of a bare 502 when nothing listens', async () => {
    const port = await freePort();
    const proxy = await startProxy();
    const response = await send(proxy.port, { headers: previewHeaders(port) });
    expect(response.status).toBe(502);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(`На порту ${port} ничего не запущено`);
    expect(response.body).not.toMatch(/<script|https?:\/\//i);
  });
});

describe('preview proxy: forwarding', () => {
  it('rewrites Host and Origin, sets X-Forwarded-* and drops the port header', async () => {
    let seen = null;
    const upstream = await startUpstream((req, res) => {
      seen = req.headers;
      res.end('ok');
    });
    const proxy = await startProxy();
    const response = await send(proxy.port, {
      method: 'POST',
      path: '/api?x=1',
      headers: previewHeaders(upstream.port, { origin: `https://${previewHost(upstream.port)}`, 'x-forwarded-for': '203.0.113.7', 'content-type': 'text/plain' }),
      body: 'payload',
    });
    expect(response.status).toBe(200);
    expect(seen.host).toBe(`localhost:${upstream.port}`);
    expect(seen.origin).toBe(`http://localhost:${upstream.port}`);
    expect(seen['x-forwarded-host']).toBe(previewHost(upstream.port));
    expect(seen['x-forwarded-proto']).toBe('https');
    expect(seen['x-forwarded-for']).toBe('203.0.113.7, 127.0.0.1');
    expect(seen['x-zeny-preview-port']).toBeUndefined();
  });

  it('does not invent an Origin when the client sent none', async () => {
    let seen = null;
    const upstream = await startUpstream((req, res) => { seen = req.headers; res.end('ok'); });
    const proxy = await startProxy();
    await send(proxy.port, { headers: previewHeaders(upstream.port) });
    expect(seen.origin).toBeUndefined();
  });

  it('passes the request body and the response status and headers', async () => {
    const upstream = await startUpstream((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(201, { 'x-echo': 'yes', 'set-cookie': ['a=1', 'b=2'] });
        res.end(Buffer.concat(chunks));
      });
    });
    const proxy = await startProxy();
    const response = await send(proxy.port, { method: 'PUT', headers: previewHeaders(upstream.port), body: 'hello body' });
    expect(response.status).toBe(201);
    expect(response.body).toBe('hello body');
    expect(response.headers['x-echo']).toBe('yes');
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('rewrites a loopback redirect to the public host', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${upstream.port}/next?a=1` });
      res.end();
    });
    const proxy = await startProxy();
    const response = await send(proxy.port, { headers: previewHeaders(upstream.port) });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`https://${previewHost(upstream.port)}/next?a=1`);
  });

  it('falls back to ::1 when 127.0.0.1 refuses', async () => {
    const upstream = await startUpstream((_req, res) => res.end('from ipv6'), '::1');
    const proxy = await startProxy();
    const response = await send(proxy.port, { headers: previewHeaders(upstream.port) });
    expect(response.status).toBe(200);
    expect(response.body).toBe('from ipv6');
  });

  it('streams a chunked response before it ends', async () => {
    let finish = () => {};
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first chunk');
      finish = () => res.end('last chunk');
    });
    const proxy = await startProxy();
    const firstChunk = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, headers: previewHeaders(upstream.port), agent: false }, (res) => {
        res.once('data', (chunk) => {
          resolve(chunk.toString('utf8'));
          res.resume();
          finish();
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(firstChunk).toBe('first chunk');
  });

  it('closes the upstream request when the client goes away', async () => {
    let upstreamClosed = null;
    const closed = new Promise((resolve) => { upstreamClosed = resolve; });
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200);
      res.write('partial');
      res.on('close', () => upstreamClosed(true));
    });
    const proxy = await startProxy();
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, headers: previewHeaders(upstream.port), agent: false }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
      req.end();
    });
    await expect(closed).resolves.toBe(true);
  });

  it('survives an upstream that drops the connection mid-response', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200);
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 10);
    });
    const proxy = await startProxy();
    await expect(send(proxy.port, { headers: previewHeaders(upstream.port) })).rejects.toThrow();
    const after = await send(proxy.port, { headers: { host: 'nope' } });
    expect(after.status).toBe(421);
  });
});

describe('preview proxy: websockets', () => {
  const startEcho = async (host = '127.0.0.1') => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const handshakes = [];
    wss.on('connection', (socket, req) => {
      handshakes.push(req.headers);
      socket.on('message', (data) => socket.send(`echo:${data}`));
    });
    cleanups.push(() => new Promise((done) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => done());
    }));
    const port = await listen(server, host);
    return { port, handshakes };
  };

  const connect = (proxyPort, headers) => new WebSocket(`ws://127.0.0.1:${proxyPort}/hmr`, { headers });

  it('proxies an upgrade and rewrites its Host and Origin', async () => {
    const echo = await startEcho();
    const proxy = await startProxy();
    const socket = connect(proxy.port, previewHeaders(echo.port, { origin: `https://${previewHost(echo.port)}` }));
    cleanups.push(async () => socket.terminate());
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send('ping');
    const reply = await new Promise((resolve) => socket.once('message', (data) => resolve(String(data))));
    expect(reply).toBe('echo:ping');
    expect(echo.handshakes[0].host).toBe(`localhost:${echo.port}`);
    expect(echo.handshakes[0].origin).toBe(`http://localhost:${echo.port}`);
    expect(echo.handshakes[0]['x-zeny-preview-port']).toBeUndefined();
    expect(echo.handshakes[0]['x-forwarded-host']).toBe(previewHost(echo.port));
  });

  it('proxies an upgrade to a ::1-only listener', async () => {
    const echo = await startEcho('::1');
    const proxy = await startProxy();
    const socket = connect(proxy.port, previewHeaders(echo.port));
    cleanups.push(async () => socket.terminate());
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send('v6');
    const reply = await new Promise((resolve) => socket.once('message', (data) => resolve(String(data))));
    expect(reply).toBe('echo:v6');
  });

  const rejectedStatus = (socket) => new Promise((resolve) => {
    socket.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    socket.once('error', () => resolve('error'));
  });

  it('refuses an upgrade with a foreign Host with 421', async () => {
    const echo = await startEcho();
    const proxy = await startProxy();
    const socket = connect(proxy.port, { host: `${echo.port}-${KEY}.evil.test`, 'x-zeny-preview-port': String(echo.port) });
    expect(await rejectedStatus(socket)).toBe(421);
    expect(echo.handshakes).toEqual([]);
  });

  it('refuses an upgrade to a denied port with 403', async () => {
    const echo = await startEcho();
    const proxy = await startProxy({ getDeniedPorts: () => [echo.port] });
    const socket = connect(proxy.port, previewHeaders(echo.port));
    expect(await rejectedStatus(socket)).toBe(403);
    expect(echo.handshakes).toEqual([]);
  });

  it('answers 502 to an upgrade when nothing listens', async () => {
    const port = await freePort();
    const proxy = await startProxy();
    const socket = connect(proxy.port, previewHeaders(port));
    expect(await rejectedStatus(socket)).toBe(502);
  });
});
