#!/usr/bin/env node

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SESSION_ID = '8df95b4d-18bf-4faf-a81b-765800de0979';
const DEFAULT_DB_PATH = 'data/openwa.sqlite';
const DEFAULT_OUTPUT_ROOT = process.env.LEADS_OUTPUT_ROOT || 'artifacts/leads-report';

const sessionId = process.env.LEADS_SESSION_ID || DEFAULT_SESSION_ID;
const dbPath = process.env.LEADS_DB_PATH || DEFAULT_DB_PATH;
const windowDays = parseInt(process.env.LEADS_DAYS || '', 10);
const rawLimit = process.env.LEADS_LIMIT ? parseInt(process.env.LEADS_LIMIT, 10) : Number.NaN;
const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 1000;
const now = process.env.LEADS_NOW ? new Date(process.env.LEADS_NOW) : new Date();
const cutoffSec = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor((now.getTime() - windowDays * 24 * 60 * 60 * 1000) / 1000) : null;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function escapeCsvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toIso(timestamp) {
  if (!Number.isFinite(timestamp)) return new Date(0).toISOString();
  return new Date(timestamp * 1000).toISOString();
}

function formatMoney(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value.toFixed(2);
}

function textScore(text, patterns) {
  const normalized = normalizeText(text);
  let score = 0;
  for (const { pattern, weight } of patterns) {
    if (pattern.test(normalized)) score += weight;
  }
  return score;
}

function detectSentiment(messages) {
  const positivePatterns = [
    /\b(top|beleza|perfeito|otimo|ótimo|obrigado|valeu|fechou|bora|vamos|show|maravilha|gostei|sim)\b/,
    /!{2,}/,
    /😊|😄|😁|🙏|👍|🔥/,
  ];
  const negativePatterns = [
    /\b(nao|não|caro|ruim|problema|cancelar|parar|desaparecer|desaprendeu|erro|pior|saturou|reclama|reclamação)\b/,
  ];

  let positive = 0;
  let negative = 0;
  for (const message of messages) {
    const normalized = normalizeText(message.body);
    if (!normalized) continue;
    positive += textScore(normalized, positivePatterns.map(pattern => ({ pattern, weight: 1 })));
    negative += textScore(normalized, negativePatterns.map(pattern => ({ pattern, weight: 1 })));
  }

  if (negative > positive && negative > 0) return 'negative';
  if (positive > 0) return 'positive';
  return 'neutral';
}

function detectInterest(messages) {
  const commercial = [
    { pattern: /\b(proposta|orcamento|orçamento|valor|preco|preço|custo|quanto custa|quanto fica|investimento|taxa|mensalidade|prazo|escopo)\b/, weight: 2 },
    { pattern: /\b(contratar|quero|preciso|interesse|agendar|call|reuniao|reunião|fechar|fechado|fechamos|pix|pagamento)\b/, weight: 3 },
    { pattern: /\b(manda a proposta|me manda|pode mandar|vamos fechar|vamos fazer|vamos seguir)\b/, weight: 3 },
    { pattern: /\b(cotacao|cotação|budget|orc|orç)\b/, weight: 2 },
    { pattern: /\b(\d+\s*k|\d+k|r\$\s*\d)/, weight: 1 },
  ];
  const personal = [
    { pattern: /\b(almoco|almoço|sabado|sábado|saudade|amiga|amigo|familia|familia|filho|filha|esposa|marcar|casa|vinho|aniversario|aniversário)\b/, weight: 3 },
    { pattern: /\b(bra(?=nda)|vi falou|vou ter que|nao vem|não vem|cansada|vitamina|ferro|pancada|grupo)\b/, weight: 2 },
    { pattern: /\b(lead|campanha|anuncio|anuncio|anuncio|anuncio|ads|mkt|marketing|criativo|saturou)\b/, weight: 1 },
  ];

  let commercialScore = 0;
  let personalScore = 0;
  let closeSignals = 0;

  for (const message of messages) {
    const normalized = normalizeText(message.body);
    if (!normalized) continue;
    commercialScore += textScore(normalized, commercial);
    personalScore += textScore(normalized, personal);
    if (/\b(fechamos|fechado|fechar|pix|pagamento|contrato|assinad|pago|paguei|confirmado|mandar a proposta)\b/.test(normalized)) {
      closeSignals += 1;
    }
  }

  if (personalScore >= 3 && commercialScore < 2) return 'personal';
  if (closeSignals > 0 || commercialScore >= 4) return 'genuine-buyer';
  if (commercialScore >= 1) return 'warm';
  return 'cold';
}

