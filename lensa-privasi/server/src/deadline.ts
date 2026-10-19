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
