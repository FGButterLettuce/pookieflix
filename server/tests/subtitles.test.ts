import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vttToSrt, shiftVtt } from '../src/subtitles';

describe('vttToSrt', () => {
  it('converts a basic multi-cue VTT to SRT', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.500
Hello world

2
00:00:03.000 --> 00:00:04.000 align:start position:10%
Second line
with two rows
`;
    const expected = `1
00:00:01,000 --> 00:00:02,500
Hello world

2
00:00:03,000 --> 00:00:04,000
Second line
with two rows
`;
    assert.equal(vttToSrt(vtt), expected);
  });

  it('drops cue identifiers and handles a missing WEBVTT header gracefully', () => {
    const vtt = `cue-42
00:01:00.000 --> 00:01:05.000
Only cue
`;
    const result = vttToSrt(vtt);
    assert.equal(result, `1\n00:01:00,000 --> 00:01:05,000\nOnly cue\n`);
  });

  it('normalizes hour-omitted timestamps (MM:SS.mmm) to full HH:MM:SS,mmm', () => {
    const vtt = `WEBVTT

1
01:02.500 --> 01:05.000
Under an hour, no hour component
`;
    const result = vttToSrt(vtt);
    assert.equal(result, `1\n00:01:02,500 --> 00:01:05,000\nUnder an hour, no hour component\n`);
  });
});

describe('shiftVtt', () => {
  it('shifts every cue forward by a positive delta', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.500
Hello world

2
00:00:03.000 --> 00:00:04.000
Second line
`;
    const result = shiftVtt(vtt, 500);
    assert.match(result, /00:00:01\.500 --> 00:00:03\.000/);
    assert.match(result, /00:00:03\.500 --> 00:00:04\.500/);
  });

  it('shifts every cue backward by a negative delta', () => {
    const vtt = `WEBVTT

1
00:00:05.000 --> 00:00:06.000
Hello world
`;
    const result = shiftVtt(vtt, -1000);
    assert.match(result, /00:00:04\.000 --> 00:00:05\.000/);
  });

  it('clamps timestamps at 0 instead of going negative', () => {
    const vtt = `WEBVTT

1
00:00:00.500 --> 00:00:01.000
Near the start
`;
    const result = shiftVtt(vtt, -2000);
    assert.match(result, /00:00:00\.000 --> 00:00:00\.000/);
  });

  it('handles hour-omitted input, normalizing to full HH:MM:SS.mmm output', () => {
    const vtt = `WEBVTT

1
01:02.500 --> 01:05.000
Under an hour, no hour component
`;
    const result = shiftVtt(vtt, 250);
    assert.match(result, /00:01:02\.750 --> 00:01:05\.250/);
  });

  it('leaves non-timing lines untouched', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000 align:start position:10%
Some text with 00:00:09.999 inside it
`;
    const result = shiftVtt(vtt, 1000);
    assert.match(result, /00:00:02\.000 --> 00:00:03\.000/);
    assert.match(result, /Some text with 00:00:09\.999 inside it/);
  });
});
