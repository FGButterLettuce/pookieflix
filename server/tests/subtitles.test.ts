import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vttToSrt } from '../src/subtitles';

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
