/**
 * MultiChamber lockdown: the hosted container decides providers, keys, quotas,
 * MCP, plugins, tunnels, updates and integrations, and the server refuses those
 * writes (`packages/web/server/lib/multichamber/lockdown-guard.js`). The UI only
 * hides the ways in. The flag comes from `GET /api/multichamber/policy`.
 *
 * A server without that route (plain OpenChamber) answers 404 and is unlocked.
 * A failed request is not an answer: the store stays unloaded and the next
 * caller asks again.
 */
import React from 'react';
import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';

const policySchema = z.object({
  lockdown: z.boolean(),
  fsRoot: z.string().nullable(),
});

type MultichamberPolicy = z.infer<typeof policySchema>;

const UNMANAGED_POLICY: MultichamberPolicy = { lockdown: false, fsRoot: null };

type MultichamberPolicyStore = {
  policy: MultichamberPolicy;
  loaded: boolean;
};

const useMultichamberPolicyStore = create<MultichamberPolicyStore>(() => ({
  policy: UNMANAGED_POLICY,
  loaded: false,
}));

let inFlightLoad: Promise<void> | null = null;

const fetchPolicy = async (): Promise<MultichamberPolicy> => {
  const response = await runtimeFetch('/api/multichamber/policy', { cache: 'no-store' });
  if (response.status === 404) return UNMANAGED_POLICY;
  if (!response.ok) throw new Error(`MultiChamber policy request failed (${response.status})`);
  return policySchema.parse(await response.json());
};

/** Loads the policy once; concurrent callers share one request. */
const loadMultichamberPolicy = (): Promise<void> => {
  if (useMultichamberPolicyStore.getState().loaded) return Promise.resolve();
  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = fetchPolicy()
    .then((policy) => {
      useMultichamberPolicyStore.setState({ policy, loaded: true });
    })
    .catch((error: Error) => {
      console.warn('[multichamber] policy unavailable, will retry:', error.message);
    })
    .finally(() => {
      inFlightLoad = null;
    });
  return inFlightLoad;
};

/** Whether the connected server runs in MultiChamber lockdown. */
export const useMultichamberLockdown = (): boolean => {
  const lockdown = useMultichamberPolicyStore((state) => state.policy.lockdown);
  const loaded = useMultichamberPolicyStore((state) => state.loaded);
  React.useEffect(() => {
    if (!loaded) void loadMultichamberPolicy();
  }, [loaded]);
  return lockdown;
};

/** Non-reactive read for stores and callbacks. */
export const isMultichamberLockdown = (): boolean =>
  useMultichamberPolicyStore.getState().policy.lockdown;
