import http from 'node:http';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createHostGuard, parseAllowedHosts } from './host-guard.js';

const ENV = { MULTICHAMBER_ALLOWED_HOSTS: 'app.ai.meybz.asia' };

const silentLogger = () => {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
};

const buildApp = (env = ENV, logger = silentLogger()) => {
  const app = express();
  const guard = createHostGuard({ env, logger });
  if (guard) app.use(guard.middleware);
  app.all('/probe', (_req, res) => res.status(200).send('ok'));
  return app;
};

describe('parseAllowedHosts', () => {
  it('returns null when the env is unset or blank', () => {
    expect(parseAllowedHosts(undefined)).toBeNull();
    expect(parseAllowedHosts(' , ')).toBeNull();
  });

  it('lowercases, trims and drops a trailing dot', () => {
    expect([...parseAllowedHosts(' App.AI.meybz.asia. , other.example ')]).toEqual(['app.ai.meybz.asia', 'other.example']);
  });
});

describe('createHostGuard: disabled', () => {
  it('returns null and lets an unknown Host through when MULTICHAMBER_ALLOWED_HOSTS is unset', async () => {
    expect(createHostGuard({ env: {} })).toBeNull();
    const response = await request(buildApp({})).get('/probe').set('Host', 'evil.com');
    expect(response.status).toBe(200);
  });
});

describe('createHostGuard: Host check', () => {
  it.each([
    'app.ai.meybz.asia',
    'App.AI.meybz.asia.',
    '127.0.0.1:3000',
    '10.77.1.5:3000',
    '[::1]:3000',
    'localhost:3000',
    'preview.localhost',
  ])('allows Host %s', async (host) => {
    const response = await request(buildApp()).get('/probe').set('Host', host);
    expect(response.status).toBe(200);
  });

  it('answers 421 text/plain without CORS headers for an unknown Host', async () => {
    const response = await request(buildApp()).get('/probe').set('Host', 'evil.com').set('Origin', 'http://localhost:3000');
    expect(response.status).toBe(421);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('Host not allowed');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a lookalike suffix of an allowed host', async () => {
    const response = await request(buildApp()).get('/probe').set('Host', 'app.ai.meybz.asia.evil.com');
    expect(response.status).toBe(421);
  });

  it('logs a repeated rejection for the same host once', async () => {
    const logger = silentLogger();
    const app = buildApp(ENV, logger);
    await request(app).get('/probe').set('Host', 'evil.com');
    await request(app).get('/probe').set('Host', 'evil.com');
    expect(logger.warnings).toHaveLength(1);
  });
});

describe('createHostGuard: cross-site writes', () => {
  it('blocks a POST from a foreign Origin', async () => {
    const response = await request(buildApp()).post('/probe').set('Host', 'localhost:3000').set('Origin', 'https://evil.com');
    expect(response.status).toBe(403);
    expect(response.text).toBe('Cross-site request blocked');
  });

  it('passes a same-origin POST', async () => {
    const response = await request(buildApp()).post('/probe').set('Host', 'localhost:3000').set('Origin', 'http://localhost:3000');
    expect(response.status).toBe(200);
  });

  it('passes a POST from an allowlisted https Origin', async () => {
    const response = await request(buildApp()).post('/probe').set('Host', 'app.ai.meybz.asia').set('Origin', 'https://app.ai.meybz.asia');
    expect(response.status).toBe(200);
  });

  it('blocks a POST marked Sec-Fetch-Site: cross-site', async () => {
    const response = await request(buildApp()).post('/probe').set('Host', 'localhost:3000').set('Sec-Fetch-Site', 'cross-site');
    expect(response.status).toBe(403);
  });

  it('blocks a POST with Origin null', async () => {
    const response = await request(buildApp()).post('/probe').set('Host', 'localhost:3000').set('Origin', 'null');
    expect(response.status).toBe(403);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('blocks a %s from a foreign Origin', async (method) => {
    const response = await request(buildApp())[method.toLowerCase()]('/probe').set('Host', 'localhost:3000').set('Origin', 'https://evil.com');
    expect(response.status).toBe(403);
  });

  it('passes a POST without Origin and Sec-Fetch-Site', async () => {
    const response = await request(buildApp()).post('/probe').set('Host', '127.0.0.1:3000');
    expect(response.status).toBe(200);
  });

  it('passes a GET with a foreign Origin on an allowed Host', async () => {
    const response = await request(buildApp()).get('/probe').set('Host', 'app.ai.meybz.asia').set('Origin', 'https://evil.com');
    expect(response.status).toBe(200);
  });
});

describe('createHostGuard: upgrades', () => {
  /** @type {http.Server | null} */
  let server = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  // Обработчик upgrade отвечает 418: так видно, дошёл ли запрос до него.
  const startServer = async () => {
    const guard = createHostGuard({ env: ENV, logger: silentLogger() });
    server = http.createServer((_req, res) => res.end());
    guard.installOnServer(server);
    server.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 418 I am a teapot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  };

  const upgrade = (port, headers) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/terminal/ws',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
    });
    req.on('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });

  it('rejects an unknown Host with 421', async () => {
    const port = await startServer();
    expect(await upgrade(port, { Host: 'evil.com' })).toBe(421);
  });

  it('rejects a cross-site Origin with 403', async () => {
    const port = await startServer();
    expect(await upgrade(port, { Host: 'localhost:3000', Origin: 'https://evil.com' })).toBe(403);
  });

  it('rejects Sec-Fetch-Site: cross-site with 403', async () => {
    const port = await startServer();
    expect(await upgrade(port, { Host: 'localhost:3000', 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
  });

  it('hands a same-origin upgrade to the next handler', async () => {
    const port = await startServer();
    expect(await upgrade(port, { Host: 'app.ai.meybz.asia', Origin: 'https://app.ai.meybz.asia' })).toBe(418);
  });
});
