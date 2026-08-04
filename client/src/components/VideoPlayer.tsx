import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import Hls from 'hls.js';
import type { VideoController } from '../lib/videoController';
import { rlog } from '../lib/remoteLogger';

interface Props {
  src: string;
  useHlsJs?: boolean; // true for .m3u8 sources on browsers without native HLS (non-Safari)
  subtitleUrl?: string;
  onControllerReady: (vc: VideoController) => void;
  onUserPlay: () => void;
  onUserPause: () => void;
  onUserSeek: (time: number) => void;
}

export interface VideoPlayerHandle {
  videoElement: HTMLVideoElement | null;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { src, useHlsJs, subtitleUrl, onControllerReady, onUserPlay, onUserPause, onUserSeek },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controllerRef = useRef<VideoController | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const prevSrcRef = useRef<string>('');

  useImperativeHandle(ref, () => ({
    get videoElement() { return videoRef.current; },
  }));

  // Attach the media source — native `src` for MP4/Safari-HLS, hls.js (MSE) for
  // .m3u8 on every other browser, none of which have native HLS support.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || prevSrcRef.current === src) return;
    prevSrcRef.current = src;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (useHlsJs && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        rlog.error(`HLS.js error type=${data.type} details=${data.details} fatal=${data.fatal}`);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              hlsRef.current = null;
              break;
          }
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }

    import('../lib/videoController').then(({ VideoController }) => {
      if (controllerRef.current) {
        controllerRef.current.destroy();
      }
      const vc = new VideoController(video);
      controllerRef.current = vc;
      onControllerReady(vc);
    });

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [src, useHlsJs, onControllerReady]);

  // Wire user-initiated events from native controls
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastUserSeekTime = 0;
    let isPointerDown = false;
    let seekPendingRelease = false;

    const handlePlay = () => {
      if (controllerRef.current?.applyingServerCommand) return;
      onUserPlay();
    };

    const handlePause = () => {
      if (controllerRef.current?.applyingServerCommand) return;
      onUserPause();
    };

    const handlePointerDown = () => {
      isPointerDown = true;
    };

    const handlePointerRelease = () => {
      if (!isPointerDown) return;
      isPointerDown = false;
      if (seekPendingRelease) {
        seekPendingRelease = false;
        onUserSeek(video.currentTime);
      }
    };

    const handleSeeking = () => {
      if (controllerRef.current?.applyingServerCommand) return;
      if (isPointerDown) {
        // Still dragging the scrubber — wait for release instead of guessing from timing,
        // otherwise a brief pause while lining up an exact time fires a premature sync.
        seekPendingRelease = true;
        return;
      }
      // No discrete release event for this seek (e.g. keyboard arrow keys) — fall back
      // to debouncing on the gap between seeking events.
      lastUserSeekTime = Date.now();
      setTimeout(() => {
        if (Date.now() - lastUserSeekTime >= 300) {
          onUserSeek(video.currentTime);
        }
      }, 350);
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeking', handleSeeking);
    video.addEventListener('mousedown', handlePointerDown);
    video.addEventListener('touchstart', handlePointerDown);
    video.addEventListener('mouseup', handlePointerRelease);
    video.addEventListener('touchend', handlePointerRelease);
    video.addEventListener('pointerup', handlePointerRelease);
    video.addEventListener('pointercancel', handlePointerRelease);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeking', handleSeeking);
      video.removeEventListener('mousedown', handlePointerDown);
      video.removeEventListener('touchstart', handlePointerDown);
      video.removeEventListener('mouseup', handlePointerRelease);
      video.removeEventListener('touchend', handlePointerRelease);
      video.removeEventListener('pointerup', handlePointerRelease);
      video.removeEventListener('pointercancel', handlePointerRelease);
    };
  }, [onUserPlay, onUserPause, onUserSeek]);

  // Imperatively append track — JSX <track> inside <video> triggers MEDIA_ERR_SRC_NOT_SUPPORTED on iOS Safari
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.querySelectorAll('track').forEach(t => t.remove());
    if (!subtitleUrl) return;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = subtitleUrl;
    track.srclang = 'en';
    track.label = 'English';
    track.default = true;
    video.appendChild(track);
    return () => { try { track.remove(); } catch { /* ignore */ } };
  }, [subtitleUrl]);

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      preload="auto"
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        background: '#000',
        outline: 'none',
      }}
    />
  );
});
