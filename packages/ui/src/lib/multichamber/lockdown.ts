/**
 * MultiChamber lockdown: the hosted container decides providers, keys, quotas,
 * MCP, plugins, tunnels, updates and integrations, and the server refuses those
 * writes (`packages/web/server/lib/multichamber/lockdown-guard.js`). The UI only
 * hides the ways in. The flag comes from `GET /api/multichamber/policy`.
 *
 * A server without that route (plain OpenChamber) answers 404 and is unlocked.
 * A failed request keeps upstream behaviour (unlocked) and the next caller asks
 * again. Until the first answer arrives the web runtime fails closed: locked
 * entry points stay hidden, so nothing (Settings' default page, for one) acts
 * on a guess. `startMultichamberPolicyLoad` runs at bootstrap to keep that
 * window short.
 */
import React from 'react';
import { z } from 'zod';
import { create } from 'zustand';
import { isWebRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';

const policySchema = z.object({
  lockdown: z.boolean(),
  fsRoot: z.string().nullable(),
});

type MultichamberPolicy = z.infer<typeof policySchema>;

const UNMANAGED_POLICY: MultichamberPolicy = { lockdown: false, fsRoot: null };

/** `unknown`: no answer yet; `failed`: last request failed, retried on demand. */
type PolicyStatus = 'unknown' | 'loaded' | 'failed';

type MultichamberPolicyStore = {
  policy: MultichamberPolicy;
  status: PolicyStatus;
};

const useMultichamberPolicyStore = create<MultichamberPolicyStore>(() => ({
  policy: UNMANAGED_POLICY,
  status: 'unknown',
}));

const resolveLockdown = (state: MultichamberPolicyStore): boolean =>
  state.status === 'unknown' ? isWebRuntime() : state.policy.lockdown;

let inFlightLoad: Promise<void> | null = null;

const fetchPolicy = async (): Promise<MultichamberPolicy> => {
  const response = await runtimeFetch('/api/multichamber/policy', { cache: 'no-store' });
  if (response.status === 404) return UNMANAGED_POLICY;
  if (!response.ok) throw new Error(`MultiChamber policy request failed (${response.status})`);
  return policySchema.parse(await response.json());
};

/** Loads the policy once; concurrent callers share one request. */
const loadMultichamberPolicy = (): Promise<void> => {
  if (useMultichamberPolicyStore.getState().status === 'loaded') return Promise.resolve();
  if (inFlightLoad) return inFlightLoad;
  inFlightLoad = fetchPolicy()
    .then((policy) => {
      useMultichamberPolicyStore.setState({ policy, status: 'loaded' });
    })
    .catch((error: Error) => {
      console.warn('[multichamber] policy unavailable, will retry:', error.message);
      useMultichamberPolicyStore.setState({ policy: UNMANAGED_POLICY, status: 'failed' });
    })
    .finally(() => {
      inFlightLoad = null;
    });
  return inFlightLoad;
};

/** Called once at app bootstrap so the policy is known before Settings opens. */
export const startMultichamberPolicyLoad = (): void => {
  void loadMultichamberPolicy();
};

/** Whether the connected server runs in MultiChamber lockdown. */
export const useMultichamberLockdown = (): boolean => {
  const lockdown = useMultichamberPolicyStore(resolveLockdown);
  const loaded = useMultichamberPolicyStore((state) => state.status === 'loaded');
  React.useEffect(() => {
    if (!loaded) void loadMultichamberPolicy();
  }, [loaded]);
  return lockdown;
};

/**
 * Lockdown as the server reported it: false until the policy has loaded. For
 * irreversible cleanup (closing persisted tabs) that must not act on the
 * fail-closed guess an unlocked server would later contradict.
 */
export const useMultichamberLockdownConfirmed = (): boolean =>
  useMultichamberPolicyStore((state) => state.status === 'loaded' && state.policy.lockdown);

/** Test seam: pins a loaded policy so store tests run against a known lockdown. */
export const setMultichamberLockdownForTests = (lockdown: boolean): void => {
  useMultichamberPolicyStore.setState({ policy: { lockdown, fsRoot: null }, status: 'loaded' });
};

/** Non-reactive read for stores and callbacks. */
export const isMultichamberLockdown = (): boolean =>
  resolveLockdown(useMultichamberPolicyStore.getState());
