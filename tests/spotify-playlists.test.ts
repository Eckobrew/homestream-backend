import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpotifyTargets, parseSpotifyPlaylistId, parseSpotifyUserId } from '../src/lib/spotify';

test('parseSpotifyPlaylistId handles standard URLs, URIs, and raw IDs', () => {
  assert.equal(parseSpotifyPlaylistId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=12345'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId('37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId('invalid-playlist-id'), null);
});

test('parseSpotifyUserId handles user URLs and URIs', () => {
  assert.equal(parseSpotifyUserId('https://open.spotify.com/user/spotify?si=123'), 'spotify');
  assert.equal(parseSpotifyUserId('spotify:user:john_doe'), 'john_doe');
  assert.equal(parseSpotifyUserId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), null);
});

test('extractSpotifyTargets extracts multiple playlists and user IDs from multiline text', () => {
  const multiline = `
    https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
    spotify:playlist:37i9dQZF1DX4JAvHpjipBk
    https://open.spotify.com/user/my_user_profile
  `;

  const targets = extractSpotifyTargets(multiline);
  assert.equal(targets.playlistIds.length, 2);
  assert.ok(targets.playlistIds.includes('37i9dQZF1DXcBWIGoYBM5M'));
  assert.ok(targets.playlistIds.includes('37i9dQZF1DX4JAvHpjipBk'));
  assert.equal(targets.userIds.length, 1);
  assert.ok(targets.userIds.includes('my_user_profile'));
});
