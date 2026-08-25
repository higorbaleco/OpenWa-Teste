import { escapeCsvCell } from './csv.ts';

export type InterestStatus = 'genuine-buyer' | 'warm' | 'cold' | 'personal';
export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface LeadConversation {
  contact: string;
  chatId: string;
  interestStatus: InterestStatus;
  sentiment: Sentiment;
  closedValue: number;
  openPipelineValue: number | null;
  evidenceSnippets: string[];
  lastInteraction: string;
}

export interface LeadWorkflowPayload {
  generatedAt?: string;
  sessionId?: string;
  sessionName?: string;
  title?: string;
  conversations: LeadConversation[];
}

export interface LeadSummary {
  total: number;
  commercialTotal: number;
  byInterest: Record<InterestStatus, number>;
  bySentiment: Record<Sentiment, number>;
  closedCount: number;
  closedTotal: number;
  averageClosedValue: number;
  openPipelineTotal: number;
}

const interestRank: Record<InterestStatus, number> = {
  'genuine-buyer': 0,
  warm: 1,
  cold: 2,
  personal: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value
      .trim()
      .replace(/\s+/g, '')
      .replace(/[R$]/gi, '')
      .replace(/\./g, '')
      .replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInterestStatus(value: unknown): InterestStatus {
  const raw = asString(value).toLowerCase().trim();
  if (raw === 'genuine-buyer' || raw === 'genuine buyer' || raw === 'buyer' || raw === 'hot') {
    return 'genuine-buyer';
  }
  if (raw === 'warm' || raw === 'warm-lead' || raw === 'warm lead') return 'warm';
  if (raw === 'cold' || raw === 'cold-lead' || raw === 'cold lead') return 'cold';
  if (raw === 'personal' || raw === 'pessoal') return 'personal';
  return 'cold';
}

function normalizeSentiment(value: unknown): Sentiment {
  const raw = asString(value).toLowerCase().trim();
  if (raw === 'positive' || raw === 'positivo') return 'positive';
  if (raw === 'negative' || raw === 'negativo') return 'negative';
  return 'neutral';
}

function normalizeEvidence(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap(item => normalizeEvidence(item))
      .map(snippet => snippet.trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|(?:\s\|\|\s)|(?:\s•\s)/)
      .map(snippet => snippet.trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  return [];
}

function normalizeConversation(value: unknown): LeadConversation | null {
  if (!isRecord(value)) return null;
  const chatId = asString(value.chatId || value.chat_id || value.id || value.jid || value.chat);
  if (!chatId) return null;
  const contact = asString(value.contact || value.name || value.phone || value.label || value.chatName || value.title);
  const evidence = normalizeEvidence(value.evidenceSnippets || value.evidence || value.snippets || value.evidence_snippet);
  const lastInteraction = asString(
    value.lastInteraction || value.last_interaction || value.lastMessageAt || value.last_message_at || value.updatedAt,
  );

  return {
    contact: contact || chatId,
    chatId,
    interestStatus: normalizeInterestStatus(value.interestStatus || value.interest_status || value.status),
    sentiment: normalizeSentiment(value.sentiment),
    closedValue: toNumber(value.closedValue || value.closed_value, 0),
    openPipelineValue: toNullableNumber(value.openPipelineValue ?? value.open_pipeline_value),
    evidenceSnippets: evidence,
    lastInteraction: lastInteraction || new Date(0).toISOString(),
  };
}

function extractConversationArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  const candidates = [raw.conversations, raw.rows, raw.data, raw.leads];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function parseLeadWorkflowInput(rawInput: string | unknown): LeadWorkflowPayload {
  const raw = typeof rawInput === 'string' ? (JSON.parse(rawInput) as unknown) : rawInput;
  const conversations = extractConversationArray(raw)
    .map(normalizeConversation)
    .filter((item): item is LeadConversation => item !== null)
    .sort(sortLeadRows);

  if (isRecord(raw)) {
    return {
      generatedAt: asString(raw.generatedAt || raw.generated_at || raw.timestamp || raw.createdAt),
      sessionId: asString(raw.sessionId || raw.session_id),
      sessionName: asString(raw.sessionName || raw.session_name),
      title: asString(raw.title),
      conversations,
    };
  }

  return { conversations };
}

export function sortLeadRows(a: LeadConversation, b: LeadConversation): number {
  const rankDelta = interestRank[a.interestStatus] - interestRank[b.interestStatus];
  if (rankDelta !== 0) return rankDelta;
  const dateDelta = new Date(b.lastInteraction).getTime() - new Date(a.lastInteraction).getTime();
  if (Number.isFinite(dateDelta) && dateDelta !== 0) return dateDelta;
  return b.closedValue - a.closedValue;
}

export function buildLeadSummary(rows: LeadConversation[]): LeadSummary {
  const summary: LeadSummary = {
    total: rows.length,
    commercialTotal: rows.filter(row => row.interestStatus !== 'personal').length,
    byInterest: {
      'genuine-buyer': 0,
      warm: 0,
      cold: 0,
      personal: 0,
    },
    bySentiment: {
      positive: 0,
      neutral: 0,
      negative: 0,
    },
    closedCount: 0,
    closedTotal: 0,
    averageClosedValue: 0,
    openPipelineTotal: 0,
  };

  for (const row of rows) {
    summary.byInterest[row.interestStatus] += 1;
    summary.bySentiment[row.sentiment] += 1;
    if (row.closedValue > 0 && row.interestStatus !== 'personal') {
      summary.closedCount += 1;
      summary.closedTotal += row.closedValue;
    }
    if (typeof row.openPipelineValue === 'number' && Number.isFinite(row.openPipelineValue)) {
      summary.openPipelineTotal += row.openPipelineValue;
    }
  }

  summary.averageClosedValue = summary.closedCount > 0 ? summary.closedTotal / summary.closedCount : 0;
  return summary;
}

function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  return value.toFixed(2);
}

export function buildLeadCsv(rows: LeadConversation[]): string {
  const headers = [
    'contato',
    'chatId',
    'interestStatus',
    'sentiment',
    'closedValue',
    'openPipelineValue',
    'evidenceSnippets',
    'lastInteraction',
  ];
  const lines = rows.map(row =>
    [
      row.contact,
      row.chatId,
      row.interestStatus,
      row.sentiment,
      formatMoney(row.closedValue),
      formatMoney(row.openPipelineValue),
      row.evidenceSnippets.join(' || '),
      row.lastInteraction,
    ]
      .map(escapeCsvCell)
      .join(','),
  );
  return [headers.join(','), ...lines].join('\n');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function buildLeadReportHtml(payload: LeadWorkflowPayload, summary: LeadSummary): string {
  const report = {
    payload,
    summary,
    generatedAt: new Date().toISOString(),
  };
  const dataScript = safeJson(report);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Relatório de Leads</title>
  <style>
    body { font-family: Georgia, serif; margin: 0; padding: 24px; background: #081014; color: #eff5ef; }
    .wrap { max-width: 1180px; margin: 0 auto; }
    .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); border-radius: 18px; padding: 18px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 14px; }
    .metric .label { color: #a8b7ad; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.12em; }
    .metric .value { font-size: 1.5rem; margin-top: 8px; font-weight: 700; }
    .row { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr; gap: 10px; margin: 12px 0; }
    input, select { width: 100%; padding: 11px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.18); color: inherit; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; vertical-align: top; }
    th { color: #a8b7ad; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.12em; }
    .pill { display: inline-flex; padding: 5px 9px; border-radius: 999px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; }
    .genuine-buyer { background: rgba(135, 241, 139, 0.12); color: #baf8bd; }
    .warm { background: rgba(246, 193, 119, 0.12); color: #ffe1b1; }
    .cold { background: rgba(255, 255, 255, 0.08); color: #d0dad3; }
    .personal { background: rgba(158, 178, 255, 0.12); color: #d1dcff; }
    .muted { color: #a8b7ad; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 style="margin:0 0 8px;font-size:clamp(2rem,4vw,3.4rem);line-height:1;">Relatório de Leads</h1>
      <p class="muted" style="margin:0;max-width:72ch;line-height:1.6;">
        HTML autônomo para revisão e compartilhamento. Os valores em R$ são estimativas inferidas do texto e não dados contábeis confirmados.
      </p>
    </div>
    <div class="grid" id="metrics"></div>
    <div class="card">
      <div class="row">
        <input id="search" type="search" placeholder="Buscar contato, chatId ou trecho" />
        <select id="interest"></select>
        <select id="sentiment"></select>
        <select id="scope">
          <option value="all">Todos</option>
          <option value="commercial">Somente comerciais</option>
          <option value="personal">Somente pessoais</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>Contato</th><th>ChatId</th><th>Status</th><th>Sentimento</th><th>Fechado</th><th>Pipeline</th><th>Evidências</th><th>Última interação</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>
  <script id="report-data" type="application/json">${dataScript}</script>
  <script>
    const report = JSON.parse(document.getElementById('report-data').textContent || '{}');
    const rows = (report.payload && report.payload.conversations) || [];
    const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const interestOrder = ['all', 'genuine-buyer', 'warm', 'cold', 'personal'];
    const sentimentOrder = ['all', 'positive', 'neutral', 'negative'];
    const els = {
      metrics: document.getElementById('metrics'),
      tbody: document.getElementById('tbody'),
      search: document.getElementById('search'),
      interest: document.getElementById('interest'),
      sentiment: document.getElementById('sentiment'),
      scope: document.getElementById('scope'),
    };
    const state = { q: '', interest: 'all', sentiment: 'all', scope: 'all' };

    function escapeHtml(value) {
      return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtMoney(value) {
      return Number.isFinite(value) && value > 0 ? currency.format(value) : '—';
    }

    function fmtDate(value) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
    }

    function summarize(list) {
      const s = { total: list.length, closed: 0, closedTotal: 0, openTotal: 0, hot: 0 };
      for (const row of list) {
        if (row.interestStatus === 'genuine-buyer') s.hot += 1;
        if (row.closedValue > 0 && row.interestStatus !== 'personal') {
          s.closed += 1;
          s.closedTotal += row.closedValue;
        }
        if (typeof row.openPipelineValue === 'number' && Number.isFinite(row.openPipelineValue)) s.openTotal += row.openPipelineValue;
      }
      return s;
    }

    function filteredRows() {
      const q = state.q.trim().toLowerCase();
      return rows.filter(row => {
        if (state.interest !== 'all' && row.interestStatus !== state.interest) return false;
        if (state.sentiment !== 'all' && row.sentiment !== state.sentiment) return false;
        if (state.scope === 'commercial' && row.interestStatus === 'personal') return false;
        if (state.scope === 'personal' && row.interestStatus !== 'personal') return false;
        if (!q) return true;
        const haystack = [row.contact, row.chatId, row.interestStatus, row.sentiment, (row.evidenceSnippets || []).join(' ')].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    function render() {
      const s = summarize(filteredRows());
      els.metrics.innerHTML = [
        ['Total', s.total, 'Conversas carregadas'],
        ['Leads quentes', s.hot, 'Interest status genuine-buyer'],
        ['Fechados', currency.format(s.closedTotal), String(s.closed) + ' negócios'],
        ['Pipeline aberto', currency.format(s.openTotal), 'Estimativa futura'],
      ].map(item => '<div class="metric"><div class="label">' + item[0] + '</div><div class="value">' + item[1] + '</div><div class="muted">' + item[2] + '</div></div>').join('');

      const list = filteredRows();
      els.tbody.innerHTML = list.length ? list.map(row => '<tr>'
        + '<td><strong>' + escapeHtml(row.contact || '—') + '</strong></td>'
        + '<td>' + escapeHtml(row.chatId) + '</td>'
        + '<td><span class="pill ' + row.interestStatus + '">' + escapeHtml(row.interestStatus) + '</span></td>'
        + '<td>' + escapeHtml(row.sentiment) + '</td>'
        + '<td>' + fmtMoney(row.closedValue) + '</td>'
        + '<td>' + fmtMoney(row.openPipelineValue) + '</td>'
        + '<td>' + escapeHtml((row.evidenceSnippets || []).join(' · ') || '—') + '</td>'
        + '<td>' + escapeHtml(fmtDate(row.lastInteraction)) + '</td>'
        + '</tr>').join('') : '<tr><td class="muted" colspan="8" style="padding:24px;">Nenhuma conversa para os filtros atuais.</td></tr>';
    }

    els.interest.innerHTML = interestOrder.map(v => '<option value="' + v + '">' + (v === 'all' ? 'Todos' : v) + '</option>').join('');
    els.sentiment.innerHTML = sentimentOrder.map(v => '<option value="' + v + '">' + (v === 'all' ? 'Todos' : v) + '</option>').join('');
    els.search.addEventListener('input', e => { state.q = e.target.value; render(); });
    els.interest.addEventListener('change', e => { state.interest = e.target.value; render(); });
    els.sentiment.addEventListener('change', e => { state.sentiment = e.target.value; render(); });
    els.scope.addEventListener('change', e => { state.scope = e.target.value; render(); });
    render();
  </script>
</body>
</html>`;
  /*

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Relatório de Leads</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1014;
      --panel: rgba(18, 24, 30, 0.82);
      --text: #f3f7f4;
      --muted: #9aa8a0;
      --line: rgba(255, 255, 255, 0.08);
      --accent: #87f18b;
      --accent-2: #f6c177;
      --danger: #ff6b6b;
      --shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      font-family: "Georgia", "Times New Roman", serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(135, 241, 139, 0.14), transparent 30%),
        radial-gradient(circle at top right, rgba(246, 193, 119, 0.1), transparent 22%),
        linear-gradient(180deg, #071015, #0b1014 35%, #06090c);
      min-height: 100vh;
    }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 32px 18px 44px; }
    .hero {
      display: grid;
      gap: 18px;
      grid-template-columns: 1.4fr 1fr;
      align-items: stretch;
      margin-bottom: 20px;
    }
    .title-card, .side-card, .panel, .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    .title-card {
      position: relative;
      overflow: hidden;
      padding: 28px;
      border-radius: 28px;
    }
    .title-card:before {
      content: "";
      position: absolute;
      inset: -40% auto auto 65%;
      width: 360px;
      height: 360px;
      background: radial-gradient(circle, rgba(135, 241, 139, 0.22), transparent 65%);
      filter: blur(12px);
      pointer-events: none;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--accent);
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(2.4rem, 6vw, 4.75rem);
      line-height: 0.95;
      letter-spacing: -0.05em;
      max-width: 12ch;
    }
    .lede {
      margin: 0;
      font-family: "Inter", "Segoe UI", sans-serif;
      color: #d6dfd7;
      max-width: 68ch;
      font-size: 1rem;
      line-height: 1.7;
    }
    .side-card {
      border-radius: 28px;
      padding: 24px;
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .side-card h2 {
      margin: 0;
      font-size: 1.05rem;
      letter-spacing: -0.03em;
    }
    .side-card p, .hint, .warning {
      font-family: "Inter", "Segoe UI", sans-serif;
      color: var(--muted);
      margin: 0;
      line-height: 1.6;
      font-size: 0.94rem;
    }
    .warning {
      color: #f4d49f;
      background: rgba(246, 193, 119, 0.08);
      border: 1px solid rgba(246, 193, 119, 0.14);
      padding: 12px 14px;
      border-radius: 16px;
    }
    .controls {
      display: grid;
      gap: 14px;
      grid-template-columns: 1.4fr 0.8fr;
      margin: 20px 0;
    }
    .editor, .panel {
      border-radius: 24px;
      padding: 18px;
    }
    .editor textarea {
      width: 100%;
      min-height: 280px;
      resize: vertical;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: rgba(8, 11, 14, 0.55);
      color: var(--text);
      padding: 16px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.6;
      outline: none;
    }
    .editor textarea:focus { border-color: rgba(135, 241, 139, 0.45); }
    .button-row, .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    button {
      font: inherit;
      border: none;
      border-radius: 999px;
      padding: 11px 15px;
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
    }
    button:hover { transform: translateY(-1px); }
    .primary {
      background: linear-gradient(135deg, var(--accent), #d7ffb2);
      color: #08110a;
      box-shadow: 0 12px 24px rgba(135, 241, 139, 0.18);
      font-weight: 700;
    }
    .secondary {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text);
      border: 1px solid var(--line);
    }
    .ghost {
      background: transparent;
      color: var(--muted);
      border: 1px dashed var(--line);
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .metric {
      border-radius: 20px;
      padding: 16px;
      min-height: 110px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .metric .label {
      font-family: "Inter", "Segoe UI", sans-serif;
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
    }
    .metric .value {
      margin-top: 10px;
      font-size: 1.6rem;
      letter-spacing: -0.04em;
      font-weight: 700;
    }
    .metric .detail {
      margin-top: 8px;
      font-family: "Inter", "Segoe UI", sans-serif;
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.5;
    }
    .toolbar {
      display: grid;
      grid-template-columns: 1.1fr repeat(3, minmax(0, 0.65fr));
      gap: 12px;
      margin: 18px 0 16px;
      align-items: end;
    }
    .field {
      display: grid;
      gap: 8px;
    }
    .field label {
      font-family: "Inter", "Segoe UI", sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.7rem;
      color: var(--muted);
    }
    .field input, .field select {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(8, 11, 14, 0.55);
      color: var(--text);
      padding: 12px 14px;
      outline: none;
      font: inherit;
      font-family: "Inter", "Segoe UI", sans-serif;
    }
    .panel .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .panel h2 {
      margin: 0;
      font-size: 1.05rem;
    }
    .table-wrap {
      overflow-x: auto;
      border-radius: 18px;
      border: 1px solid var(--line);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1100px;
      background: rgba(9, 12, 15, 0.5);
    }
    thead th {
      position: sticky;
      top: 0;
      background: rgba(15, 20, 25, 0.96);
      font-family: "Inter", "Segoe UI", sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.68rem;
      color: #afbab1;
      text-align: left;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }
    tbody td {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      vertical-align: top;
      font-family: "Inter", "Segoe UI", sans-serif;
      color: #edf4ef;
      font-size: 0.92rem;
    }
    tbody tr:hover { background: rgba(135, 241, 139, 0.05); }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
    }
    .genuine-buyer { background: rgba(135, 241, 139, 0.12); color: #baf8bd; }
    .warm { background: rgba(246, 193, 119, 0.12); color: #ffe1b1; }
    .cold { background: rgba(255, 255, 255, 0.06); color: #d0dad3; }
    .personal { background: rgba(158, 178, 255, 0.12); color: #d1dcff; }
    .positive { color: #9ef0a1; }
    .neutral { color: #e5e2cf; }
    .negative { color: #ff9d9d; }
    .snippet {
      color: #c3cdc6;
      max-width: 52ch;
      white-space: pre-wrap;
      line-height: 1.55;
    }
    .money { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .empty {
      padding: 42px 16px;
      text-align: center;
      color: var(--muted);
      font-family: "Inter", "Segoe UI", sans-serif;
    }
    @media (max-width: 1100px) {
      .hero, .controls, .toolbar, .meta-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .wrap { padding: 18px 12px 32px; }
      .title-card, .side-card, .panel, .editor, .metric { border-radius: 20px; }
      h1 { max-width: none; }
      .button-row { flex-direction: column; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="title-card">
        <div class="eyebrow">Workflow de leads · HTML autônomo</div>
        <h1>Relatório editorial para conversa, sinais e dinheiro em jogo.</h1>
        <p class="lede">
          Este documento reúne as conversas classificadas pelo workflow, destaca os leads mais quentes,
          separa o que é pessoal do que é comercial e exporta tudo em CSV. Os valores em R$ são
          estimativas inferidas do texto e não representam contabilidade confirmada.
        </p>
        <div class="meta-grid" id="meta-grid"></div>
      </div>
      <aside class="side-card">
        <h2>Como usar</h2>
        <p>Abra o dashboard, cole o JSON do workflow ou carregue um arquivo .json com o payload.</p>
        <p>Depois, filtre por status, sentimento ou termo. O relatório pode ser baixado em HTML ou CSV.</p>
        <div class="warning">Aviso visível: os valores em R$ são estimados a partir do texto das mensagens.</div>
      </aside>
    </section>

    <section class="controls">
      <div class="editor">
        <div class="panel-head">
          <h2>Entrada do workflow</h2>
          <div class="button-row">
            <button class="secondary" id="load-example">Carregar exemplo</button>
            <button class="secondary" id="pick-file">Abrir arquivo</button>
            <button class="primary" id="parse-json">Interpretar JSON</button>
          </div>
        </div>
        <textarea id="input" spellcheck="false" placeholder='Cole aqui o JSON do workflow ou um array de conversas.'></textarea>
        <p class="hint" id="status">Aguardando entrada.</p>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Exportação</h2>
        </div>
        <div class="button-row">
          <button class="primary" id="download-csv" disabled>Baixar CSV</button>
          <button class="secondary" id="download-html" disabled>Baixar HTML</button>
        </div>
        <div class="meta-grid" id="summary-grid"></div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Leads</h2>
        <div class="chip-row" id="filter-chips"></div>
      </div>
      <div class="toolbar">
        <div class="field">
          <label for="search">Buscar</label>
          <input id="search" type="search" placeholder="Nome, chatId, trecho..." />
        </div>
        <div class="field">
          <label for="interest">Interest status</label>
          <select id="interest"></select>
        </div>
        <div class="field">
          <label for="sentiment">Sentimento</label>
          <select id="sentiment"></select>
        </div>
        <div class="field">
          <label for="commercial">Escopo</label>
          <select id="commercial">
            <option value="all">Todos</option>
            <option value="commercial">Somente comerciais</option>
            <option value="personal">Somente pessoais</option>
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contato</th>
              <th>Chat</th>
              <th>Status</th>
              <th>Sentimento</th>
              <th>Fechado</th>
              <th>Pipeline</th>
              <th>Evidências</th>
              <th>Última interação</th>
            </tr>
          </thead>
          <tbody id="table-body">
            <tr><td class="empty" colspan="8">Nenhum dado carregado ainda.</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <input id="file" type="file" accept=".json,application/json" hidden />
  <script>
    const __DATA__ = ${dataScript};
    const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
    const state = {
      rows: __DATA__.payload.conversations || [],
      filters: { q: '', interest: 'all', sentiment: 'all', commercial: 'all' },
    };

    const els = {
      metaGrid: document.getElementById('meta-grid'),
      summaryGrid: document.getElementById('summary-grid'),
      tableBody: document.getElementById('table-body'),
      input: document.getElementById('input'),
      status: document.getElementById('status'),
      search: document.getElementById('search'),
      interest: document.getElementById('interest'),
      sentiment: document.getElementById('sentiment'),
      commercial: document.getElementById('commercial'),
      file: document.getElementById('file'),
      loadExample: document.getElementById('load-example'),
      pickFile: document.getElementById('pick-file'),
      parseJson: document.getElementById('parse-json'),
      downloadCsv: document.getElementById('download-csv'),
      downloadHtml: document.getElementById('download-html'),
      filterChips: document.getElementById('filter-chips'),
    };

    const example = {
      generatedAt: new Date().toISOString(),
      sessionName: 'higor-mago',
      conversations: [
        {
          contact: 'Cliente A',
          chatId: '5511999999999@lid',
          interestStatus: 'genuine-buyer',
          sentiment: 'positive',
          closedValue: 18000,
          openPipelineValue: 24000,
          evidenceSnippets: ['“Pode me mandar a proposta hoje?”', '“Fechamos por R$ 18 mil.”'],
          lastInteraction: new Date().toISOString(),
        },
        {
          contact: 'Amigo B',
          chatId: '5511888888888@lid',
          interestStatus: 'personal',
          sentiment: 'neutral',
          closedValue: 0,
          openPipelineValue: null,
          evidenceSnippets: ['“Vamos marcar o churrasco?”'],
          lastInteraction: new Date().toISOString(),
        },
      ],
    };

    function fmtMoney(value) {
      return Number.isFinite(value) && value > 0 ? currency.format(value) : '—';
    }

    function fmtDate(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '—' : dateFmt.format(date);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function buildCsv(rows) {
      const headers = ['contato', 'chatId', 'interestStatus', 'sentiment', 'closedValue', 'openPipelineValue', 'evidenceSnippets', 'lastInteraction'];
      const lines = rows.map(row => [
        row.contact,
        row.chatId,
        row.interestStatus,
        row.sentiment,
        row.closedValue ?? '',
        row.openPipelineValue ?? '',
        (row.evidenceSnippets || []).join(' || '),
        row.lastInteraction || '',
      ].map(cell => {
        let s = cell === undefined || cell === null ? '' : String(cell);
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
      return [headers.join(','), ...lines].join('\n');
    }

    function buildHtml(rows, summary) {
      const data = {
        payload: { conversations: rows },
        summary,
        generatedAt: new Date().toISOString(),
      };
      return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Relatório de Leads</title>
  <style>${document.querySelector('style').textContent}</style>
</head>
<body>
  <script>window.__LEADS_REPORT__ = ${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
  <script>
    const report = window.__LEADS_REPORT__;
    document.body.innerHTML = '<pre style="white-space:pre-wrap;color:#fff;padding:24px;font:16px/1.6 Georgia,serif;">Relatório exportado com ' + report.payload.conversations.length + ' conversas.</pre>';
  </script>
</body>
</html>`;
    }

    function summarize(rows) {
      const summary = {
        total: rows.length,
        commercialTotal: rows.filter(row => row.interestStatus !== 'personal').length,
        byInterest: { 'genuine-buyer': 0, warm: 0, cold: 0, personal: 0 },
        bySentiment: { positive: 0, neutral: 0, negative: 0 },
        closedCount: 0,
        closedTotal: 0,
        averageClosedValue: 0,
        openPipelineTotal: 0,
      };
      for (const row of rows) {
        summary.byInterest[row.interestStatus] += 1;
        summary.bySentiment[row.sentiment] += 1;
        if (row.closedValue > 0 && row.interestStatus !== 'personal') {
          summary.closedCount += 1;
          summary.closedTotal += row.closedValue;
        }
        if (typeof row.openPipelineValue === 'number') summary.openPipelineTotal += row.openPipelineValue;
      }
      summary.averageClosedValue = summary.closedCount ? summary.closedTotal / summary.closedCount : 0;
      return summary;
    }

    function renderCards(summary) {
      const metrics = [
        { label: 'Total de conversas', value: summary.total, detail: `${summary.commercialTotal} comerciais` },
        { label: 'Leads quentes', value: summary.byInterest['genuine-buyer'] },
        { label: 'Leads mornos', value: summary.byInterest.warm },
        { label: 'Leads frios', value: summary.byInterest.cold },
        { label: 'Valores fechados', value: currency.format(summary.closedTotal), detail: `${summary.closedCount} negócios` },
        { label: 'Pipeline aberto', value: currency.format(summary.openPipelineTotal), detail: 'Estimativa futura' },
      ];
      els.metaGrid.innerHTML = metrics.map(metric => `
        <article class="metric">
          <div class="label">${metric.label}</div>
          <div class="value">${metric.value}</div>
          <div class="detail">${metric.detail || ''}</div>
        </article>
      `).join('');
      els.summaryGrid.innerHTML = [
        { label: 'Fechado médio', value: currency.format(summary.averageClosedValue) },
        { label: 'Positivas', value: summary.bySentiment.positive },
        { label: 'Neutras', value: summary.bySentiment.neutral },
        { label: 'Negativas', value: summary.bySentiment.negative },
      ].map(metric => `
        <article class="metric">
          <div class="label">${metric.label}</div>
          <div class="value">${metric.value}</div>
        </article>
      `).join('');
    }

    function renderFilters() {
      els.interest.innerHTML = ['all', 'genuine-buyer', 'warm', 'cold', 'personal'].map(value => `
        <option value="${value}">${value === 'all' ? 'Todos' : value}</option>
      `).join('');
      els.sentiment.innerHTML = ['all', 'positive', 'neutral', 'negative'].map(value => `
        <option value="${value}">${value === 'all' ? 'Todos' : value}</option>
      `).join('');
      els.filterChips.innerHTML = [
        ['genuine-buyer', 'Buyer'],
        ['warm', 'Warm'],
        ['cold', 'Cold'],
        ['personal', 'Personal'],
      ].map(([value, label]) => `<span class="pill ${value}">${label}</span>`).join('');
    }

    function filteredRows() {
      const q = state.filters.q.trim().toLowerCase();
      return state.rows.filter(row => {
        if (state.filters.interest !== 'all' && row.interestStatus !== state.filters.interest) return false;
        if (state.filters.sentiment !== 'all' && row.sentiment !== state.filters.sentiment) return false;
        if (state.filters.commercial === 'commercial' && row.interestStatus === 'personal') return false;
        if (state.filters.commercial === 'personal' && row.interestStatus !== 'personal') return false;
        if (!q) return true;
        const haystack = [
          row.contact,
          row.chatId,
          row.interestStatus,
          row.sentiment,
          (row.evidenceSnippets || []).join(' '),
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    function renderTable() {
      const rows = filteredRows();
      if (!rows.length) {
        els.tableBody.innerHTML = '<tr><td class="empty" colspan="8">Nenhuma conversa para os filtros atuais.</td></tr>';
        return;
      }
      els.tableBody.innerHTML = rows.map(row => `
        <tr>
          <td>${escapeHtml(row.contact || '—')}</td>
          <td>${escapeHtml(row.chatId)}</td>
          <td><span class="pill ${row.interestStatus}">${escapeHtml(row.interestStatus)}</span></td>
          <td class="${row.sentiment}">${escapeHtml(row.sentiment)}</td>
          <td class="money">${fmtMoney(row.closedValue)}</td>
          <td class="money">${fmtMoney(row.openPipelineValue)}</td>
          <td class="snippet">${escapeHtml((row.evidenceSnippets || []).join(' · ') || '—')}</td>
          <td>${escapeHtml(fmtDate(row.lastInteraction))}</td>
        </tr>
      `).join('');
    }

    function updateExportButtons() {
      const enabled = state.rows.length > 0;
      els.downloadCsv.disabled = !enabled;
      els.downloadHtml.disabled = !enabled;
    }

    function applyRows(rows, meta = 'JSON interpretado com sucesso.') {
      state.rows = rows.slice().sort((a, b) => {
        const order = { 'genuine-buyer': 0, warm: 1, cold: 2, personal: 3 };
        const rank = order[a.interestStatus] - order[b.interestStatus];
        if (rank !== 0) return rank;
        return new Date(b.lastInteraction).getTime() - new Date(a.lastInteraction).getTime();
      });
      const summary = summarize(state.rows);
      renderCards(summary);
      renderTable();
      updateExportButtons();
      els.status.textContent = `${meta} ${state.rows.length} conversas carregadas.`;
    }

    function parseTextarea() {
      try {
        const parsed = JSON.parse(els.input.value);
        const payload = Array.isArray(parsed) ? { conversations: parsed } : parsed;
        const rows = (payload.conversations || payload.rows || payload.data || []).map(row => ({
          contact: row.contact || row.name || row.phone || row.chatName || row.label || row.chatId,
          chatId: row.chatId || row.id || row.jid || '',
          interestStatus: row.interestStatus || row.status || 'cold',
          sentiment: row.sentiment || 'neutral',
          closedValue: Number(row.closedValue || row.closed_value || 0),
          openPipelineValue: row.openPipelineValue ?? row.open_pipeline_value ?? null,
          evidenceSnippets: Array.isArray(row.evidenceSnippets) ? row.evidenceSnippets : (row.evidence ? [String(row.evidence)] : []),
          lastInteraction: row.lastInteraction || row.last_interaction || row.updatedAt || new Date(0).toISOString(),
        })).filter(row => row.chatId);
        if (!rows.length) throw new Error('O JSON não contém conversas reconhecíveis.');
        applyRows(rows, 'Dados carregados.');
      } catch (error) {
        els.status.textContent = error instanceof Error ? error.message : 'Não foi possível interpretar o JSON.';
      }
    }

    function download(name, content, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }

    els.search.addEventListener('input', event => {
      state.filters.q = event.target.value;
      renderTable();
    });
    els.interest.addEventListener('change', event => {
      state.filters.interest = event.target.value;
      renderTable();
    });
    els.sentiment.addEventListener('change', event => {
      state.filters.sentiment = event.target.value;
      renderTable();
    });
    els.commercial.addEventListener('change', event => {
      state.filters.commercial = event.target.value;
      renderTable();
    });
    els.loadExample.addEventListener('click', () => {
      els.input.value = JSON.stringify(example, null, 2);
      els.status.textContent = 'Exemplo carregado. Clique em "Interpretar JSON".';
    });
    els.pickFile.addEventListener('click', () => els.file.click());
    els.file.addEventListener('change', async () => {
      const file = els.file.files && els.file.files[0];
      if (!file) return;
      els.input.value = await file.text();
      els.status.textContent = `Arquivo "${file.name}" carregado.`;
    });
    els.parseJson.addEventListener('click', parseTextarea);
    els.downloadCsv.addEventListener('click', () => {
      download('relatorio-leads.csv', buildCsv(state.rows), 'text/csv;charset=utf-8;');
    });
    els.downloadHtml.addEventListener('click', () => {
      const summary = summarize(state.rows);
      download('relatorio-leads.html', buildHtml(state.rows, summary), 'text/html;charset=utf-8;');
    });

    renderFilters();
    const initialSummary = summarize(state.rows);
    renderCards(initialSummary);
    renderTable();
    updateExportButtons();
  </script>
</body>
</html>`;
*/
}
