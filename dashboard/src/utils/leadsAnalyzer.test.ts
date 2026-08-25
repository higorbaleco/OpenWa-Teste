import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeadCsv, buildLeadSummary, parseLeadWorkflowInput, sortLeadRows } from './leadsAnalyzer.ts';

const sample = {
  generatedAt: '2026-08-14T12:00:00.000Z',
  conversations: [
    {
      contact: 'Lead B',
      chatId: 'b@lid',
      interestStatus: 'warm',
      sentiment: 'neutral',
      closedValue: '0',
      openPipelineValue: '12500,50',
      evidenceSnippets: ['“Quanto custa?”'],
      lastInteraction: '2026-08-14T12:01:00.000Z',
    },
    {
      contact: 'Lead A',
      chatId: 'a@lid',
      interestStatus: 'genuine-buyer',
      sentiment: 'positive',
      closedValue: 18000,
      openPipelineValue: 24000,
      evidenceSnippets: ['“Fechamos por R$ 18 mil.”'],
      lastInteraction: '2026-08-14T12:02:00.000Z',
    },
    {
      contact: 'Amigo',
      chatId: 'p@lid',
      interestStatus: 'personal',
      sentiment: 'positive',
      closedValue: 0,
      openPipelineValue: null,
      evidenceSnippets: ['“Vamos almoçar?”'],
      lastInteraction: '2026-08-14T11:59:00.000Z',
    },
  ],
};

test('parses a workflow payload and sorts by interest priority', () => {
  const parsed = parseLeadWorkflowInput(JSON.stringify(sample));
  assert.equal(parsed.conversations.length, 3);
  assert.deepEqual(parsed.conversations.map(row => row.chatId), ['a@lid', 'b@lid', 'p@lid']);
});

test('builds summary metrics from parsed rows', () => {
  const parsed = parseLeadWorkflowInput(sample);
  const summary = buildLeadSummary(parsed.conversations);
  assert.equal(summary.total, 3);
  assert.equal(summary.closedCount, 1);
  assert.equal(summary.closedTotal, 18000);
  assert.equal(summary.openPipelineTotal, 36500.5);
});

test('csv export keeps the expected column order', () => {
  const rows = sample.conversations.slice().sort(sortLeadRows);
  const csv = buildLeadCsv(rows);
  assert.ok(csv.startsWith('contato,chatId,interestStatus,sentiment,closedValue,openPipelineValue,evidenceSnippets,lastInteraction'));
  assert.match(csv, /Lead A/);
  assert.match(csv, /Lead B/);
});
