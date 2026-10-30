// Sent instead of the real figure once the buffer reaches the end of the film.
// The server pauses below 2s ahead and resumes at 10s+, and the last seconds of
// any film can never hold that much, so it has to read as "nothing left to wait for".
export const BUFFERED_TO_END = 3600;

// Buffered ranges can stop slightly short of `duration` (audio and video tracks
// rarely end on the same frame).
const END_TOLERANCE_SECONDS = 0.5;

type Ranges = Pick<TimeRanges, 'length' | 'start' | 'end'>;

export function bufferedAheadSeconds(buffered: Ranges, currentTime: number, duration: number): number {
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (start > currentTime + 0.1 || end < currentTime) continue;
    if (Number.isFinite(duration) && end >= duration - END_TOLERANCE_SECONDS) return BUFFERED_TO_END;
    if (end > currentTime) return end - currentTime;
  }
  return 0;
}
