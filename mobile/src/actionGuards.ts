import { getAuthGeneration, loadSession, type StoredSession } from "./storage";

export interface AuthGuardRef {
  current: number;
}

/**
 * Runs an async screen action while locking UI busy state via a monotonic
 * per-component request counter so stale actions never mutate state after an
 * auth switch and never leave busy buttons stuck disabled.
 */
export async function runGuardedBusyAction<T>(
  seqRef: AuthGuardRef,
  setBusy: (busy: boolean) => void,
  task: (isStale: () => boolean, startGen: number) => Promise<T>,
  getGen: () => number = getAuthGeneration,
): Promise<{ aborted: boolean; result?: T }> {
  const startGen = getGen();
  const seq = (seqRef.current += 1);
  setBusy(true);
  const isStale = () => getGen() !== startGen;
  try {
    const result = await task(isStale, startGen);
    if (isStale()) return { aborted: true };
    return { aborted: false, result };
  } catch (err) {
    if (isStale()) return { aborted: true };
    throw err;
  } finally {
    if (seqRef.current === seq) {
      setBusy(false);
    }
  }
}

/**
 * Verifies after local session cleanup that no new session signed in during the
 * async storage read before navigating back to `/login`.
 */
export async function isPostClearSafeToNavigate(
  getGen: () => number = getAuthGeneration,
  readSession: () => Promise<StoredSession | null> = loadSession,
): Promise<boolean> {
  const postClearGen = getGen();
  const latestSess = await readSession();
  return getGen() === postClearGen && !latestSess?.access_token;
}

export async function shouldNavigateAfterLogout(
  logoutFn: () => Promise<unknown>,
  getGen: () => number = getAuthGeneration,
  readSession: () => Promise<StoredSession | null> = loadSession,
): Promise<boolean> {
  await logoutFn();
  return isPostClearSafeToNavigate(getGen, readSession);
}
