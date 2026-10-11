import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { readPreviewProxyConfig } from './preview-proxy.js';

/*
 * Запуск и надзор за прокси превью из процесса сервера. Сервер в слоте zeny работает
 * под Bun, а Bun 1.3 node:http игнорирует createConnection и не отдаёт сырой сокет
 * при upgrade (замерено 2026-10-11: GET 502 ECONNREFUSED, WebSocket без ответа),
 * поэтому сам прокси исполняется дочерним процессом `node` (в образе Debian nodejs 20).
 */

const ENTRY = fileURLToPath(new URL('./preview-proxy-main.js', import.meta.url));
const READY_LINE = /listening on 0\.0\.0\.0:\d+/;
const READY_TIMEOUT_MS = 10_000;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
// Процесс, проживший минуту, падал не в цикле: следующий перезапуск снова через 1 с.
const HEALTHY_RUN_MS = 60_000;
const STOP_GRACE_MS = 5_000;
// Остальное окружение сервера (MULTICHAMBER_LLM_KEY и прочие секреты) ребёнку не нужно.
const INHERITED_ENV = ['PATH', 'HOME', 'NODE_ENV', 'LANG'];

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

const isExecutableFile = (candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
};

/**
 * Путь к `node`: MULTICHAMBER_PREVIEW_NODE (путь или имя) либо поиск `node` по PATH.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export const resolveNodeBinary = (env) => {
  const requested = String(env.MULTICHAMBER_PREVIEW_NODE ?? '').trim() || 'node';
  if (requested.includes('/')) return isExecutableFile(requested) ? path.resolve(requested) : null;
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, requested);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
};

const buildChildEnv = (env, config, deniedPorts) => {
  const childEnv = {};
  for (const name of INHERITED_ENV) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  childEnv.MULTICHAMBER_PREVIEW_PORT = String(config.port);
  childEnv.MULTICHAMBER_PREVIEW_DOMAIN = config.domain;
  childEnv.MULTICHAMBER_PREVIEW_DENIED_PORTS = deniedPorts.join(',');
  childEnv.MULTICHAMBER_PREVIEW_PARENT_PID = String(process.pid);
  return childEnv;
};

const withPrefix = (line) => (line.startsWith('[preview-proxy]') ? line : `[preview-proxy] ${line}`);

/**
 * Поднимает дочерний Node-процесс прокси превью, если заданы MULTICHAMBER_PREVIEW_PORT и
 * MULTICHAMBER_PREVIEW_DOMAIN. Запрещённые порты считаются при каждом (пере)запуске ребёнка:
 * изменение порта туннеля в работе до него не дойдёт до перезапуска, но порты самого сервера
 * закрыты ещё и правилом владельца (pid родителя), а в lockdown туннелей нет.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   logger?: { info?: (...args: unknown[]) => void, warn: (...args: unknown[]) => void },
 *   getDeniedPorts?: () => Array<number | null | undefined>,
 * }} options
 * @returns {Promise<{ port: number, getPid: () => number | null, stop: () => Promise<void> } | null>}
 */
export const startPreviewProxy = async ({ env = process.env, logger = console, getDeniedPorts = () => [] }) => {
  const config = readPreviewProxyConfig(env);
  if (!config) return null;
  const nodeBinary = resolveNodeBinary(env);
  if (!nodeBinary) {
    logger.warn('[preview-proxy] node binary not found (PATH or MULTICHAMBER_PREVIEW_NODE); preview disabled');
    return null;
  }

  /** @type {{ proc: import('node:child_process').ChildProcess, exited: Promise<void> } | null} */
  let current = null;
  let stopping = false;
  let restartTimer = null;
  let restartDelay = RESTART_MIN_MS;
  let markFirstReady = () => {};
  const firstReady = new Promise((resolve) => { markFirstReady = resolve; });

  const forwardLines = (stream, write) => {
    readline.createInterface({ input: stream }).on('line', (line) => {
      if (READY_LINE.test(line)) markFirstReady(true);
      write(withPrefix(line));
    });
  };

  const launch = () => {
    restartTimer = null;
    const deniedPorts = [config.port, ...getDeniedPorts()].map(Number).filter((port) => Number.isInteger(port) && port > 0);
    const startedAt = Date.now();
    const proc = spawn(nodeBinary, [ENTRY], {
      env: buildChildEnv(env, config, deniedPorts),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finish = () => {};
    const exited = new Promise((resolve) => { finish = resolve; });
    current = { proc, exited };

    forwardLines(proc.stdout, (line) => (logger.info ?? logger.warn)(line));
    forwardLines(proc.stderr, (line) => logger.warn(line));
    // stdin только держит канал «родитель жив»; EPIPE после смерти ребёнка ожидаем.
    proc.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') logger.warn(`[preview-proxy] child stdin error: ${error?.message ?? error}`);
    });

    let gone = false;
    const onGone = (reason) => {
      if (gone) return;
      gone = true;
      finish();
      markFirstReady(false);
      if (current?.proc === proc) current = null;
      if (stopping) return;
      if (Date.now() - startedAt >= HEALTHY_RUN_MS) restartDelay = RESTART_MIN_MS;
      const wait = restartDelay;
      restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
      logger.warn(`[preview-proxy] child ${reason}; restarting in ${wait / 1000}s`);
      restartTimer = setTimeout(launch, wait);
      restartTimer.unref?.();
    };
    proc.once('exit', (code, signal) => onGone(`exited (code ${code}, signal ${signal})`));
    proc.once('error', (error) => onGone(`failed: ${error?.message ?? error}`));
  };

  // Синхронный выстрел на выходе сервера мимо stop(): ребёнок и так уйдёт по EOF stdin, это быстрее.
  const killOnExit = () => current?.proc.kill('SIGTERM');
  process.once('exit', killOnExit);

  launch();
  const ready = await Promise.race([firstReady, delay(READY_TIMEOUT_MS).then(() => false)]);
  if (!ready) logger.warn('[preview-proxy] child is not listening yet; it keeps restarting in the background');

  return {
    port: config.port,
    getPid: () => current?.proc.pid ?? null,
    stop: async () => {
      stopping = true;
      process.removeListener('exit', killOnExit);
      if (restartTimer) clearTimeout(restartTimer);
      const running = current;
      if (!running) return;
      running.proc.kill('SIGTERM');
      const exitedInTime = await Promise.race([running.exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)]);
      if (exitedInTime) return;
      logger.warn('[preview-proxy] child ignored SIGTERM; sending SIGKILL');
      running.proc.kill('SIGKILL');
      await running.exited;
    },
  };
};
