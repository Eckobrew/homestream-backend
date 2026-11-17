import { HttpRequest, HttpResponse } from '@/http';
import {
  clearProfileSeriesOverride,
  getProfileMediaPrefs,
  setProfileMediaPrefs,
  setProfileSeriesOverride,
  type MediaPrefs,
} from '@/lib/profile-features';

function activeProfileId(request: HttpRequest, bodyUserId?: unknown): string {
  if (typeof bodyUserId === 'string' && bodyUserId.trim()) return bodyUserId.trim();
  return request.nextUrl.searchParams.get('userId') || request.cookies.get('homeflix_profile_id')?.value || 'default';
}

export async function GET(request: HttpRequest) {
  const profileId = activeProfileId(request);
  const seriesId = new URL(request.url).searchParams.get('seriesId') || undefined;
  return HttpResponse.json(getProfileMediaPrefs(profileId, seriesId));
}

export async function POST(request: HttpRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const profileId = activeProfileId(request, body.userId);
  const prefs: MediaPrefs = {
    audioLang: typeof body.audioLang === 'string' ? body.audioLang : undefined,
    subtitleLang: typeof body.subtitleLang === 'string' ? body.subtitleLang : undefined,
    subtitleMode: typeof body.subtitleMode === 'string' && ['auto', 'always', 'forced', 'none'].includes(body.subtitleMode)
      ? (body.subtitleMode as MediaPrefs['subtitleMode'])
      : undefined,
  };
  const seriesId = typeof body.seriesId === 'string' && body.seriesId.trim() ? body.seriesId.trim() : undefined;
  if (seriesId) {
    const seriesOverride = setProfileSeriesOverride(profileId, seriesId, prefs);
    return HttpResponse.json({ success: true, ...getProfileMediaPrefs(profileId, seriesId), seriesOverride });
  }
  const defaults = setProfileMediaPrefs(profileId, prefs);
  return HttpResponse.json({ success: true, ...getProfileMediaPrefs(profileId), defaults });
}

export async function DELETE(request: HttpRequest) {
  const profileId = activeProfileId(request);
  const seriesId = new URL(request.url).searchParams.get('seriesId') || '';
  if (!seriesId) return HttpResponse.json({ error: 'seriesId is required' }, { status: 400 });
  const cleared = clearProfileSeriesOverride(profileId, seriesId);
  return HttpResponse.json({ success: cleared, ...getProfileMediaPrefs(profileId) });
}
