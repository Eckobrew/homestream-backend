import test from 'node:test';
import assert from 'node:assert/strict';
import { streamAudioArguments, canDirectStreamSource, forwardStreamCapabilities, streamVideoStrategy } from '../src/lib/stream-capabilities';

const query = (receiver = 'browser', width = 3840) => new URLSearchParams({ receiver,
  videoCapabilities: JSON.stringify([
    { codec: 'h264', width, height: width === 3840 ? 2160 : 1080, profiles: ['baseline', 'main', 'high'] },
    { codec: 'hevc', width, height: width === 3840 ? 2160 : 1080, profiles: ['main', 'main 10'] },
  ]), audioCodecs: 'aac,opus',
});
const hevc = { codec_name: 'hevc', profile: 'Main 10', width: 3840, height: 2160, audio_codec: 'aac' };

test('stream decisions use each receiver profile and dimensions', () => {
  assert.equal(streamVideoStrategy(hevc, query()).copy, true);
  const hd = streamVideoStrategy(hevc, query('cast', 1920));
  assert.equal(hd.copy, false);
  assert.match(hd.args.join(' '), /scale=.*1920.*1080/);
  assert.equal(streamVideoStrategy({ ...hevc, profile: 'Rext' }, query()).copy, false);
  assert.equal(streamVideoStrategy({ ...hevc, codec_name: 'mpeg2video' }, query()).copy, false);
  assert.equal(streamVideoStrategy(undefined, query()).copy, false);
  const baseline = new URLSearchParams({ videoCapabilities: JSON.stringify([{ codec: 'h264', width: 1280, height: 720, profiles: ['baseline'] }]) });
  assert.match(streamVideoStrategy(hevc, baseline).args.join(' '), /-profile:v baseline/);
  const forced = query(); forced.set('forceTranscode', 'true');
  assert.equal(streamVideoStrategy(hevc, forced).copy, false);
});

test('direct source delivery checks codecs and containers instead of file extensions alone', () => {
  assert.equal(canDirectStreamSource(hevc, query(), '.mp4'), true);
  assert.equal(canDirectStreamSource(hevc, query(), '.mkv'), false);
  assert.equal(canDirectStreamSource(hevc, query('native-android'), '.mkv'), true);
  assert.equal(canDirectStreamSource(hevc, query('native-tv'), '.mkv'), true);
  assert.equal(canDirectStreamSource(hevc, query('cast'), '.mkv'), false);
  assert.equal(canDirectStreamSource({ ...hevc, audio_codec: 'dts' }, query(), '.mp4'), false);
  assert.equal(canDirectStreamSource(hevc, query('native-tv', 1920), '.mkv'), false);
});

test('torrent and download forwarding preserves bounded receiver data and seeks', () => {
  const input = query('cast'); input.set('startTimeTicks', '10000000'); input.set('itemId', 'private');
  const result = new URLSearchParams(forwardStreamCapabilities(input).slice(1));
  assert.equal(result.get('videoCapabilities'), input.get('videoCapabilities'));
  assert.equal(result.get('receiver'), 'cast');
  assert.equal(result.get('startTimeTicks'), '10000000');
  assert.equal(result.has('itemId'), false);
  const legacy = new URLSearchParams(forwardStreamCapabilities(new URLSearchParams({ receiver: 'cast' })).slice(1));
  assert.equal(legacy.get('maxWidth'), '1920');
  assert.equal(legacy.get('maxHeight'), '1080');
});

test('remuxing preserves supported audio and converts unsupported formats', () => {
  assert.deepEqual(streamAudioArguments(hevc, query()), ['-c:a', 'copy']);
  const forced = query(); forced.set('forceTranscode', 'true');
  assert.deepEqual(streamAudioArguments(hevc, forced), ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']);
  assert.deepEqual(streamAudioArguments({ ...hevc, audio_codec: 'dts' }, query()), ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']);
});
