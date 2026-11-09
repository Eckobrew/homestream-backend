import { test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { isExportifyCsv, parseExportifyCsv, parseExportifyZip } from '../src/lib/exportify.js';

test('isExportifyCsv detects Exportify CSV headers', () => {
  const csv = 'Track URI,Track Name,Artist Name(s),Album Name\nspotify:track:123,Song,Artist,Album';
  assert.strictEqual(isExportifyCsv(csv), true);
  assert.strictEqual(isExportifyCsv('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), false);
});

test('parseExportifyCsv parses standard Exportify CSV with quotes and durations', () => {
  const csv = `Track URI,Track Name,Artist URI(s),Artist Name(s),Album URI,Album Name,Album Artist URI(s),Album Artist Name(s),Album Release Date,Duration (ms),Popularity,Explicit,Added By,Added At
spotify:track:4cOdK2wGLETKBW3PvgPWqT,"Never Gonna Give You Up",spotify:artist:0gxyHStUsqpMadRV0Di1Qt,"Rick Astley",spotify:album:0nJW41iZ5ASt5jN0A5QhP6,"Whenever You Need Somebody",spotify:artist:0gxyHStUsqpMadRV0Di1Qt,"Rick Astley",1987-11-12,213573,85,false,spotify:user:1234,2021-01-01T12:00:00Z
spotify:track:7qiZfU4dY1lWllzX7mPBI3,"Shape of You",spotify:artist:6eUKZXaKkcviH0Ku9w2n3V,"Ed Sheeran",spotify:album:3T4tUhGYe2veMr7kj312lp,"÷ (Divide)",spotify:artist:6eUKZXaKkcviH0Ku9w2n3V,"Ed Sheeran",2017-03-03,233712,90,false,spotify:user:1234,2021-01-01T12:00:00Z`;

  const tracks = parseExportifyCsv(csv);
  assert.strictEqual(tracks.length, 2);
  assert.strictEqual(tracks[0].title, 'Never Gonna Give You Up');
  assert.strictEqual(tracks[0].artist, 'Rick Astley');
  assert.strictEqual(tracks[0].album, 'Whenever You Need Somebody');
  assert.strictEqual(tracks[0].durationSeconds, 214);
  assert.strictEqual(tracks[0].spotifyTrackId, '4cOdK2wGLETKBW3PvgPWqT');

  assert.strictEqual(tracks[1].title, 'Shape of You');
  assert.strictEqual(tracks[1].artist, 'Ed Sheeran');
  assert.strictEqual(tracks[1].album, '÷ (Divide)');
  assert.strictEqual(tracks[1].durationSeconds, 234);
});

test('parseExportifyZip extracts multiple CSV playlists from zip archive', () => {
  const f1Name = Buffer.from('80s Rock.csv');
  const f1Data = Buffer.from('Track URI,Track Name,Artist Name(s),Album Name\nspotify:track:1,Song 1,Artist 1,Album 1\n');
  const f1Deflated = zlib.deflateRawSync(f1Data);

  const f2Name = Buffer.from('Synthwave.csv');
  const f2Data = Buffer.from('Track URI,Track Name,Artist Name(s),Album Name\nspotify:track:2,Song 2,Artist 2,Album 2\n');
  const f2Deflated = zlib.deflateRawSync(f2Data);

  // Build local headers + data
  const l1Header = Buffer.alloc(30);
  l1Header.writeUInt32LE(0x04034b50, 0);
  l1Header.writeUInt16LE(8, 8);
  l1Header.writeUInt32LE(f1Deflated.length, 18);
  l1Header.writeUInt32LE(f1Data.length, 22);
  l1Header.writeUInt16LE(f1Name.length, 26);
  const l1Offset = 0;
  const l1 = Buffer.concat([l1Header, f1Name, f1Deflated]);

  const l2Header = Buffer.alloc(30);
  l2Header.writeUInt32LE(0x04034b50, 0);
  l2Header.writeUInt16LE(8, 8);
  l2Header.writeUInt32LE(f2Deflated.length, 18);
  l2Header.writeUInt32LE(f2Data.length, 22);
  l2Header.writeUInt16LE(f2Name.length, 26);
  const l2Offset = l1.length;
  const l2 = Buffer.concat([l2Header, f2Name, f2Deflated]);

  // Central directory
  const cd1 = Buffer.alloc(46);
  cd1.writeUInt32LE(0x02014b50, 0);
  cd1.writeUInt16LE(8, 10);
  cd1.writeUInt32LE(f1Deflated.length, 20);
  cd1.writeUInt32LE(f1Data.length, 24);
  cd1.writeUInt16LE(f1Name.length, 28);
  cd1.writeUInt32LE(l1Offset, 42);
  const cd1Total = Buffer.concat([cd1, f1Name]);

  const cd2 = Buffer.alloc(46);
  cd2.writeUInt32LE(0x02014b50, 0);
  cd2.writeUInt16LE(8, 10);
  cd2.writeUInt32LE(f2Deflated.length, 20);
  cd2.writeUInt32LE(f2Data.length, 24);
  cd2.writeUInt16LE(f2Name.length, 28);
  cd2.writeUInt32LE(l2Offset, 42);
  const cd2Total = Buffer.concat([cd2, f2Name]);

  const cdOffset = l1.length + l2.length;
  const cdSize = cd1Total.length + cd2Total.length;

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  const zip = Buffer.concat([l1, l2, cd1Total, cd2Total, eocd]);

  const entries = parseExportifyZip(zip);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].name, '80s Rock');
  assert.strictEqual(entries[1].name, 'Synthwave');

  const tracks1 = parseExportifyCsv(entries[0].content);
  assert.strictEqual(tracks1.length, 1);
  assert.strictEqual(tracks1[0].title, 'Song 1');
});
