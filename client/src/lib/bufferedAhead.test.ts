import test from 'node:test';
import assert from 'node:assert/strict';
import { BUFFERED_TO_END, bufferedAheadSeconds } from './bufferedAhead';

const ranges = (...pairs: [number, number][]) => ({
  length: pairs.length,
  start: (i: number) => pairs[i][0],
  end: (i: number) => pairs[i][1],
});

const cases: [string, ReturnType<typeof ranges>, number, number, number][] = [
  ['seconds ahead in the middle of a film', ranges([0, 100]), 40, 7200, 60],
  ['nothing buffered', ranges(), 40, 7200, 0],
  ['position outside every range', ranges([0, 10], [50, 60]), 30, 7200, 0],
  ['the range containing the position', ranges([0, 10], [50, 60]), 55, 7200, 5],
  ['final seconds of the film', ranges([7000, 7200]), 7198.5, 7200, BUFFERED_TO_END],
  ['stream that stops just short of the reported duration', ranges([7000, 7199.7]), 7199, 7200, BUFFERED_TO_END],
  ['playback sitting on the last frame', ranges([7000, 7200]), 7200, 7200, BUFFERED_TO_END],
  ['clip shorter than the resume threshold', ranges([0, 8]), 0, 8, BUFFERED_TO_END],
  ['unknown duration before metadata loads', ranges([0, 10]), 5, NaN, 5],
  ['a live-style infinite duration', ranges([0, 10]), 5, Infinity, 5],
];

for (const [name, buffered, currentTime, duration, want] of cases) {
  test(`bufferedAheadSeconds: ${name}`, () => {
    assert.equal(bufferedAheadSeconds(buffered, currentTime, duration), want);
  });
}
