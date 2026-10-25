/** Small LRU cache plus in-flight de-duplication so identical requests hit the provider once. */
export class RequestCache<T> {
  private readonly values = new Map<string, T>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly max = 500) {}

  get(key: string): T | undefined {
    const v = this.values.get(key);
    if (v !== undefined) {
      this.values.delete(key);
      this.values.set(key, v);
    }
    return v;
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > this.max) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }

  /** Runs `producer` once per key at a time; concurrent callers share the same promise. */
  async dedupe(key: string, producer: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = producer().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
