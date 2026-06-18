import type { WebSocket } from 'ws';

// ── Room state machine ───────────────────────────────────────────────────────

export type RoomState =
  | 'WAITING_FOR_VIEWERS'
  | 'READY_CHECK'
  | 'PLAYING'
  | 'USER_PAUSED'
  | 'BUFFERING'
  | 'SEEKING'
  | 'RESYNCING'
  | 'ENDED';

// ── Wire protocol: client → server ──────────────────────────────────────────

export interface ClientHeartbeat {
  mediaTime: number;
  paused: boolean;
  seeking: boolean;
  waiting: boolean;        // video "waiting" event / stalled
  readyState: number;      // HTMLMediaElement.readyState (0-4)
  bufferedAhead: number;   // seconds buffered ahead of currentTime
  playbackRate: number;
  lastUserAction: number;  // epoch ms of last user-initiated action
  serverCommandPending: boolean; // true while applying a server command
}

export type UserActionType = 'PLAY' | 'PAUSE' | 'SEEK';

export interface ClientUserAction {
  action: UserActionType;
  mediaTime?: number; // required for SEEK
}

export type ClientMessage =
  | { type: 'HEARTBEAT'; data: ClientHeartbeat }
  | { type: 'USER_ACTION'; data: ClientUserAction };

// ── Wire protocol: server → client ──────────────────────────────────────────

export type ServerMessageType =
  | 'JOINED'
  | 'ROOM_UPDATE'
  | 'PAUSE'
  | 'SEEK'
  | 'PLAY'
  | 'PLAY_AT'
  | 'RATE_ADJUST'
  | 'PEER_STATUS'
  | 'ERROR';

export interface JoinedMessage {
  type: 'JOINED';
  viewerId: string;
  isHost: boolean;
  roomState: RoomState;
  mediaUrl: string;
  mediaFilename: string;
  currentTime: number;
  subtitleUrl?: string;
}

export interface RoomUpdateMessage {
  type: 'ROOM_UPDATE';
  state: RoomState;
  viewerCount: number;
}

export interface PauseMessage {
  type: 'PAUSE';
  mediaTime: number;
}

export interface SeekMessage {
  type: 'SEEK';
  mediaTime: number;
}

export interface PlayMessage {
  type: 'PLAY';
}

export interface PlayAtMessage {
  type: 'PLAY_AT';
  mediaTime: number;
  wallClockTime: number; // epoch ms to start playback
}

export interface RateAdjustMessage {
  type: 'RATE_ADJUST';
  playbackRate: number;
}

export interface PeerStatusMessage {
  type: 'PEER_STATUS';
  bufferedAhead: number;
  mediaTime: number;
  seeking: boolean;
  waiting: boolean;
}

export interface ErrorMessage {
  type: 'ERROR';
  message: string;
}

export type ServerMessage =
  | JoinedMessage
  | RoomUpdateMessage
  | PauseMessage
  | SeekMessage
  | PlayMessage
  | PlayAtMessage
  | RateAdjustMessage
  | PeerStatusMessage
  | ErrorMessage;

// ── Room runtime state (in-memory, not persisted) ────────────────────────────

export interface ViewerRuntime {
  viewerId: string;
  ws: WebSocket;
  isHost: boolean;
  joinedAt: number;       // epoch ms
  heartbeat: ClientHeartbeat | null;
  heartbeatAt: number;    // epoch ms of last heartbeat received (0 = never)
}

export interface RoomRuntime {
  roomId: string;
  roomToken: string;
  mediaPath: string;
  mediaFilename: string;
  mediaSize: number;
  expiresAt: number;
  state: RoomState;
  viewers: Map<string, ViewerRuntime>;
  canonicalTime: number;         // server's best estimate of current playback position
  canonicalTimeUpdatedAt: number; // wall clock when canonicalTime was last set
  wasPlayingBeforeInterruption: boolean; // used during SEEKING/BUFFERING to decide whether to resume
  wasUserPaused: boolean;               // preserved across reconnects so USER_PAUSED survives WS drops
  bufferingStartAt?: number;            // epoch ms when BUFFERING was entered (for timeout logic)
  pendingRateTarget: Map<string, number>; // viewerId → pending playback rate
  lastTickAt: number;
  lastPersistedAt?: number;
  lastResyncAt?: number; // epoch ms of last RESYNCING transition (for cooldown)
}

// ── DB row types ─────────────────────────────────────────────────────────────

export interface RoomRow {
  id: string;
  token: string;
  media_path: string;
  media_filename: string;
  media_size: number;
  created_at: number;
  expires_at: number;
}

export interface LibraryMetaRow {
  filename: string;
  duration: number;       // seconds
  last_time: number;      // seconds — last paused position
  last_played_at: number; // epoch ms
  thumb_ready: number;    // 0 | 1
}

export interface LibraryFileInfo {
  filename: string;
  size: number;
  duration: number;
  lastTime: number;
  lastPlayedAt: number;
  thumbReady: boolean;
  thumbUrl: string;
  hasSubtitles: boolean;
  subtitleFetching: boolean;
}
