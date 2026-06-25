export type RoomState =
  | 'WAITING_FOR_VIEWERS'
  | 'READY_CHECK'
  | 'PLAYING'
  | 'USER_PAUSED'
  | 'BUFFERING'
  | 'SEEKING'
  | 'RESYNCING'
  | 'ENDED';

export interface ClientHeartbeat {
  mediaTime: number;
  paused: boolean;
  seeking: boolean;
  waiting: boolean;
  readyState: number;
  bufferedAhead: number;
  playbackRate: number;
  lastUserAction: number;
  serverCommandPending: boolean;
}

export type ClientMessage =
  | { type: 'HEARTBEAT'; data: ClientHeartbeat }
  | { type: 'USER_ACTION'; data: { action: 'PLAY' | 'PAUSE' | 'SEEK'; mediaTime?: number } };

export type ServerMessage =
  | { type: 'JOINED'; viewerId: string; isHost: boolean; roomState: RoomState; mediaUrl: string; mediaFilename: string; currentTime: number; subtitleUrl?: string; hlsUrl?: string }
  | { type: 'ROOM_UPDATE'; state: RoomState; viewerCount: number }
  | { type: 'PAUSE'; mediaTime: number }
  | { type: 'SEEK'; mediaTime: number }
  | { type: 'PLAY' }
  | { type: 'PLAY_AT'; mediaTime: number; wallClockTime: number }
  | { type: 'RATE_ADJUST'; playbackRate: number }
  | { type: 'PEER_STATUS'; bufferedAhead: number; mediaTime: number; seeking: boolean; waiting: boolean }
  | { type: 'ERROR'; message: string };

export interface RoomInfo {
  viewerId: string;
  isHost: boolean;
  roomState: RoomState;
  viewerCount: number;
  mediaUrl: string;
  mediaFilename: string;
  subtitleUrl?: string;
  hlsUrl?: string;
}

export interface LibraryFile {
  filename: string;
  size: number;
  duration: number;
  lastTime: number;
  lastPlayedAt: number;
  thumbReady: boolean;
  thumbUrl: string;
  hasSubtitles: boolean;
  subtitleFetching: boolean;
  subtitleName: string | null;
}

export interface PeerStatus {
  bufferedAhead: number;
  mediaTime: number;
  seeking: boolean;
  waiting: boolean;
}

export interface DiagnosticsData {
  ownBufferedAhead: number;
  peerBufferedAhead: number;
  drift: number;
  roomState: RoomState;
  wsStatus: 'connecting' | 'open' | 'closed' | 'error';
  viewerCount: number;
  playbackRate: number;
  mediaTime: number;
  isHost: boolean;
  readyState: number;
  waiting: boolean;
  serverCmdPending: boolean;
  usingHLS: boolean;
}
