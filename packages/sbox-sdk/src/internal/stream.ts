/**
 * Shared push-to-pull bridge for adapters: provider SDKs deliver output via
 * push callbacks or their own async iterables, while the core consumes a single
 * `AsyncIterable<OutputEvent>`. `AsyncQueue` adapts the former to the latter.
 */

export class AsyncQueue<T> {
  #items: T[] = [];
  #wakers: (() => void)[] = [];
  #closed = false;
  #err: unknown = null;

  push(item: T): void {
    this.#items.push(item);
    this.#wake();
  }
  close(): void {
    this.#closed = true;
    this.#wake();
  }
  fail(err: unknown): void {
    this.#err = err;
    this.#closed = true;
    this.#wake();
  }
  #wake(): void {
    const w = this.#wakers;
    this.#wakers = [];
    for (const f of w) {
      f();
    }
  }
  async *iterator(): AsyncGenerator<T> {
    let i = 0;
    for (;;) {
      while (i < this.#items.length) {
        const item = this.#items[i];
        i++;
        yield item as T;
      }
      if (this.#closed) {
        if (this.#err) {
          throw this.#err;
        }
        return;
      }
      await new Promise<void>((r) => this.#wakers.push(r));
    }
  }
}

/** Best-effort exit code from a thrown provider error that carries one. */
export function numExit(e: unknown): number {
  if (e && typeof e === "object" && "exitCode" in e) {
    const code = (e as { exitCode?: unknown }).exitCode;
    if (typeof code === "number" && Number.isFinite(code)) {
      return code;
    }
  }
  return 1;
}
