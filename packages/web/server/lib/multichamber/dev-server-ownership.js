import fsPromises from 'node:fs/promises';

/** Linux reports LISTEN as state 0A in /proc/net/tcp. */
const PROC_STATE_LISTEN = '0A';
const SOCKET_LINK = /^socket:\[(\d+)\]$/;
const NUMERIC = /^\d+$/;
// Guards the parent walk against a corrupt or racing /proc snapshot.
const MAX_ANCESTRY_DEPTH = 64;

/**
 * Listening TCP sockets as `port -> inodes` from /proc/net/tcp(6) text.
 * Columns: sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode.
 * @param {string} table
 * @returns {Map<number, Set<string>>}
 */
export const parseListeningInodes = (table) => {
  const byPort = new Map();
  for (const line of String(table).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[3] !== PROC_STATE_LISTEN) continue;
    const portHex = parts[1].split(':').at(-1) ?? '';
    const port = Number.parseInt(portHex, 16);
    const inode = parts[9];
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !NUMERIC.test(inode) || inode === '0') continue;
    const inodes = byPort.get(port) ?? new Set();
    inodes.add(inode);
    byPort.set(port, inodes);
  }
  return byPort;
};

/**
 * Parent pid from /proc/<pid>/stat. The command name may contain spaces and `)`,
 * so fields are read after the last `)`: ` state ppid ...`.
 * @param {string} stat
 * @returns {number | null}
 */
export const parseParentPid = (stat) => {
  const text = String(stat);
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const ppid = Number.parseInt(text.slice(close + 1).trim().split(/\s+/)[1] ?? '', 10);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
};

/**
 * Whether /proc/<pid>/cmdline (NUL-separated argv) is an `opencode serve` process.
 * @param {string} cmdline
 */
export const isOpenCodeServeCommand = (cmdline) => {
  const joined = String(cmdline).split('\0').filter(Boolean).join(' ');
  return joined.includes('opencode') && ` ${joined} `.includes(' serve ');
};

/**
 * Reads the process table and socket ownership for the given inodes.
 * Unreadable processes (exited, other users) are skipped; an unreadable /proc owns nothing.
 */
const readProcSnapshot = async ({ procRoot, readdir, readlink, readFile }, wantedInodes) => {
  const entries = await readdir(procRoot).then((list) => list, () => []);
  const pids = entries.filter((entry) => NUMERIC.test(entry)).map(Number);
  const parentOf = new Map();
  const ownersOfInode = new Map();

  await Promise.all(pids.map(async (pid) => {
    const stat = await readFile(`${procRoot}/${pid}/stat`, 'utf8').then((text) => text, () => null);
    if (stat === null) return;
    const ppid = parseParentPid(stat);
    if (ppid !== null) parentOf.set(pid, ppid);

    const fds = await readdir(`${procRoot}/${pid}/fd`).then((list) => list, () => []);
    await Promise.all(fds.map(async (fd) => {
      const target = await readlink(`${procRoot}/${pid}/fd/${fd}`).then((link) => link, () => '');
      const inode = SOCKET_LINK.exec(target)?.[1];
      if (inode === undefined || !wantedInodes.has(inode)) return;
      const owners = ownersOfInode.get(inode) ?? new Set();
      owners.add(pid);
      ownersOfInode.set(inode, owners);
    }));
  }));

  return { parentOf, ownersOfInode };
};

/**
 * Lockdown filter for dev-server discovery on Linux: keeps only ports whose owning
 * process is a strict descendant of this server, minus the managed `opencode serve`
 * process itself (its internal listeners). Ports with no resolvable owner are dropped.
 * Returns null when lockdown is off or the platform has no /proc.
 * @param {{
 *   enabled: boolean,
 *   platform: string,
 *   selfPid?: number,
 *   getOpenCodePid?: () => number | null | undefined,
 *   procRoot?: string,
 *   readFile?: (path: string, encoding: 'utf8') => Promise<string>,
 *   readdir?: (path: string) => Promise<string[]>,
 *   readlink?: (path: string) => Promise<string>,
 * }} options
 * @returns {null | (<T extends { port: number }>(servers: T[]) => Promise<T[]>)}
 */
export const createDevServerOwnershipFilter = ({
  enabled,
  platform,
  selfPid = process.pid,
  getOpenCodePid = () => null,
  procRoot = '/proc',
  readFile = fsPromises.readFile,
  readdir = fsPromises.readdir,
  readlink = fsPromises.readlink,
}) => {
  if (!enabled || platform !== 'linux') return null;
  const io = { procRoot, readFile, readdir, readlink };

  return async (servers) => {
    if (servers.length === 0) return servers;
    const tables = await Promise.all(['tcp', 'tcp6'].map(
      (name) => readFile(`${procRoot}/net/${name}`, 'utf8').then((text) => text, () => ''),
    ));
    const inodesByPort = new Map();
    for (const table of tables) {
      for (const [port, inodes] of parseListeningInodes(table)) {
        const merged = inodesByPort.get(port) ?? new Set();
        for (const inode of inodes) merged.add(inode);
        inodesByPort.set(port, merged);
      }
    }
    const wanted = new Set(servers.flatMap((server) => [...(inodesByPort.get(server.port) ?? [])]));
    if (wanted.size === 0) return [];

    const { parentOf, ownersOfInode } = await readProcSnapshot(io, wanted);
    const openCodePid = getOpenCodePid();
    const cmdlines = new Map();
    const isOpenCodeServer = async (pid) => {
      if (Number.isInteger(openCodePid) && pid === openCodePid) return true;
      if (!cmdlines.has(pid)) {
        const cmdline = await readFile(`${procRoot}/${pid}/cmdline`, 'utf8').then((text) => text, () => '');
        cmdlines.set(pid, isOpenCodeServeCommand(cmdline));
      }
      return cmdlines.get(pid) === true;
    };

    // The path from `pid` up to (not including) this server, or null when `pid` is not a strict descendant.
    const pathToSelf = (pid) => {
      const chain = [];
      let current = pid;
      for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
        if (current === selfPid) return chain.length > 0 ? chain : null;
        chain.push(current);
        const parent = parentOf.get(current);
        if (parent === undefined || parent === current || parent <= 0) return null;
        current = parent;
      }
      return null;
    };

    // OpenCode's own listeners: every process from the owner up to this server is `opencode serve`
    // (the managed child, or a launcher wrapper around it). Agent-started dev servers below it are kept.
    const isAllowedOwner = async (pid) => {
      const chain = pathToSelf(pid);
      if (chain === null) return false;
      for (const member of chain) {
        if (!(await isOpenCodeServer(member))) return true;
      }
      return false;
    };

    const kept = [];
    for (const server of servers) {
      const owners = [...(inodesByPort.get(server.port) ?? [])].flatMap((inode) => [...(ownersOfInode.get(inode) ?? [])]);
      for (const owner of owners) {
        if (await isAllowedOwner(owner)) {
          kept.push(server);
          break;
        }
      }
    }
    return kept;
  };
};
