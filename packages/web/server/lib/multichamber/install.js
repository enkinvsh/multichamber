import { z } from 'zod';

import { createFsRootGuard } from './fs-root-guard.js';
import { createLockdownGuard, createLockdownSettingsFilter, isLockdownEnabled } from './lockdown-guard.js';

const MULTICHAMBER_POLICY_ROUTE = '/api/multichamber/policy';

const rootSchema = z.string().trim().catch('');

/**
 * What the UI needs to know about this MultiChamber container.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ lockdown: boolean, fsRoot: string | null }}
 */
export const readMultichamberPolicy = (env = process.env) => {
  const fsRoot = rootSchema.parse(env.MULTICHAMBER_FS_ROOT);
  return { lockdown: isLockdownEnabled(env), fsRoot: fsRoot.length > 0 ? fsRoot : null };
};

/**
 * Registers the read-only `GET /api/multichamber/policy` route.
 * @param {import('express').Express} app
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
const registerMultichamberPolicyRoute = (app, { env = process.env } = {}) => {
  const policy = readMultichamberPolicy(env);
  app.get(MULTICHAMBER_POLICY_ROUTE, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(policy);
  });
};

/**
 * Installs the MultiChamber guards and the policy route on the OpenChamber app.
 * `stage` `early` runs before every route; `parsed` runs after the body parsers
 * and before the fs routes and the OpenCode proxy.
 * @param {import('express').Express} app
 * @param {'early' | 'parsed'} stage
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export const installMultichamber = (app, stage, { env = process.env } = {}) => {
  const enabled = isLockdownEnabled(env);
  if (stage === 'early') {
    const guard = createLockdownGuard({ enabled });
    if (guard) app.use(guard);
    registerMultichamberPolicyRoute(app, { env });
    return;
  }
  const settingsFilter = createLockdownSettingsFilter({ enabled });
  if (settingsFilter) app.use(settingsFilter);
  const fsGuard = createFsRootGuard({ root: env.MULTICHAMBER_FS_ROOT });
  if (fsGuard) app.use(fsGuard);
};
