import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequest, HttpResponse } from '../src/http';

test('Fetch adapters retain request bodies, URL parameters, and independent cookies', async () => {
  const request = new HttpRequest('https://example.test/api/progress?userId=1', { method: 'POST', body: '{"positionTicks":100}', headers: { cookie: 'homeflix_session=a.b; homeflix_profile_id=kid' } });
  assert.equal(request.nextUrl.clone().searchParams.get('userId'), '1');
  assert.equal(request.cookies.get('homeflix_profile_id')?.value, 'kid');
  assert.deepEqual(await request.clone().json(), await request.json());
  const response = HttpResponse.json({ success: true });
  response.cookies.set('session', 'a.b', { httpOnly: true, secure: true, sameSite: 'lax' });
  response.cookies.delete('profile');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.getSetCookie()[0], /HttpOnly; Secure/);
  assert.match(response.headers.getSetCookie()[1], /Max-Age=0/);
});
