export class DeadlineError extends Error {
  constructor(public what: string, public ms: number) {
    super(`${what} tidak selesai dalam ${ms / 1000} detik`);
    this.name = 'DeadlineError';
  }
}

export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(what, ms)), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

// Runs `run` (typically: wait for a lock, then work) and starts the deadline only when it calls `armed()` (lock acquired),
// so lock-queue wait is not charged. `run` keeps going after the deadline fires, so a lock it holds is held until the work really settles.
export function afterLock<T>(ms: number, what: string, run: (armed: () => void) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    run(() => { timer = setTimeout(() => reject(new DeadlineError(what, ms)), ms); })
      .then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
