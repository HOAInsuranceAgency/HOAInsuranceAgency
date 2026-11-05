/** Metadata-only invalidation. Records are always re-read through normal authorization. */
export type LiveTopic = 'CRM' | 'OWNER' | 'PERSONAL';
export interface LiveSnapshot { session: number; epoch: number; writeEpoch: number; blocked: boolean; active: boolean; scope: string; edits: number; writes: number }
export interface LiveRefreshOptions {
  enabled?: boolean; paused?: boolean; topics?: readonly LiveTopic[]; intervalMs?: number;
  /** Status companions may update during editing, but never during a write. */
  protectEdits?: boolean; onDenied?: (error: unknown) => void;
}
type Reader = { callback: () => void | boolean | Promise<void | boolean>; options: () => LiveRefreshOptions; pending: boolean; running: boolean; last: number; next: number };
const FALLBACK_MS = 60_000;
class LiveUpdateCoordinator {
  private state: LiveSnapshot = { session: 0, epoch: 0, writeEpoch: 0, blocked: false, active: false, scope: '', edits: 0, writes: 0 };
  private listeners = new Set<() => void>();
  private readers = new Set<Reader>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private channel?: BroadcastChannel;
  private cleanup?: () => void;
  private serial = 0;
  private generation = 0;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private change(patch: Partial<LiveSnapshot>) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  touchEdit = () => this.change({ epoch: this.state.epoch + 1 });
  acquireBlock = (kind: 'edit' | 'write' = 'edit') => {
    const key = kind === 'edit' ? 'edits' : 'writes';
    this.change({ [key]: this.state[key] + 1, blocked: true, epoch: this.state.epoch + 1,
      writeEpoch: this.state.writeEpoch + (kind === 'write' ? 1 : 0) });
    let released = false;
    return () => { if (released) return; released = true;
      const count = Math.max(0, this.state[key] - 1);
      this.change({ [key]: count, blocked: count > 0 || this.state[kind === 'edit' ? 'writes' : 'edits'] > 0 });
      this.wake();
    };
  };
  canPublish = (fence: LiveSnapshot, protectEdits = true) =>
    fence.session === this.state.session && fence.scope === this.state.scope && (protectEdits ? fence.epoch === this.state.epoch : fence.writeEpoch === this.state.writeEpoch)
    && this.state.writes === 0 && (!protectEdits || this.state.edits === 0);
  private available() { return this.state.active && (typeof document === 'undefined' || document.visibilityState !== 'hidden') && (typeof navigator === 'undefined' || navigator.onLine !== false); }
  private runnable(reader: Reader) { const o = reader.options(); return o.enabled !== false && !o.paused && !this.state.writes && (o.protectEdits === false || !this.state.edits); }
  register = (callback: Reader['callback'], options: Reader['options']) => {
    const now = Date.now(); const reader: Reader = { callback, options, pending: false, running: false, last: -Infinity, next: now + (options().intervalMs ?? FALLBACK_MS) };
    this.readers.add(reader); this.wake();
    return () => { this.readers.delete(reader); this.wake(); };
  };
  deny = (error: unknown) => { for (const r of this.readers) r.options().onDenied?.(error); };
  private queue(topics?: readonly LiveTopic[]) {
    for (const r of this.readers) {
      const watched = r.options().topics;
      if (!topics || !watched || topics.some(t => watched.includes(t))) r.pending = true;
    }
    this.wake(100);
  }
  invalidate = (topics?: readonly LiveTopic[]) => {
    this.queue(topics);
    if (!this.state.active) return;
    const message = { scope: this.state.scope, topics, nonce: `${Date.now()}:${++this.serial}` };
    try { if (this.channel) this.channel.postMessage(message);
      else if (typeof localStorage !== 'undefined') { localStorage.setItem('crm-live-invalidation', JSON.stringify(message)); localStorage.removeItem('crm-live-invalidation'); }
    } catch { /* Storage restrictions do not affect writes or same-tab updates. */ }
  };
  wake = (minimumDelay = 0) => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.available()) return;
    const now = Date.now(); let due = Infinity;
    for (const r of this.readers) if (!r.running && this.runnable(r)) {
      due = Math.min(due, r.pending ? Math.max(now + minimumDelay, r.last + 1000) : r.next);
    }
    if (Number.isFinite(due)) this.timer = setTimeout(() => this.flush(), Math.max(0, due - now));
  };
  private flush() {
    this.timer = undefined;
    if (!this.available()) return;
    const now = Date.now();
    for (const r of this.readers) if (!r.running && this.runnable(r) && now >= Math.max(r.last + 1000, r.pending ? 0 : r.next)) {
      r.running = true; r.pending = false; r.last = now;
      r.next = now + Math.max(1000, r.options().intervalMs ?? FALLBACK_MS);
      Promise.resolve().then(() => r.callback()).then(applied => { if (applied === false) r.pending = true; }, () => { /* Reader owns error presentation; retry on fallback. */ }).finally(() => { r.running = false; this.wake(); });
    }
    this.wake();
  }
  start = (scope: string) => {
    this.cleanup?.();
    const generation = ++this.generation;
    this.change({ active: true, scope, session: this.state.session + 1, epoch: this.state.epoch + 1, writeEpoch: this.state.writeEpoch + 1 });
    const resume = () => { if (this.available()) this.queue(); else this.wake(); };
    const receive = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const data = message as { scope?: string; topics?: unknown };
      if (data.scope !== scope) return;
      const topics = Array.isArray(data.topics) && data.topics.every(t => ['CRM','OWNER','PERSONAL'].includes(t)) ? data.topics as LiveTopic[] : undefined;
      this.queue(topics);
    };
    const storage = (e: StorageEvent) => { if (e.key !== 'crm-live-invalidation' || !e.newValue) return; try { receive(JSON.parse(e.newValue)); } catch { /* Ignore unrelated malformed storage. */ } };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume);
      window.addEventListener('storage', storage); document.addEventListener('visibilitychange', resume);
      try { if (typeof BroadcastChannel !== 'undefined') { this.channel = new BroadcastChannel(`crm-live:${scope}`); this.channel.onmessage = e => receive(e.data); } } catch { /* Storage + bounded polling remain available. */ }
    }
    const cleanup = () => {
      if (this.timer) clearTimeout(this.timer); this.timer = undefined;
      this.channel?.close(); this.channel = undefined;
      if (typeof window !== 'undefined') { window.removeEventListener('focus', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', resume); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', resume); }
      this.change({ active: false, scope: '', session: this.state.session + 1, epoch: this.state.epoch + 1, writeEpoch: this.state.writeEpoch + 1 });
    };
    this.cleanup = cleanup; this.wake();
    return () => { if (generation !== this.generation) return; cleanup(); this.cleanup = undefined; };
  };
}
export const liveUpdates = new LiveUpdateCoordinator();
