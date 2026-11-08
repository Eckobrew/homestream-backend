import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateApiRequest, operationFor, webOperations, mobileOperations } from '../src/api-schema';
import { HttpRequest } from '../src/http';
import { routes } from '../src/routes';

test('every exported web route and native dispatcher operation has a schema', () => {
  for (const route of routes.filter(route => !route.path.includes('/mobile/'))) for (const method of route.methods) assert.ok(operationFor(route.path.replace(':id','sample').replace(':type','movies'),method),`${method} ${route.path}`);
  assert.ok(mobileOperations.length > 30);
  assert.ok(webOperations.every(operation => operation.response && operation.query));
});
test('web and mobile use the same typed validation for unsafe numbers and malformed bodies', async () => {
  for (const path of ['/api/v1/playback/progress','/api/mobile/v1/progress']) {
    const bad=new HttpRequest(`http://localhost${path}`,{method:'POST',body:JSON.stringify({itemId:'episode',positionTicks:-1})});
    assert.equal((await validateApiRequest(bad))?.status,400);
    const good=new HttpRequest(`http://localhost${path}`,{method:'POST',body:JSON.stringify({itemId:'episode',positionTicks:1000})});
    assert.equal(await validateApiRequest(good),undefined);
  }
  assert.equal((await validateApiRequest(new HttpRequest('http://localhost/api/v1/playback?itemId=movie&startTimeTicks=NaN')))?.status,400);
});
