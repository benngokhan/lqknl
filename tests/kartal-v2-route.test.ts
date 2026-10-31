import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiraSessionValue } from '../src/lib/mira-auth';
import { POST } from '../src/app/api/kartal/assistant/route';

process.env.MIRA_SESSION_SECRET = 'only-a-local-unit-test-session-secret';
const validCookie = `mira_entry=${createMiraSessionValue()}`;

function request(options: { cookie?: string; origin?: string; type?: string; body?: string } = {}) {
  const headers: Record<string, string> = { host: 'localhost:3000', 'content-type': options.type || 'application/json' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  return new Request('http://localhost:3000/api/kartal/assistant', { method: 'POST', headers, body: options.body ?? '{"message":"merhaba"}' });
}

test('assistant requires a genuine session before accepting any request', async () => {
  assert.equal((await POST(request({ origin: 'http://localhost:3000' }))).status, 401);
  assert.equal((await POST(request({ cookie: 'mira_entry=bogus', origin: 'http://localhost:3000' }))).status, 401);
});

test('assistant rejects missing and cross-site origins, even with a session', async () => {
  assert.equal((await POST(request({ cookie: validCookie }))).status, 403);
  assert.equal((await POST(request({ cookie: validCookie, origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await POST(request({ cookie: validCookie, origin: 'http://localhost:3001' }))).status, 403);
});

test('assistant requires JSON and validates size and body', async () => {
  assert.equal((await POST(request({ cookie: validCookie, origin: 'http://localhost:3000', type: 'text/plain' }))).status, 415);
  assert.equal((await POST(request({ cookie: validCookie, origin: 'http://localhost:3000', body: 'not json' }))).status, 400);
  assert.equal((await POST(request({ cookie: validCookie, origin: 'http://localhost:3000', body: 'x'.repeat(32001) }))).status, 413);
});

test('same-origin authenticated request receives a real local greeting', async () => {
  const response = await POST(request({ cookie: validCookie, origin: 'http://localhost:3000' }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.kind, 'hello');
  assert.equal(data.ok, true);
  assert.match(data.reply, /Buradayım/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
