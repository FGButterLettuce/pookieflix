import type { ClientHeartbeat } from '../types';
import { rlog } from './remoteLogger';

export type VideoEvent = 'play' | 'pause' | 'seek' | 'ended' | 'statechange' | 'error';
export type VideoEventHandler = (event: VideoEvent) => void;

export class VideoController {
  private video: HTMLVideoElement;
  private _applyingServerCommand = false;
  private commandTimeout: ReturnType<typeof setTimeout> | null = null;
  private scheduledPlayTimeout: ReturnType<typeof setTimeout> | null = null;
  private _playAtGeneration = 0; // incremented on cancel; guards stale seeked/canplay callbacks
  private lastUserActionAt = 0;
  private listeners: VideoEventHandler[] = [];

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.attachListeners();
  }

  private attachListeners(): void {
    const emit = (e: VideoEvent) => {
      if (!this._applyingServerCommand) {
        this.listeners.forEach(fn => fn(e));
      }
    };

    this.video.addEventListener('play',          () => emit('play'));
    this.video.addEventListener('pause',         () => emit('pause'));
    this.video.addEventListener('seeking',       () => emit('seek'));
    this.video.addEventListener('ended',         () => emit('ended'));
    this.video.addEventListener('waiting',       () => { rlog.warn(`VIDEO waiting rs=${this.video.readyState} buf=${this.getBufferedAhead().toFixed(1)}`); emit('statechange'); });
    this.video.addEventListener('canplay',       () => { rlog.log(`VIDEO canplay rs=${this.video.readyState}`); emit('statechange'); });
    this.video.addEventListener('canplaythrough',() => { rlog.log(`VIDEO canplaythrough rs=${this.video.readyState}`); emit('statechange'); });
    this.video.addEventListener('stalled',       () => { rlog.warn(`VIDEO stalled rs=${this.video.readyState} buf=${this.getBufferedAhead().toFixed(1)}`); emit('statechange'); });
    this.video.addEventListener('error',         () => {
      const err = this.video.error;
      rlog.error(`VIDEO error code=${err?.code} msg=${err?.message ?? '?'}`);
      this.listeners.forEach(fn => fn('error'));
    });
  }

  on(handler: VideoEventHandler): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter(fn => fn !== handler);
    };
  }

  // ── Server command application ────────────────────────────────────────────

  private beginServerCommand(): void {
    this._applyingServerCommand = true;
    if (this.commandTimeout) clearTimeout(this.commandTimeout);
    this.commandTimeout = setTimeout(() => {
      this._applyingServerCommand = false;
    }, 10_000);
  }

  private endServerCommand(): void {
    if (this.commandTimeout) clearTimeout(this.commandTimeout);
    this._applyingServerCommand = false;
  }

  get applyingServerCommand(): boolean {
    return this._applyingServerCommand;
  }

  applyPause(mediaTime: number): void {
    this.cancelScheduledPlay(); // prevent any in-flight schedulePlayAt from overriding the pause
    this.beginServerCommand();

    // Only seek if we're far from the target — seeking clears the browser's buffer and
    // triggers a new HTTP range request on mobile, which causes the buffering cascade.
    // Small offsets (<0.5s) are handled by rate correction after resume.
    const needsSeek = Math.abs(this.video.currentTime - mediaTime) > 2.0;
    if (needsSeek) {
      this.video.currentTime = mediaTime;
    }

    if (this.video.paused) {
      if (needsSeek) {
        // Already paused but seek is in progress — must wait for seeked before clearing
        // the command flag, otherwise handleSeeking fires a false USER_ACTION SEEK.
        this.video.addEventListener('seeked', () => this.endServerCommand(), { once: true });
      } else {
        this.endServerCommand();
      }
    } else {
      this.video.pause();
      if (needsSeek) {
        // pause fires first (applyingServerCommand=true, safe), seeked fires after
        this.video.addEventListener('seeked', () => this.endServerCommand(), { once: true });
      } else {
        this.video.addEventListener('pause', () => this.endServerCommand(), { once: true });
      }
    }
  }

  applySeek(mediaTime: number): void {
    this.beginServerCommand();
    this.video.currentTime = mediaTime;
    // Clear the flag once seek lands so the server can see we're done and send PLAY_AT
    this.video.addEventListener('seeked', () => {
      this.endServerCommand();
    }, { once: true });
  }

  applyPlay(): void {
    this.beginServerCommand();
    this.video.play().catch(() => {
      // Autoplay blocked — user needs to interact
    }).finally(() => {
      setTimeout(() => this.endServerCommand(), 500);
    });
  }

  schedulePlayAt(mediaTime: number, wallClockTime: number): void {
    this.cancelScheduledPlay();
    this.beginServerCommand();

    const gen = this._playAtGeneration; // stale if cancelScheduledPlay() is called later

    const applySeekAndWait = () => {
      if (this._playAtGeneration !== gen) return; // cancelled by a later command

      const doPlay = () => {
        if (this._playAtGeneration !== gen) return;
        const delay = wallClockTime - Date.now();
        if (delay > 0) {
          this.scheduledPlayTimeout = setTimeout(() => {
            if (this._playAtGeneration !== gen) return;
            this.video.play().catch(() => {}).finally(() => {
              setTimeout(() => this.endServerCommand(), 500);
            });
          }, delay);
        } else {
          this.video.play().catch(() => {}).finally(() => {
            setTimeout(() => this.endServerCommand(), 500);
          });
        }
      };

      if (this.video.readyState >= 3) {
        doPlay();
      } else {
        const onReady = () => {
          this.video.removeEventListener('canplay', onReady);
          doPlay();
        };
        this.video.addEventListener('canplay', onReady);
      }
    };

    if (Math.abs(this.video.currentTime - mediaTime) > 2.0) {
      this.video.currentTime = mediaTime;
      this.video.addEventListener('seeked', applySeekAndWait, { once: true });
    } else {
      applySeekAndWait();
    }
  }

  cancelScheduledPlay(): void {
    if (this.scheduledPlayTimeout) {
      clearTimeout(this.scheduledPlayTimeout);
      this.scheduledPlayTimeout = null;
    }
    this._playAtGeneration++; // invalidate any in-flight applySeekAndWait closures
  }

  applyRateAdjust(rate: number): void {
    this.video.playbackRate = rate;
  }

  // ── User actions (fire events as user-initiated) ──────────────────────────

  userPlay(): void {
    this.lastUserActionAt = Date.now();
    this.video.play().catch(() => {});
  }

  userPause(): void {
    this.lastUserActionAt = Date.now();
    this.video.pause();
  }

  userSeek(time: number): void {
    this.lastUserActionAt = Date.now();
    this.video.currentTime = time;
  }

  // ── State getters ─────────────────────────────────────────────────────────

  getHeartbeat(): ClientHeartbeat {
    const video = this.video;
    const bufferedAhead = this.getBufferedAhead();

    return {
      mediaTime: video.currentTime,
      paused: video.paused,
      ended: video.ended,
      seeking: video.seeking,
      waiting: this.isWaiting(),
      readyState: video.readyState,
      bufferedAhead,
      playbackRate: video.playbackRate,
      lastUserAction: this.lastUserActionAt,
      serverCommandPending: this._applyingServerCommand,
    };
  }

  private isWaiting(): boolean {
    return (
      !this.video.paused &&
      !this.video.ended &&
      this.video.readyState < 3 // HAVE_FUTURE_DATA
    );
  }

  private getBufferedAhead(): number {
    const video = this.video;
    const currentTime = video.currentTime;
    const buffered = video.buffered;

    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime + 0.1 && buffered.end(i) > currentTime) {
        return buffered.end(i) - currentTime;
      }
    }
    return 0;
  }

  get currentTime(): number {
    return this.video.currentTime;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  destroy(): void {
    this.cancelScheduledPlay();
    this.endServerCommand();
    this.listeners = [];
  }
}
