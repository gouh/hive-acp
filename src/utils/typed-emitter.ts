/**
 * TypedEmitter — strongly-typed EventEmitter wrapper.
 *
 * Usage:
 *   interface MyEvents { data: (payload: string) => void; }
 *   class Foo extends TypedEmitter<MyEvents> {}
 */

import { EventEmitter } from "node:events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class TypedEmitter<E extends Record<string, (...args: any[]) => void>> {
  private emitter = new EventEmitter();

  constructor() {}

  on<K extends keyof E & string>(event: K, listener: E[K]): this {
    this.emitter.on(event, listener as any);
    return this;
  }

  off<K extends keyof E & string>(event: K, listener: E[K]): this {
    this.emitter.off(event, listener as any);
    return this;
  }

  removeListener<K extends keyof E & string>(event: K, listener: E[K]): this {
    this.emitter.removeListener(event, listener as any);
    return this;
  }

  emit<K extends keyof E & string>(event: K, ...args: Parameters<E[K]>): boolean {
    return this.emitter.emit(event, ...args);
  }

  removeAllListeners<K extends keyof E & string>(event?: K): this {
    this.emitter.removeAllListeners(event);
    return this;
  }
}