function parseNumericToken(rawValue, scaleToken = '') {
  const normalized = String(rawValue)
    .trim()
    .replace(/\s+/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;

  const scale = normalizeText(scaleToken);
  if (scale.startsWith('milhao')) return number * 1_000_000;
  if (scale === 'mil' || scale === 'k') return number * 1_000;
  return number;
}

function extractAmounts(text) {
  const amounts = [];
  const source = String(text || '');
  const patterns = [
    /R\$\s*([\d.]+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*(milh[oã]es?|mil|k)?/gi,
    /\b([\d.]+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*(milh[oã]es?|mil|k)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = parseNumericToken(match[1], match[2] || '');
      if (value !== null) amounts.push(value);
    }
  }

  return amounts;
}

function extractValues(messages, interestStatus) {
  if (interestStatus === 'personal') {
    return { closedValue: 0, openPipelineValue: null };
  }

  let closedValue = 0;
  let openPipelineValue = null;

  for (const message of messages) {
    const text = message.body || '';
    const normalized = normalizeText(text);
    if (!normalized) continue;

    const amounts = extractAmounts(text);
    if (!amounts.length) continue;

    const hasCloseContext = /\b(fech|fechado|fechamos|pag|pix|contrat|assin|confirmad|quitad|caiu|transfer)\b/.test(normalized);
    const hasOpenContext = /\b(valor|preco|preço|orc|orç|proposta|investimento|custo|quanto|orçamento|orcamento|budget|mensal|parcela)\b/.test(normalized);

    const topAmount = Math.max(...amounts);
    if (hasCloseContext) {
      closedValue = Math.max(closedValue, topAmount);
      continue;
    }

    if (hasOpenContext) {
      openPipelineValue = openPipelineValue === null ? topAmount : Math.max(openPipelineValue, topAmount);
    }
  }

  return { closedValue, openPipelineValue };
}

function scoreConversation(messages, interestStatus, sentiment, closedValue, openPipelineValue) {
  const commercialPatterns = [
    /\b(proposta|orcamento|orçamento|valor|preco|preço|custo|quanto|investimento|taxa|mensalidade|prazo|escopo|fech|pix|pagamento|contrat)\b/,
    /\b(\d+\s*k|\d+k|r\$\s*\d)/,
  ];
  const personalPatterns = [
    /\b(almoco|almoço|sabado|sábado|saudade|amiga|amigo|familia|filho|filha|esposa|marcar|casa|vinho|aniversario|aniversário)\b/,
    /\b(lead|campanha|anuncio|ads|mkt|marketing|criativo|saturou)\b/,
  ];

  let score = 0;
  for (const message of messages) {
    const normalized = normalizeText(message.body);
    if (!normalized) continue;
    if (commercialPatterns.some(pattern => pattern.test(normalized))) score += 4;
    if (/\?/.test(normalized)) score += 1;
    if (personalPatterns.some(pattern => pattern.test(normalized))) score -= 3;
    if (/\b(obrigado|valeu|top|beleza|fechou|sim|vamos|perfeito|otimo|ótimo)\b/.test(normalized)) score += 1;
  }

  if (interestStatus === 'genuine-buyer') score += 25;
  if (interestStatus === 'warm') score += 12;
  if (interestStatus === 'cold') score += 3;
  if (sentiment === 'positive') score += 4;
  if (sentiment === 'negative') score -= 2;
  if (closedValue > 0) score += 35;
  if (openPipelineValue && openPipelineValue > 0) score += 20;
  score += Math.min(messages.length, 12);
  return score;
}

function pickEvidenceSnippets(messages, interestStatus) {
  const snippets = [];
  const interestingPatterns = [
    /\b(proposta|orçamento|orcamento|valor|preco|preço|quanto|investimento|fech|pag|pix|contrat|quero|preciso|interesse|call|agendar)\b/i,
    /\b(top|beleza|otimo|ótimo|fechou|vamos|sim|ok|obrigado|valeu)\b/i,
  ];

  for (const message of messages) {
    const text = String(message.body || '').trim();
    if (!text) continue;
    if (interestingPatterns.some(pattern => pattern.test(text))) {
      snippets.push(text.length > 150 ? `${text.slice(0, 147)}...` : text);
    }
    if (snippets.length >= 3) break;
  }

  if (!snippets.length) {
    for (const message of messages) {
      const text = String(message.body || '').trim();
      if (!text) continue;
      snippets.push(text.length > 150 ? `${text.slice(0, 147)}...` : text);
      if (snippets.length >= 2) break;
    }
  }

  if (interestStatus === 'personal' && snippets.length === 0) {
    const first = messages.find(message => String(message.body || '').trim())?.body;
    if (first) snippets.push(String(first).slice(0, 150));
  }

  return snippets.slice(0, 3);
}

function classifyConversation(messages) {
  const interestStatus = detectInterest(messages);
  const sentiment = detectSentiment(messages);
  const { closedValue, openPipelineValue } = extractValues(messages, interestStatus);
  const evidenceSnippets = pickEvidenceSnippets(messages, interestStatus);
  const leadScore = scoreConversation(messages, interestStatus, sentiment, closedValue, openPipelineValue);
  const lastMessage = messages[messages.length - 1];

  const contact = messages.find(message => String(message.chatName || '').trim())?.chatName || lastMessage?.chatId || 'Desconhecido';

  return {
    contact,
    chatId: lastMessage?.chatId || '',
    interestStatus,
    sentiment,
    closedValue,
    openPipelineValue,
    evidenceSnippets,
    lastInteraction: toIso(lastMessage?.timestamp || 0),
    messageCount: messages.length,
    nonEmptyMessageCount: messages.filter(message => String(message.body || '').trim()).length,
    leadScore,
  };
}

function buildSummary(rows) {
  const byInterest = {
    'genuine-buyer': 0,
    warm: 0,
    cold: 0,
    personal: 0,
  };
  const bySentiment = { positive: 0, neutral: 0, negative: 0 };
  let closedCount = 0;
  let closedTotal = 0;
  let openPipelineTotal = 0;

  for (const row of rows) {
    byInterest[row.interestStatus] += 1;
    bySentiment[row.sentiment] += 1;
    if (row.closedValue > 0 && row.interestStatus !== 'personal') {
      closedCount += 1;
      closedTotal += row.closedValue;
    }
    if (Number.isFinite(row.openPipelineValue)) {
      openPipelineTotal += row.openPipelineValue || 0;
    }
  }

  return {
    total: rows.length,
    commercialTotal: rows.filter(row => row.interestStatus !== 'personal').length,
    byInterest,
    bySentiment,
    closedCount,
    closedTotal,
    averageClosedValue: closedCount > 0 ? closedTotal / closedCount : 0,
    openPipelineTotal,
  };
}

function buildCsv(rows) {
  const headers = [
    'contato',
    'chatId',
    'messageCount',
    'nonEmptyMessageCount',
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
      row.messageCount,
      row.nonEmptyMessageCount,
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

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildHtml(report) {
  const { payload, summary } = report;
  const htmlData = safeJson(report);
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Relatorio de Leads</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: radial-gradient(circle at top, #17303a, #081014 55%, #04070a); color: #edf4ee; }
    .wrap { max-width: 1280px; margin: 0 auto; padding: 28px; }
    .hero, .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); backdrop-filter: blur(14px); box-shadow: 0 20px 70px rgba(0,0,0,0.25); border-radius: 22px; }
    .hero { padding: 24px; margin-bottom: 16px; }
    .card { padding: 18px; margin-bottom: 16px; }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.5rem); line-height: 1.02; }
    .muted { color: #a8b7ad; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric { padding: 14px; border-radius: 18px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); }
    .metric .label { color: #a8b7ad; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .14em; }
    .metric .value { font-size: 1.7rem; font-weight: 750; margin-top: 8px; }
    .filters { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr; gap: 10px; margin-bottom: 14px; }
    input, select { width: 100%; box-sizing: border-box; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color: inherit; padding: 11px 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    th { color: #a8b7ad; font-size: .72rem; text-transform: uppercase; letter-spacing: .14em; }
    .pill { display: inline-flex; padding: 5px 9px; border-radius: 999px; font-size: .72rem; font-weight: 700; text-transform: uppercase; }
    .genuine-buyer { background: rgba(135, 241, 139, 0.12); color: #baf8bd; }
    .warm { background: rgba(246, 193, 119, 0.12); color: #ffe1b1; }
    .cold { background: rgba(255,255,255,0.08); color: #d0dad3; }
    .personal { background: rgba(158, 178, 255, 0.12); color: #d1dcff; }
    .evidence { color: #d8e1d9; line-height: 1.45; }
    .row-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    a.btn { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; padding: 11px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.08); color: inherit; }
    @media (max-width: 980px) {
      .grid, .filters { grid-template-columns: 1fr 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>Relatorio de Leads</h1>
      <p class="muted" style="max-width: 72ch; line-height: 1.6; margin: 10px 0 0;">
        Extraido direto do SQLite local. Os valores em R$ sao inferencias do texto e servem para triagem comercial, nao para contabilidade.
      </p>
      <div class="row-actions">
        <a class="btn" href="leads-report.csv" download>Download CSV</a>
        <a class="btn" href="leads-report.json" download>Download JSON</a>
      </div>
    </section>

    <div class="grid" id="metrics"></div>

    <section class="card">
      <div class="filters">
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
            <th>Contato</th>
            <th>ChatId</th>
            <th>Status</th>
            <th>Sentimento</th>
            <th>Fechado</th>
            <th>Pipeline</th>
            <th>Evidencias</th>
            <th>Ultima interacao</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </section>
  </div>

  <script id="report-data" type="application/json">${htmlData}</script>
  <script>
    const report = JSON.parse(document.getElementById('report-data').textContent || '{}');
    const rows = (report.payload && report.payload.conversations) || [];
    const summary = report.summary || {};
    const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const metricItems = [
      ['Total', summary.total || 0],
      ['Comerciais', summary.commercialTotal || 0],
      ['Fechados', summary.closedCount || 0],
      ['Pipeline aberto', currency.format(summary.openPipelineTotal || 0)],
    ];

    const metrics = document.getElementById('metrics');
    metrics.innerHTML = metricItems.map(([label, value]) => {
      return [
        '<div class="metric">',
        '<div class="label">' + label + '</div>',
        '<div class="value">' + value + '</div>',
        '</div>',
      ].join('');
    }).join('');

    const interestSelect = document.getElementById('interest');
    const sentimentSelect = document.getElementById('sentiment');
    const interestValues = ['all', 'genuine-buyer', 'warm', 'cold', 'personal'];
    const sentimentValues = ['all', 'positive', 'neutral', 'negative'];
    interestSelect.innerHTML = interestValues.map(v => '<option value="' + v + '">' + v + '</option>').join('');
    sentimentSelect.innerHTML = sentimentValues.map(v => '<option value="' + v + '">' + v + '</option>').join('');

    const state = { search: '', interest: 'all', sentiment: 'all', scope: 'all' };
    const tbody = document.getElementById('tbody');

    function render() {
      const q = state.search.trim().toLowerCase();
      const filtered = rows.filter(row => {
        if (state.interest !== 'all' && row.interestStatus !== state.interest) return false;
        if (state.sentiment !== 'all' && row.sentiment !== state.sentiment) return false;
        if (state.scope === 'commercial' && row.interestStatus === 'personal') return false;
        if (state.scope === 'personal' && row.interestStatus !== 'personal') return false;
        if (!q) return true;
        const haystack = [
          row.contact,
          row.chatId,
          row.interestStatus,
          row.sentiment,
          (row.evidenceSnippets || []).join(' '),
          row.lastInteraction,
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });

      tbody.innerHTML = filtered.map(row => {
        const evidence = (row.evidenceSnippets || []).map(snippet => '• ' + snippet).join('<br/>');
        return [
          '<tr>',
          '<td>' + (row.contact || '') + '</td>',
          '<td>' + (row.chatId || '') + '</td>',
          '<td><span class="pill ' + row.interestStatus + '">' + row.interestStatus + '</span></td>',
          '<td>' + (row.sentiment || '') + '</td>',
          '<td>' + currency.format(row.closedValue || 0) + '</td>',
          '<td>' + (row.openPipelineValue ? currency.format(row.openPipelineValue) : '') + '</td>',
          '<td class="evidence">' + evidence + '</td>',
          '<td>' + (row.lastInteraction || '') + '</td>',
          '</tr>',
        ].join('');
      }).join('');
    }

    document.getElementById('search').addEventListener('input', event => {
      state.search = event.target.value;
      render();
    });
    interestSelect.addEventListener('change', event => {
      state.interest = event.target.value;
      render();
    });
    sentimentSelect.addEventListener('change', event => {
      state.sentiment = event.target.value;
      render();
    });
    document.getElementById('scope').addEventListener('change', event => {
      state.scope = event.target.value;
      render();
    });

    render();
  </script>
</body>
</html>`;
}

function main() {
  const db = new Database(dbPath, { readonly: true });
  const session = db
    .prepare(
      `SELECT id, name, status, phone, pushName, connectedAt, lastActiveAt, createdAt, updatedAt
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found in ${dbPath}`);
  }

  const privateChats = db
    .prepare(
      `SELECT
         chatId,
         COUNT(*) AS messageCount,
         MAX(timestamp) AS lastTs,
         MAX(COALESCE(chatName, '')) AS chatName
       FROM messages
       WHERE sessionId = ?
         AND chatId NOT LIKE '%@g.us'
         AND chatId <> 'status@broadcast'
         ${cutoffSec !== null ? 'AND timestamp >= ?' : ''}
       GROUP BY chatId
       HAVING COUNT(*) >= 2
       ${cutoffSec !== null ? 'AND MAX(timestamp) >= ?' : ''}
       ORDER BY lastTs DESC
       LIMIT ?`,
    )
    .all(...(cutoffSec !== null ? [sessionId, cutoffSec, cutoffSec, limit] : [sessionId, limit]));

  const readMessages = db.prepare(
    `SELECT
       id,
       chatId,
       "from" AS sender,
       "to" AS recipient,
       direction,
       type,
       body,
       timestamp,
       chatName,
       author,
       waMessageId,
       createdAt
     FROM messages
     WHERE sessionId = ? AND chatId = ?
     ${cutoffSec !== null ? 'AND timestamp >= ?' : ''}
     ORDER BY timestamp ASC, createdAt ASC`,
  );

  const classifiedRows = privateChats.map(chat => {
    const messages = readMessages.all(...(cutoffSec !== null ? [sessionId, chat.chatId, cutoffSec] : [sessionId, chat.chatId]));
    const conversation = classifyConversation(messages);
    return {
      ...conversation,
      contact: conversation.contact || chat.chatName || chat.chatId,
    };
  });

  const interestOrder = {
    'genuine-buyer': 0,
    warm: 1,
    cold: 2,
    personal: 3,
  };

  const commercialRows = classifiedRows
    .filter(row => row.interestStatus !== 'personal')
    .sort(
      (a, b) =>
        interestOrder[a.interestStatus] - interestOrder[b.interestStatus] ||
        b.leadScore - a.leadScore ||
        new Date(b.lastInteraction).getTime() - new Date(a.lastInteraction).getTime(),
    );
  const personalRows = classifiedRows
    .filter(row => row.interestStatus === 'personal')
    .sort((a, b) => b.leadScore - a.leadScore || new Date(b.lastInteraction).getTime() - new Date(a.lastInteraction).getTime());
  const rows = [...commercialRows.slice(0, limit), ...personalRows].slice(0, limit);
  const summary = buildSummary(rows);
  const reportTitle = Number.isFinite(windowDays)
    ? `Relatorio de leads dos ultimos ${windowDays} dias`
    : 'Relatorio de leads extraido do SQLite local';

  const report = {
    payload: {
      generatedAt: new Date().toISOString(),
      sessionId: session.id,
      sessionName: session.name,
      title: reportTitle,
      conversations: rows,
    },
    summary,
  };

  const outputDir = Number.isFinite(windowDays) ? join(DEFAULT_OUTPUT_ROOT, `${windowDays}d`) : DEFAULT_OUTPUT_ROOT;

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'leads-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outputDir, 'leads-report.csv'), buildCsv(rows));
  writeFileSync(join(outputDir, 'leads-report.html'), buildHtml(report));

  const ordered = [...rows].sort((a, b) => {
    const rank = { 'genuine-buyer': 0, warm: 1, cold: 2, personal: 3 };
    const rankDelta = rank[a.interestStatus] - rank[b.interestStatus];
    if (rankDelta !== 0) return rankDelta;
    return new Date(b.lastInteraction).getTime() - new Date(a.lastInteraction).getTime();
  });

  const hotLeads = ordered.filter(row => row.interestStatus !== 'personal').slice(0, 5);
  const opportunities = ordered
    .filter(row => row.interestStatus !== 'personal' && (row.openPipelineValue || 0) > 0)
    .slice(0, 5);

  console.log(`Session: ${session.name} (${session.id})`);
  console.log(`Private conversations analyzed: ${rows.length}`);
  console.log(`Commercial conversations: ${summary.commercialTotal}`);
  console.log(`Closed total: R$ ${summary.closedTotal.toFixed(2)}`);
  console.log(`Open pipeline total: R$ ${summary.openPipelineTotal.toFixed(2)}`);
  console.log('');
  console.log('Hot leads:');
  for (const row of hotLeads) {
    console.log(`- ${row.contact} | ${row.interestStatus} | ${row.sentiment} | R$ ${formatMoney(row.closedValue) || '0.00'} | ${row.evidenceSnippets[0] || ''}`);
  }
  console.log('');
  console.log('Opportunities:');
  for (const row of opportunities) {
    console.log(`- ${row.contact} | pipeline R$ ${formatMoney(row.openPipelineValue) || '0.00'} | ${row.evidenceSnippets[0] || ''}`);
  }
  console.log('');
  console.log(`Wrote: ${join(outputDir, 'leads-report.json')}`);
  console.log(`Wrote: ${join(outputDir, 'leads-report.csv')}`);
  console.log(`Wrote: ${join(outputDir, 'leads-report.html')}`);
}

main();
