import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

const UPDATE_MESSAGE = 0;
const AWARENESS_MESSAGE = 1;

type ProviderEvent = "synced" | "status" | "snapshot" | "error";
type Listener = (value?: unknown) => void;

interface PendingUpdate { id: string; update: string }

const SAVE_TIMEOUT_MS = 15_000;

export class DraftProvider {
  readonly awareness: awarenessProtocol.Awareness;
  private socket: WebSocket | null = null;
  private listeners = new Map<ProviderEvent, Set<Listener>>();
  private reconnectTimer: number | null = null;
  private destroyed = false;
  private synced = false;
  private ready = false;
  private pending: PendingUpdate[];
  private readonly pendingKey: string;
  private saveWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timeout: number }>();

  constructor(
    readonly document: Y.Doc,
    private readonly documentId: string,
    private readonly token: string,
    participantId: string,
  ) {
    this.awareness = new awarenessProtocol.Awareness(document);
    this.pendingKey = `draft:pending:${documentId}:${participantId}`;
    this.pending = this.loadPending();
    restorePendingUpdates(document, this.pending, this);
    document.on("update", this.handleDocumentUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
    this.connect();
  }

  on(event: ProviderEvent, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: ProviderEvent, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  setUser(user: { name: string; color: string }): void {
    this.awareness.setLocalStateField("user", user);
  }

  whenSaved(): Promise<void> {
    if (this.ready && this.pending.length === 0) return Promise.resolve();
    if (this.destroyed) return Promise.reject(new Error("The document connection is closed"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: window.setTimeout(() => {
          this.saveWaiters.delete(waiter);
          reject(new Error("Your latest edits are still reconnecting. Try again when the document is saved."));
        }, SAVE_TIMEOUT_MS),
      };
      this.saveWaiters.add(waiter);
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.awareness.setLocalState(null);
    this.socket?.close(1000, "Page closed");
    this.document.off("update", this.handleDocumentUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.awareness.destroy();
    this.rejectSaveWaiters("The document connection is closed");
  }

  private connect(): void {
    this.emit("status", this.pending.length ? "reconnecting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/documents/${this.documentId}/ws`, ["draft-v1", this.token]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => this.emit("status", "connecting"));
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", (event) => {
      if (this.destroyed || event.code === 1000) return;
      this.synced = false;
      this.ready = false;
      this.emit("status", event.code === 4003 ? "revoked" : "reconnecting");
      if (event.code !== 4003) this.reconnectTimer = window.setTimeout(() => this.connect(), 900);
    });
    socket.addEventListener("error", () => this.emit("status", "reconnecting"));
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      const message = JSON.parse(data) as { type: string; submissionId?: string; snapshot?: unknown; error?: string; reload?: boolean };
      if (message.type === "ready") {
        this.ready = true;
        this.pending.forEach((item) => this.sendUpdate(item));
        if (!this.pending.length) {
          this.emit("status", "saved");
          this.resolveSaveWaiters();
        }
      } else if (message.type === "ack" && message.submissionId) {
        this.pending = this.pending.filter((item) => item.id !== message.submissionId);
        this.persistPending();
        this.emit("status", this.pending.length ? "saving" : "saved");
        if (!this.pending.length) this.resolveSaveWaiters();
      } else if (message.type === "snapshot") {
        this.emit("snapshot", message.snapshot);
      } else if (message.type === "access-revoked") {
        this.destroyed = true;
        this.emit("status", "revoked");
        this.emit("error", message.error ?? "Access ended");
        this.socket?.close(4003, "Access ended");
        this.rejectSaveWaiters(message.error ?? "Access ended");
      } else if (message.type === "error") {
        this.emit("error", message.error);
        if (message.reload) location.reload();
      }
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(data);
    if (bytes[0] === UPDATE_MESSAGE) {
      Y.applyUpdate(this.document, bytes.slice(1), this);
      if (!this.synced) {
        this.synced = true;
        this.emit("synced", true);
      }
    } else if (bytes[0] === AWARENESS_MESSAGE) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes.slice(1), this);
    }
  }

  private handleDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    const item = { id: crypto.randomUUID(), update: toBase64(update) };
    this.pending.push(item);
    this.persistPending();
    this.emit("status", this.socket?.readyState === WebSocket.OPEN ? "saving" : "reconnecting");
    this.sendUpdate(item);
  };

  private handleAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
    if (origin === this) return;
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]);
    this.send(envelope(AWARENESS_MESSAGE, update));
  };

  private sendUpdate(item: PendingUpdate): void {
    const update = fromBase64(item.update);
    const id = new TextEncoder().encode(item.id);
    const message = new Uint8Array(1 + 36 + update.length);
    message[0] = UPDATE_MESSAGE;
    message.set(id, 1);
    message.set(update, 37);
    this.send(message.buffer);
  }

  private send(message: ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
  }

  private emit(event: ProviderEvent, value?: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }

  private loadPending(): PendingUpdate[] {
    try { return JSON.parse(localStorage.getItem(this.pendingKey) ?? "[]") as PendingUpdate[]; } catch { return []; }
  }

  private persistPending(): void {
    localStorage.setItem(this.pendingKey, JSON.stringify(this.pending));
  }

  private resolveSaveWaiters(): void {
    if (!this.ready || this.pending.length) return;
    for (const waiter of this.saveWaiters) {
      window.clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.saveWaiters.clear();
  }

  private rejectSaveWaiters(message: string): void {
    for (const waiter of this.saveWaiters) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error(message));
    }
    this.saveWaiters.clear();
  }
}

export function restorePendingUpdates(document: Y.Doc, pending: ReadonlyArray<PendingUpdate>, origin: unknown): void {
  for (const item of pending) Y.applyUpdate(document, fromBase64(item.update), origin);
}

function envelope(kind: number, body: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(body.length + 1);
  result[0] = kind;
  result.set(body, 1);
  return result.buffer;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
