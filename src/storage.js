// A drop-in replacement for the Claude-artifact "window.storage" API this app was
// originally prototyped against, backed by the browser's real localStorage.
//
// This is intentionally a stopgap, not a real backend: everything here is local to
// one browser on one device. There's no sync between a parent's phone and a
// grandparent's tablet, nothing survives a cleared browser cache, and nothing is
// backed up. The whole point of keeping the SAME method names and shapes
// (get/set/delete/list, returning { key, value }) is that swapping this file out for
// a real API client later — once there's an actual backend — shouldn't require
// touching any of the application code that calls window.storage.

function keyFor(key) {
  return `tandem:${key}`;
}

const storage = {
  async get(key) {
    const raw = localStorage.getItem(keyFor(key));
    if (raw === null) throw new Error(`key not found: ${key}`);
    return { key, value: raw };
  },

  async set(key, value) {
    localStorage.setItem(keyFor(key), value);
    return { key, value };
  },

  async delete(key) {
    localStorage.removeItem(keyFor(key));
    return { key, deleted: true };
  },

  async list(prefix) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const raw = localStorage.key(i);
      if (raw && raw.startsWith("tandem:")) {
        const bare = raw.slice("tandem:".length);
        if (!prefix || bare.startsWith(prefix)) keys.push(bare);
      }
    }
    return { keys };
  },
};

export function installStorage() {
  if (typeof window !== "undefined") {
    window.storage = storage;
  }
}
