import type { ClientMessage, ServerMessage } from '../types';
import { rlog } from './remoteLogger';

export type WsStatus = 'connecting' | 'open' | 'closed' | 'error';
export type MessageHandler = (msg: ServerMessage) => void;
export type StatusHandler = (status: WsStatus) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private roomToken: string;
  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private destroyed = false;

  constructor(roomToken: string) {
    this.roomToken = roomToken;
  }

  connect(): void {
    if (this.destroyed) return;
    this.setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws?roomToken=${this.roomToken}`;
    rlog.log(`WS connecting (attempt ${this.reconnectAttempts + 1})`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      rlog.log('WS open');
      this.setStatus('open');
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.messageHandlers.forEach(fn => fn(msg));
      } catch { /* ignore malformed */ }
    });

    ws.addEventListener('close', (e) => {
      if (!this.destroyed) {
        rlog.warn(`WS closed code=${e.code} attempt=${this.reconnectAttempts}`);
        this.setStatus('closed');
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      rlog.error('WS error');
      this.setStatus('error');
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    // Unlimited reconnects — cellular connections drop frequently
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 15000);
    this.reconnectAttempts++;
    rlog.log(`WS reconnecting in ${delay}ms`);
    this.reconnectTimeout = setTimeout(() => {
      if (!this.destroyed) this.connect();
    }, delay);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => { this.messageHandlers = this.messageHandlers.filter(fn => fn !== handler); };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler);
    return () => { this.statusHandlers = this.statusHandlers.filter(fn => fn !== handler); };
  }

  private setStatus(status: WsStatus): void {
    this.statusHandlers.forEach(fn => fn(status));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.ws?.close();
    this.messageHandlers = [];
    this.statusHandlers = [];
  }
}
