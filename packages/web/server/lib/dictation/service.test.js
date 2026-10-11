import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDictationService } from './service.js';

// Поддельный OpenAI-совместимый STT на уровне HTTP: запоминает запросы и
// отвечает заданным статусом, так тест видит то, что реально ушло в сеть.
const startFakeStt = async ({ status = 200, body = { text: 'привет' } } = {}) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
      res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
};

const formField = (body, name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];

const transcribeOnce = async (session) => {
  session.appendPcm16(Buffer.alloc(3200, 1));
  // events.once отклоняет промис на 'error', поэтому слушатели обычные.
  const outcome = new Promise((resolve) => {
    session.once('transcript', (event) => resolve({ transcript: event.transcript }));
    session.once('error', (error) => resolve({ error }));
  });
  session.commit();
  return outcome;
};

describe('dictation service with managed STT', () => {
  let modelsDir;
  let fake;
  let service;

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'dictation-models-'));
  });

  afterEach(async () => {
    service?.shutdown();
    await fake?.close();
    await rm(modelsDir, { recursive: true, force: true });
  });

  it('sends every dictation to the managed endpoint and ignores the client provider config', async () => {
    fake = await startFakeStt();
    service = createDictationService({
      modelsDir,
      managedStt: { baseUrl: fake.baseUrl, model: 'parakeet-tdt-0.6b-v3', apiKey: 'managed-key' },
    });

    const result = await service.createSttSession({
      provider: 'local',
      localModel: 'parakeet-tdt-0.6b-v2-int8',
      language: 'ru',
      openaiCompatible: { baseUrl: 'http://localhost:1/v1', model: 'user-model', apiKey: 'user-key' },
    });

    expect(result.error).toBeUndefined();
    expect(await transcribeOnce(result.session)).toEqual({ transcript: 'привет' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url).toBe('/v1/audio/transcriptions');
    expect(fake.requests[0].authorization).toBe('Bearer managed-key');
    expect(formField(fake.requests[0].body, 'model')).toBe('parakeet-tdt-0.6b-v3');
    expect(formField(fake.requests[0].body, 'language')).toBe('ru');
  });

  it('never downloads a local model when the client asks for the local provider', async () => {
    fake = await startFakeStt();
    service = createDictationService({
      modelsDir,
      managedStt: { baseUrl: fake.baseUrl, model: 'parakeet-tdt-0.6b-v3', apiKey: 'managed-key' },
    });

    await service.createSttSession({ provider: 'local' });

    const status = await service.getStatus({ provider: 'local' });
    expect(status.models.some((model) => model.downloading)).toBe(false);
    expect(await readdir(modelsDir)).toEqual([]);
  });

  it('reports the managed provider as available whatever the client asks about', async () => {
    service = createDictationService({
      modelsDir,
      managedStt: { baseUrl: 'http://10.88.0.1:8317/v1', model: 'parakeet-tdt-0.6b-v3', apiKey: 'managed-key' },
    });

    const status = await service.getStatus({ provider: 'local', localModel: 'parakeet-tdt-0.6b-v2-int8' });
    expect(status.provider).toBe('openai-compatible');
    expect(status.available).toBe(true);
  });

  it('accepts a managed endpoint on a non-loopback host', async () => {
    service = createDictationService({
      modelsDir,
      managedStt: { baseUrl: 'http://stt.invalid/v1', model: 'parakeet-tdt-0.6b-v3', apiKey: 'managed-key' },
    });

    const { session } = await service.createSttSession({});
    const outcome = await transcribeOnce(session);
    // Домен .invalid не резолвится, так что запрос всё равно упадёт; важно,
    // что его не отбила проверка хоста до выхода в сеть.
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).not.toMatch(/Remote custom server URLs are disabled/);
  });

  it('surfaces a busy endpoint as a session error', async () => {
    fake = await startFakeStt({ status: 503, body: { error: { message: 'busy' } } });
    service = createDictationService({
      modelsDir,
      managedStt: { baseUrl: fake.baseUrl, model: 'parakeet-tdt-0.6b-v3', apiKey: 'managed-key' },
    });

    const { session } = await service.createSttSession({});
    const outcome = await transcribeOnce(session);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toMatch(/503/);
  });
});

describe('dictation service without managed STT', () => {
  let modelsDir;

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'dictation-models-'));
  });

  afterEach(async () => {
    await rm(modelsDir, { recursive: true, force: true });
  });

  it('keeps reporting the local provider the client asked about', async () => {
    const service = createDictationService({ modelsDir });
    const status = await service.getStatus({ provider: 'local' });
    expect(status.provider).toBe('local');
    expect(status.available).toBe(false);
    service.shutdown();
  });
});
