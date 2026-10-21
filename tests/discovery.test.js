import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryEvidence } from '../server/discovery-evidence.js';

test('job questions need career evidence; a generic LinkedIn notification is not enough', () => {
  const evidence = discoveryEvidence([
    { id: 'like', sender: 'updates@linkedin.com', subject: 'Someone liked your post' },
    { id: 'newsletter', sender: 'writer@substack.com', subject: 'The weekly edition' },
    { id: 'sale', sender: 'shop@example.invalid', subject: 'Weekend sale: 20% off' }
  ]);
  assert.deepEqual(evidence.job_opportunities, []);
  assert.deepEqual(evidence.newsletters, ['newsletter']);
  assert.deepEqual(evidence.social_notifications, ['like']);
  assert.deepEqual(evidence.sales_discounts, ['sale']);
});

test('career evidence supports a broad job preference without making it universal', () => {
  const evidence = discoveryEvidence([
    { id: 'job', sender: 'jobs@linkedin.com', subject: 'Software engineer roles for you' }
  ]);
  assert.deepEqual(evidence.job_opportunities, ['job']);
  assert.deepEqual(evidence.newsletters, []);
  assert.deepEqual(discoveryEvidence([]).job_opportunities, []);
});
