import { describe, expect, it } from 'vitest';

import {
  createDevServerOwnershipFilter,
  isOpenCodeServeCommand,
  parseListeningInodes,
  parseParentPid,
} from './dev-server-ownership.js';

const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const listenLine = (port, inode, address = '00000000') =>
  `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
const establishedLine = (port, inode) =>
  `   1: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1`;

const SELF = 100;
const OPENCODE = 200;

/**
 * Fixture process tree:
 * 1 tini -> 10 sh -> 20 python memory server (:47765)
 *                -> 100 bun (OpenChamber, self, :3000)
 *                     -> 200 opencode serve (:4096, :41001, :41002)
 *                          -> 210 bash -> 220 node vite (:5173)
 *                     -> 300 bash pty -> 310 node next dev (:3001)
 */
const PROCESSES = {
  1: { comm: 'tini', ppid: 0, cmdline: 'tini\0--\0sh', sockets: [] },
  10: { comm: 'sh', ppid: 1, cmdline: 'sh\0/opt/zeny/entrypoint.sh', sockets: [] },
  20: { comm: 'python3', ppid: 10, cmdline: 'python3\0memory_server.py', sockets: ['9001'] },
  [SELF]: { comm: 'bun', ppid: 10, cmdline: 'bun\0packages/web/bin/cli.js\0serve', sockets: ['9002'] },
  [OPENCODE]: { comm: 'opencode', ppid: SELF, cmdline: '/usr/bin/opencode\0serve\0--port\x004096', sockets: ['9003', '9004', '9005'] },
  210: { comm: 'bash', ppid: OPENCODE, cmdline: 'bash\0-c\0npm run dev', sockets: [] },
  220: { comm: 'node (vite) x', ppid: 210, cmdline: 'node\0node_modules/.bin/vite', sockets: ['9006'] },
  300: { comm: 'bash', ppid: SELF, cmdline: '-bash', sockets: [] },
  310: { comm: 'next-server (v1)', ppid: 300, cmdline: 'next-server\0dev', sockets: ['9007'] },
};

const TCP = [
  TCP_HEADER,
  listenLine(47765, '9001'),
  listenLine(3000, '9002'),
  listenLine(4096, '9003', '0100007F'),
  listenLine(41001, '9004', '0100007F'),
  listenLine(41002, '9005', '0100007F'),
  listenLine(5173, '9006'),
  establishedLine(5174, '9999'),
].join('\n');
const TCP6 = [TCP_HEADER, listenLine(3001, '9007', '00000000000000000000000000000000'), listenLine(6006, '9008')].join('\n');

const createFakeProc = (processes = PROCESSES, { tcp = TCP, tcp6 = TCP6 } = {}) => {
  const files = new Map([['/proc/net/tcp', tcp], ['/proc/net/tcp6', tcp6]]);
  const dirs = new Map([['/proc', ['self', 'net', ...Object.keys(processes)]]]);
  const links = new Map();
  for (const [pid, info] of Object.entries(processes)) {
    files.set(`/proc/${pid}/stat`, `${pid} (${info.comm}) S ${info.ppid} ${pid} ${pid} 0 -1 4194304`);
    files.set(`/proc/${pid}/cmdline`, `${info.cmdline}\0`);
    const fds = ['0', '1', '2', ...info.sockets.map((_, index) => String(10 + index))];
    dirs.set(`/proc/${pid}/fd`, fds);
    links.set(`/proc/${pid}/fd/0`, '/dev/null');
    links.set(`/proc/${pid}/fd/1`, 'pipe:[123]');
    links.set(`/proc/${pid}/fd/2`, 'anon_inode:[eventpoll]');
    info.sockets.forEach((inode, index) => links.set(`/proc/${pid}/fd/${10 + index}`, `socket:[${inode}]`));
  }
  const missing = (target) => Promise.reject(Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' }));
  return {
    readFile: (target) => (files.has(target) ? Promise.resolve(files.get(target)) : missing(target)),
    readdir: (target) => (dirs.has(target) ? Promise.resolve(dirs.get(target)) : missing(target)),
    readlink: (target) => (links.has(target) ? Promise.resolve(links.get(target)) : missing(target)),
  };
};

const ALL_PORTS = [3000, 3001, 4096, 5173, 6006, 41001, 41002, 47765].map((port) => ({ port, url: `http://localhost:${port}/` }));

const createFilter = (overrides = {}) => createDevServerOwnershipFilter({
  enabled: true,
  platform: 'linux',
  selfPid: SELF,
  getOpenCodePid: () => OPENCODE,
  ...createFakeProc(),
  ...overrides,
});

const ports = (servers) => servers.map((server) => server.port);

