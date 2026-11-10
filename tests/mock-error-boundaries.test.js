import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockMailAdapter } from '../src/mail-mock.js';

const message = {
  requestId: 'boundary',
  to: 'owner@example.test',
  subject: 'subject',
  text: 'text'
};

test('mock send preserves Error identity and wraps other thrown reasons without converting them', async () => {
  for (const thrown of [
    new Error('original'),
    undefined,
    null,
    'reason',
    7,
    { reason: 'object' }
  ]) {
    const adapter = new MockMailAdapter({
      behavior: () => {
        throw thrown;
      }
    });
    const result = adapter.send(message);
    assert.ok(result instanceof Promise);
    await assert.rejects(result, (reason) => {
      assert.ok(reason instanceof Error);
      if (thrown instanceof Error) assert.equal(reason, thrown);
      else {
        assert.equal(reason.message, 'mock mail adapter failed');
        assert.equal(reason.cause, thrown);
      }
      return true;
    });
    assert.deepEqual(adapter.attempts, []);
    assert.deepEqual(adapter.outbox, []);
  }
});

test('mock reconcile preserves Error identity and wraps non-Error reasons after recording its read attempt', async () => {
  for (const thrown of [
    new Error('original'),
    undefined,
    null,
    'reason',
    7,
    { reason: 'object' }
  ]) {
    const adapter = new MockMailAdapter();
    adapter.outbox.find = () => {
      throw thrown;
    };
    const result = adapter.reconcile('boundary');
    assert.ok(result instanceof Promise);
    await assert.rejects(result, (reason) => {
      assert.ok(reason instanceof Error);
      if (thrown instanceof Error) assert.equal(reason, thrown);
      else {
        assert.equal(reason.message, 'mock mail adapter failed');
        assert.equal(reason.cause, thrown);
      }
      return true;
    });
    assert.deepEqual(adapter.reconciliations, ['boundary']);
    assert.deepEqual(adapter.attempts, []);
    assert.equal(adapter.outbox.length, 0);
  }
});
