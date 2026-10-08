import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Keys of a JSON body under /api/fs/ that name a filesystem path (fs/routes.js:
// mkdir/write/delete/reveal `path`, rename `oldPath`/`newPath`, exec `cwd`, clone `destinationPath`).
const FS_BODY_KEYS = ['path', 'oldPath', 'newPath', 'cwd', 'destinationPath', 'targetPath', 'directory'];
// PUT /api/projects/:projectId/config stores `projectPath` (projects/project-setup.js).
const PROJECTS_BODY_KEYS = ['projectPath'];
// POST /api/opencode/directory switches OpenCode to `path` (opencode/routes.js).
const DIRECTORY_ROUTE = '/api/opencode/directory';

// Non-strings and blank strings become '' and name no path.
const pathTextSchema = z.string().trim().catch('');

const OUTSIDE_MESSAGE = 'Path is outside the allowed folder.';

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// The OpenCode proxy (opencode/proxy.js) decodes the header when x-opencode-directory-encoding is `uri`.
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

const isAbsoluteLike = (value) => value.trimStart().startsWith('/') || value.trimStart().startsWith('~');

/**
 * Every directory a request names, as OpenCode 1.x reads them: `?directory=`
 * (legacy routes), `?location[directory]=` (v2 `/api/*` routes) and the
 * `x-opencode-directory` header.
 */
const requestedDirectories = (req, searchParams) => {
  const directories = [];
  for (const key of ['directory', 'location[directory]']) {
    for (const value of searchParams.getAll(key)) directories.push(value);
  }
  const header = req.headers['x-opencode-directory'];
  if (header !== undefined && header.length > 0) {
    const encoded = req.headers['x-opencode-directory-encoding'] === 'uri' || PERCENT_ESCAPE.test(header);
    directories.push(encoded ? safeDecode(header) : header);
  }
  return directories;
};

const bodyValues = (req, keys) => (isPlainObject(req.body) ? keys.map((key) => req.body[key]) : []);

/** Every value of the request that names a filesystem path. */
const candidatePaths = (req, pathname, searchParams) => {
  const lower = pathname.toLowerCase();
  const queryPaths = searchParams.getAll('path');
  if (lower.startsWith('/api/fs/')) {
    return [...requestedDirectories(req, searchParams), ...queryPaths, ...bodyValues(req, FS_BODY_KEYS)];
  }
  const candidates = [...requestedDirectories(req, searchParams), ...queryPaths.filter(isAbsoluteLike)];
  if (lower.startsWith('/api/projects')) candidates.push(...bodyValues(req, PROJECTS_BODY_KEYS));
  if (lower === DIRECTORY_ROUTE) candidates.push(...bodyValues(req, ['path']));
  return candidates;
};

/**
 * Refuses any API request naming a path outside `root`. Returns null when `root` is blank (feature off).
 * A UX boundary, not a security boundary: see DOCUMENTATION.md.
 * @param {{ root?: string, homedir?: string }} options
 */
export const createFsRootGuard = ({ root, homedir = os.homedir() } = {}) => {
  const rootText = pathTextSchema.parse(root);
  if (rootText.length === 0) return null;
  const allowedRoot = path.resolve(rootText);
  // `/` already ends with the separator.
  const insidePrefix = allowedRoot.endsWith(path.sep) ? allowedRoot : allowedRoot + path.sep;

  const isInside = (value) => {
    const trimmed = pathTextSchema.parse(value);
    if (trimmed.length === 0) return true;
    const expanded = trimmed === '~' || trimmed.startsWith('~/') ? homedir + trimmed.slice(1) : trimmed;
    const resolved = path.resolve(expanded);
    return resolved === allowedRoot || resolved.startsWith(insidePrefix);
  };

  return (req, res, next) => {
    const url = new URL(req.originalUrl, 'http://localhost');
    if (!url.pathname.toLowerCase().startsWith('/api/')) {
      next();
      return;
    }
    if (candidatePaths(req, url.pathname, url.searchParams).every(isInside)) {
      next();
      return;
    }
    res.status(403).json({ error: OUTSIDE_MESSAGE, code: 'outside_fs_root' });
  };
};