describe('parseListeningInodes', () => {
  it('maps listening ports to socket inodes and skips non-listening rows and the header', () => {
    const byPort = parseListeningInodes(TCP);
    expect(byPort.get(47765)).toEqual(new Set(['9001']));
    expect(byPort.get(41002)).toEqual(new Set(['9005']));
    expect(byPort.has(5174)).toBe(false);
  });
});

describe('parseParentPid', () => {
  it('reads the ppid after the last parenthesis so command names with spaces and ) do not shift fields', () => {
    expect(parseParentPid('310 (next-server (v1)) S 300 310 310 0')).toBe(300);
    expect(parseParentPid('220 (node (vite) x) R 210 1 1')).toBe(210);
  });

  it('returns null for malformed stat text', () => {
    expect(parseParentPid('garbage')).toBeNull();
    expect(parseParentPid('1 (x) S')).toBeNull();
  });
});

describe('isOpenCodeServeCommand', () => {
  it('recognises opencode serve and nothing else', () => {
    expect(isOpenCodeServeCommand('/usr/bin/opencode\0serve\0--port\x000\0')).toBe(true);
    expect(isOpenCodeServeCommand('node\0/home/dev/.bun/bin/opencode\0serve\0')).toBe(true);
    expect(isOpenCodeServeCommand('bun\0packages/web/bin/cli.js\0serve\0')).toBe(false);
    expect(isOpenCodeServeCommand('opencode\0run\0')).toBe(false);
    expect(isOpenCodeServeCommand('node\0opencode-serve-helper.js\0')).toBe(false);
  });
});

describe('createDevServerOwnershipFilter', () => {
  it('is off when lockdown is off or outside Linux', () => {
    expect(createDevServerOwnershipFilter({ enabled: false, platform: 'linux' })).toBeNull();
    expect(createDevServerOwnershipFilter({ enabled: true, platform: 'darwin' })).toBeNull();
  });

  it('keeps descendants of this server and drops the harness, OpenCode itself and ownerless ports', async () => {
    const filter = createFilter();
    // 3000 is self (not a strict descendant), 4096/41001/41002 belong to opencode serve,
    // 47765 is the memory server outside the tree, 6006 has no owning process.
    expect(ports(await filter(ALL_PORTS))).toEqual([3001, 5173]);
  });

  it('keeps the original server objects', async () => {
    const filter = createFilter();
    const [first] = await filter([{ port: 5173, url: 'http://localhost:5173/', command: 'vite' }]);
    expect(first).toEqual({ port: 5173, url: 'http://localhost:5173/', command: 'vite' });
  });

  it('falls back to the opencode serve command line when the managed pid is unknown', async () => {
    const filter = createFilter({ getOpenCodePid: () => null });
    expect(ports(await filter(ALL_PORTS))).toEqual([3001, 5173]);
  });

  it('treats a launcher wrapper around opencode serve as OpenCode too', async () => {
    const processes = {
      ...PROCESSES,
      [OPENCODE]: { ...PROCESSES[OPENCODE], comm: 'node', cmdline: 'node\0/usr/lib/node_modules/opencode-ai/bin/opencode\0serve', sockets: [] },
      250: { comm: 'opencode', ppid: OPENCODE, cmdline: '/usr/lib/opencode-linux-x64/bin/opencode\0serve', sockets: ['9003', '9004', '9005'] },
    };
    const filter = createFilter(createFakeProc(processes));
    expect(ports(await filter(ALL_PORTS))).toEqual([3001, 5173]);
  });

  it('drops every port when the process table cannot be read', async () => {
    const fake = createFakeProc();
    const filter = createFilter({ ...fake, readdir: () => Promise.reject(new Error('EACCES')) });
    expect(await filter(ALL_PORTS)).toEqual([]);
    const unreadableFds = createFilter({
      ...fake,
      readdir: (target) => (target === '/proc' ? fake.readdir(target) : Promise.reject(new Error('EACCES'))),
    });
    expect(await unreadableFds(ALL_PORTS)).toEqual([]);
  });

  it('drops ports missing from the socket tables', async () => {
    const filter = createFilter(createFakeProc(PROCESSES, { tcp: TCP_HEADER, tcp6: '' }));
    expect(await filter(ALL_PORTS)).toEqual([]);
  });

  it('survives a parent cycle in a racing snapshot', async () => {
    const processes = {
      ...PROCESSES,
      400: { comm: 'a', ppid: 401, cmdline: 'a', sockets: ['9010'] },
      401: { comm: 'b', ppid: 400, cmdline: 'b', sockets: [] },
    };
    const tcp = `${TCP}\n${listenLine(7000, '9010')}`;
    const filter = createFilter(createFakeProc(processes, { tcp }));
    expect(ports(await filter([{ port: 7000 }, { port: 5173 }]))).toEqual([5173]);
  });
});
