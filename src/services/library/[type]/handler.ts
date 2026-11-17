import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { listNativeLibraryItems } from '@/lib/native-media';

export const revalidate = 0;

async function handleGET(
  request: HttpRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const libraryType = ((await params).type || '').toLowerCase();

  if (!['movies', 'tv', 'youtube'].includes(libraryType)) {
    return HttpResponse.json(
      { error: 'Invalid library type. Must be movies, tv, or youtube.' },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const letter = (searchParams.get('letter') || '').toUpperCase();
  const search = (searchParams.get('search') || '').trim().toLowerCase();

  if (libraryType === 'youtube') {
    return HttpResponse.json({
      type: 'youtube',
      title: 'YouTube',
      items: [],
      totalCount: 0,
      filteredCount: 0,
      availableLetters: [],
    });
  }

  const nativeItems = listNativeLibraryItems({ type: libraryType === 'tv' ? 'Series' : 'Movie' });
  const letterSet = new Set<string>();
  for (const item of nativeItems) {
    const first = (item.title || '').trim()[0]?.toUpperCase() || '';
    if (/[A-Z]/.test(first)) letterSet.add(first);
    else if (first) letterSet.add('#');
  }
  const availableLetters = Array.from(letterSet).sort((a, b) => {
    if (a === '#') return -1;
    if (b === '#') return 1;
    return a.localeCompare(b);
  });

  const filtered = nativeItems.filter((item) => {
    if (letter && letter !== 'ALL') {
      const first = (item.title || '').trim()[0]?.toUpperCase() || '';
      if (letter === '#' ? /[A-Z]/.test(first) : first !== letter) return false;
    }
    if (search) {
      const hay = `${item.title} ${item.overview} ${item.genres.join(' ')}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  return HttpResponse.json({
    type: libraryType,
    title: libraryType === 'tv' ? 'TV Shows' : 'Movies',
    items: filtered,
    totalCount: nativeItems.length,
    filteredCount: filtered.length,
    availableLetters,
  });
}

export const GET = withParentalControls(handleGET);
