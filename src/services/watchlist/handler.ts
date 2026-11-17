import { HttpRequest, HttpResponse } from '@/http';
import { addToWatchlist, getWatchlist, removeFromWatchlist } from '@/lib/profile-features';

function activeProfileId(request: HttpRequest): string {
  return request.cookies.get('homeflix_profile_id')?.value || 'default';
}

export async function GET(request: HttpRequest) {
  const profileId = activeProfileId(request);
  return HttpResponse.json({ items: getWatchlist(profileId) });
}

export async function POST(request: HttpRequest) {
  const profileId = activeProfileId(request);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!itemId || !title) {
    return HttpResponse.json({ error: 'itemId and title are required' }, { status: 400 });
  }
  const type = body.type === 'Series' ? 'Series' : 'Movie';
  const posterUrl = typeof body.posterUrl === 'string' ? body.posterUrl : undefined;
  const year = typeof body.year === 'number' && Number.isFinite(body.year) ? body.year : undefined;
  const item = addToWatchlist(profileId, { itemId, title, type, posterUrl, year });
  return HttpResponse.json({ success: true, item, items: getWatchlist(profileId) });
}

export async function DELETE(request: HttpRequest) {
  const profileId = activeProfileId(request);
  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get('itemId') || '';
  if (!itemId) {
    return HttpResponse.json({ error: 'itemId is required' }, { status: 400 });
  }
  const removed = removeFromWatchlist(profileId, itemId);
  return HttpResponse.json({ success: removed, items: getWatchlist(profileId) });
}
