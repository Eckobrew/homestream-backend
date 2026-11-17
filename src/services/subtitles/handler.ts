import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { readSession } from '@/lib/session';
import { extractNativeSubtitleVtt, listNativeSubtitlesForFile, resolveNativeFileByItemOrFileId } from '@/lib/native-transcode';
import { getMediaEngineSettings } from '@/lib/media-settings';
import { getProfileMediaPrefs } from '@/lib/profile-features';
import { stateDatabase } from '@/state/database';

async function handleGET(request: HttpRequest) {
  const { searchParams } = request.nextUrl;
  const itemId = searchParams.get('itemId');
  const mediaSourceId = searchParams.get('mediaSourceId') || itemId || '';
  const indexStr = searchParams.get('index');

  if (indexStr !== null && !request.nextUrl.pathname.startsWith('/api/mobile/') &&
      !await readSession(request.cookies.get('homeflix_session')?.value, 'web')) {
    return HttpResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (!itemId || !/^[a-zA-Z0-9_-]{1,128}$/.test(itemId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(mediaSourceId) || (indexStr !== null && (!/^\d+$/.test(indexStr) || !Number.isSafeInteger(Number(indexStr))))) {
    return HttpResponse.json({ error: 'Valid itemId, mediaSourceId and subtitle index required' }, { status: 400 });
  }

  const serverDefaultMode = getMediaEngineSettings().subtitleMode;
  const fileRow = resolveNativeFileByItemOrFileId(itemId, searchParams.get('versionId') || undefined);
  const profileId = searchParams.get('userId') || request.cookies.get('homeflix_profile_id')?.value || 'default';

  if (!fileRow) {
    if (indexStr !== null) {
      return HttpResponse.json({ error: 'Subtitle not found' }, { status: 404 });
    }
    return HttpResponse.json({ subtitles: [], subtitleMode: serverDefaultMode });
  }

  if (indexStr !== null && indexStr !== undefined) {
    const vtt = await extractNativeSubtitleVtt(fileRow, parseInt(indexStr, 10));
    if (!vtt) return HttpResponse.json({ error: 'Subtitle not found' }, { status: 404 });
    return new HttpResponse(vtt, {
      status: 200,
      headers: {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const epRow = fileRow.episode_id
    ? (stateDatabase().prepare('SELECT series_id FROM native_media_episodes WHERE id = ?').get(fileRow.episode_id) as { series_id?: string } | undefined)
    : undefined;
  const prefs = getProfileMediaPrefs(profileId, epRow?.series_id);
  const effectiveMode = prefs.effective.subtitleMode && prefs.effective.subtitleMode !== 'auto'
    ? prefs.effective.subtitleMode
    : serverDefaultMode;

  return HttpResponse.json({
    subtitles: listNativeSubtitlesForFile(fileRow, {
      subtitleLang: prefs.effective.subtitleLang,
      subtitleMode: prefs.effective.subtitleMode,
    }),
    subtitleMode: effectiveMode,
  });
}

export const GET = withParentalControls(handleGET);
