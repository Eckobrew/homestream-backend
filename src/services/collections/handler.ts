import { HttpRequest, HttpResponse } from '@/http';
import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  listCollections,
  removeCollectionItem,
} from '@/lib/profile-features';

function activeProfileId(request: HttpRequest): string {
  return request.cookies.get('homeflix_profile_id')?.value || 'default';
}

export async function GET(request: HttpRequest) {
  const profileId = activeProfileId(request);
  return HttpResponse.json({ collections: listCollections(profileId) });
}

export async function POST(request: HttpRequest) {
  const profileId = activeProfileId(request);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : 'create';
  if (action === 'addItem') {
    const collectionId = typeof body.collectionId === 'string' ? body.collectionId : '';
    const itemId = typeof body.itemId === 'string' ? body.itemId : '';
    if (!collectionId || !itemId) return HttpResponse.json({ error: 'collectionId and itemId are required' }, { status: 400 });
    const ok = addCollectionItem(profileId, collectionId, itemId);
    return HttpResponse.json({ success: ok, collections: listCollections(profileId) });
  }
  if (action === 'removeItem') {
    const collectionId = typeof body.collectionId === 'string' ? body.collectionId : '';
    const itemId = typeof body.itemId === 'string' ? body.itemId : '';
    if (!collectionId || !itemId) return HttpResponse.json({ error: 'collectionId and itemId are required' }, { status: 400 });
    const ok = removeCollectionItem(profileId, collectionId, itemId);
    return HttpResponse.json({ success: ok, collections: listCollections(profileId) });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return HttpResponse.json({ error: 'Collection name is required' }, { status: 400 });
  const description = typeof body.description === 'string' ? body.description : undefined;
  const isShared = Boolean(body.isShared);
  const collection = createCollection(profileId, name, description, isShared);
  return HttpResponse.json({ success: true, collection, collections: listCollections(profileId) });
}

export async function DELETE(request: HttpRequest) {
  const profileId = activeProfileId(request);
  const collectionId = new URL(request.url).searchParams.get('id') || '';
  if (!collectionId) return HttpResponse.json({ error: 'id is required' }, { status: 400 });
  const deleted = deleteCollection(profileId, collectionId);
  return HttpResponse.json({ success: deleted, collections: listCollections(profileId) });
}
