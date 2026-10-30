import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookHandler } from '../src/webhook.mjs';

test('repeated webhook event creates one invoice', () => {
  const service = createWebhookHandler();
  service.handle({ eventId: 'evt-001', amount: 4800 });
  service.handle({ eventId: 'evt-001', amount: 4800 });
  assert.equal(service.invoices.length, 1);
});

test('distinct events continue processing', () => {
  const service = createWebhookHandler();
  service.handle({ eventId: 'evt-001', amount: 4800 });
  service.handle({ eventId: 'evt-002', amount: 7200 });
  assert.equal(service.invoices.length, 2);
});

test('invoice amount is preserved', () => {
  const service = createWebhookHandler();
  service.handle({ eventId: 'evt-003', amount: 1250 });
  assert.deepEqual(service.invoices, [{ eventId: 'evt-003', amount: 1250 }]);
});
