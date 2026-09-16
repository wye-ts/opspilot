import "@testing-library/jest-dom/vitest";

// Node >= 26 ships a native `localStorage`/`sessionStorage` getter on
// `globalThis` that returns `undefined` outside a `--localstorage-file`
// setup. The key already exists (so `'localStorage' in globalThis` is
// `true`), which makes vitest's jsdom-environment injection skip it,
// leaving the global present but unusable — every test that touches
// `window.localStorage`/`window.sessionStorage` then throws
// `TypeError: Cannot read properties of undefined`. Only `typeof` reliably
// detects this; `Object.defineProperty` is required because the native
// getter is not writable via plain assignment.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

for (const key of ["localStorage", "sessionStorage"] as const) {
  if (typeof globalThis[key] === "undefined") {
    Object.defineProperty(globalThis, key, {
      value: new MemoryStorage(),
      writable: true,
      configurable: true,
    });
  }
}
