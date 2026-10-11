import { createOpenCodeServeCheck, createListenPortOwnerResolver } from './dev-server-ownership.js';
import { createPreviewProxy, readPreviewProxyConfig } from './preview-proxy.js';

/*
 * Точка входа дочернего процесса прокси превью; запускается только через `node`
 * из preview-proxy-process.js. Bun 1.3 node:http игнорирует createConnection и не
 * отдаёт сырой сокет при upgrade (замерено 2026-10-11), а сервер multichamber в
 * слоте работает под Bun, поэтому прокси живёт в отдельном процессе Node.
 *
 * Конфигурация только из env: родитель передаёт урезанное окружение без секретов
 * (MULTICHAMBER_LLM_KEY и прочее сюда не попадают). IPC нет: его поддержка между Bun
 * и Node ненадёжна, а смерть родителя видна по EOF на stdin и смене ppid.
 */

// Раз в 2 с хватает: после смерти родителя порт должен освободиться до перезапуска контейнера.
const PARENT_WATCH_MS = 2_000;
const SHUTDOWN_GRACE_MS = 2_000;

const parsePortList = (value) => String(value ?? '')
  .split(',')
  .map((part) => Number(part.trim()))
  .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);

const parsePid = (value) => {
  const pid = Number(String(value ?? '').trim());
  return Number.isInteger(pid) && pid > 1 ? pid : null;
};

const config = readPreviewProxyConfig(process.env);
if (!config) {
  console.error('[preview-proxy] MULTICHAMBER_PREVIEW_PORT / MULTICHAMBER_PREVIEW_DOMAIN missing or invalid');
  process.exit(2);
}

const initialParentPid = process.ppid;
// Родитель (сервер multichamber) держит :3000 и, возможно, туннель; его порты закрыты всегда,
// даже если env не передан или ppid уже сменился на обёртку.
const parentPids = new Set([initialParentPid, parsePid(process.env.MULTICHAMBER_PREVIEW_PARENT_PID)].filter((pid) => pid !== null && pid > 1));
const deniedPorts = [config.port, ...parsePortList(process.env.MULTICHAMBER_PREVIEW_DENIED_PORTS)];
const isOpenCodeServe = createOpenCodeServeCheck();

const server = createPreviewProxy({
  domain: config.domain,
  logger: console,
  getDeniedPorts: () => deniedPorts,
  resolvePortOwners: createListenPortOwnerResolver({ platform: process.platform }),
  // Любой `opencode serve`, а не только управляемый: без IPC его pid сюда не доходит, а лишний
  // отказ закрывает лишь второй OpenCode агента, служебный порт он открыть не может.
  isEnvironmentOwner: (pid) => parentPids.has(pid) || isOpenCodeServe(pid),
});

let shuttingDown = false;
const shutdown = (reason) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[preview-proxy] shutting down: ${reason}`);
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
};

server.on('error', (error) => {
  console.error(`[preview-proxy] server error: ${error?.code ?? error?.message ?? error}`);
  if (!server.listening) process.exit(1);
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[preview-proxy] listening on 0.0.0.0:${config.port} for *.${config.domain} (node ${process.version}, pid ${process.pid})`);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Родитель держит пишущий конец stdin; EOF значит, что он умер, и порт нельзя оставлять сиротой.
process.stdin.on('end', () => shutdown('parent closed stdin'));
process.stdin.on('error', () => shutdown('parent stdin error'));
process.stdin.resume();

const parentWatch = setInterval(() => {
  if (process.ppid !== initialParentPid) shutdown(`parent ${initialParentPid} is gone`);
}, PARENT_WATCH_MS);
parentWatch.unref();
