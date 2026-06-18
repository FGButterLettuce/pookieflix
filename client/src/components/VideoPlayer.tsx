import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import type { VideoController } from '../lib/videoController';

interface Props {
  src: string;
  onControllerReady: (vc: VideoController) => void;
  onUserPlay: () => void;
  onUserPause: () => void;
  onUserSeek: (time: number) => void;
}

export interface VideoPlayerHandle {
  videoElement: HTMLVideoElement | null;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { src, onControllerReady, onUserPlay, onUserPause, onUserSeek },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controllerRef = useRef<VideoController | null>(null);
  const prevSrcRef = useRef<string>('');

  useImperativeHandle(ref, () => ({
    get videoElement() { return videoRef.current; },
  }));

  useEffect(() => {
    const video = videoRef.current;
    if (!video || prevSrcRef.current === src) return;
    prevSrcRef.current = src;

    import('../lib/videoController').then(({ VideoController }) => {
      if (controllerRef.current) {
        controllerRef.current.destroy();
      }
      const vc = new VideoController(video);
      controllerRef.current = vc;
      onControllerReady(vc);
    });
  }, [src, onControllerReady]);

  // Wire user-initiated events from native controls
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastUserSeekTime = 0;

    const handlePlay = () => {
      if (controllerRef.current?.applyingServerCommand) return;
      onUserPlay();
    };

    const handlePause = () => {
      if (controllerRef.current?.applyingServerCommand) return;
      onUserPause();
    };

    const handleSeeking = () => {
      if (controllerRef.current?.applyingServerCommand) return;
      // Debounce seeking events — fire once when user stops scrubbing
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

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeking', handleSeeking);
    };
  }, [onUserPlay, onUserPause, onUserSeek]);

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      preload="auto"
      playsInline
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
