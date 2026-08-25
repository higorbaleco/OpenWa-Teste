import { useMemo, useState, type ChangeEvent } from 'react';
import { AlertCircle, Download, FileJson, FileText, Loader2, Upload, WandSparkles } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  buildLeadCsv,
  buildLeadReportHtml,
  buildLeadSummary,
  parseLeadWorkflowInput,
  sortLeadRows,
  type InterestStatus,
  type LeadConversation,
  type Sentiment,
} from '../utils/leadsAnalyzer';
import './LeadsAnalyzer.css';

const samplePayload = {
  generatedAt: new Date().toISOString(),
  sessionId: '8df95b4d-18bf-4faf-a81b-765800de0979',
  sessionName: 'higor-mago',
  title: 'Diagnóstico do piloto',
  conversations: [
    {
      contact: 'Lead Alpha',
      chatId: '220375577313459@lid',
      interestStatus: 'genuine-buyer',
      sentiment: 'positive',
      closedValue: 18000,
      openPipelineValue: 24000,
      evidenceSnippets: ['“Pode me mandar a proposta ainda hoje?”', '“Fechamos por R$ 18 mil.”'],
      lastInteraction: new Date().toISOString(),
    },
    {
      contact: 'Lead Beta',
      chatId: '5511999999999@lid',
      interestStatus: 'warm',
      sentiment: 'neutral',
      closedValue: 0,
      openPipelineValue: 12500,
      evidenceSnippets: ['“Quanto fica para esse escopo?”'],
      lastInteraction: new Date().toISOString(),
    },
    {
      contact: 'Amiga Clara',
      chatId: '5511888888888@lid',
      interestStatus: 'personal',
      sentiment: 'positive',
      closedValue: 0,
      openPipelineValue: null,
      evidenceSnippets: ['“Vamos marcar o almoço de sábado?”'],
      lastInteraction: new Date().toISOString(),
    },
  ],
};

const interestOptions: { value: 'all' | InterestStatus; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'genuine-buyer', label: 'genuine-buyer' },
  { value: 'warm', label: 'warm' },
  { value: 'cold', label: 'cold' },
  { value: 'personal', label: 'personal' },
];

const sentimentOptions: { value: 'all' | Sentiment; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'positive', label: 'positive' },
  { value: 'neutral', label: 'neutral' },
  { value: 'negative', label: 'negative' },
];

const interestStatuses: InterestStatus[] = ['genuine-buyer', 'warm', 'cold', 'personal'];
const sentimentStatuses: Sentiment[] = ['positive', 'neutral', 'negative'];

  const scopeOptions = [
  { value: 'all', label: 'Todos' },
  { value: 'commercial', label: 'Somente comerciais' },
  { value: 'personal', label: 'Somente pessoais' },
] as const;

const publishedReports = [
  {
    label: '30 dias HTML',
    href: '/reports/leads-report/30d/leads-report.html',
  },
  {
    label: '30 dias CSV',
    href: '/reports/leads-report/30d/leads-report.csv',
  },
  {
    label: '30 dias JSON',
    href: '/reports/leads-report/30d/leads-report.json',
  },
  {
    label: '90 dias HTML',
    href: '/reports/leads-report/90d/leads-report.html',
  },
  {
    label: '90 dias CSV',
    href: '/reports/leads-report/90d/leads-report.csv',
  },
  {
    label: '90 dias JSON',
    href: '/reports/leads-report/90d/leads-report.json',
  },
] as const;

export function LeadsAnalyzer() {
  useDocumentTitle('Leads Lab');
  const [rawInput, setRawInput] = useState('');
  const [rows, setRows] = useState<LeadConversation[]>([]);
  const [search, setSearch] = useState('');
  const [interestFilter, setInterestFilter] = useState<'all' | InterestStatus>('all');
  const [sentimentFilter, setSentimentFilter] = useState<'all' | Sentiment>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'commercial' | 'personal'>('all');
  const [statusMessage, setStatusMessage] = useState('Cole o JSON do workflow ou carregue um arquivo para começar.');
  const [isParsing, setIsParsing] = useState(false);
  const [isDownloading, setIsDownloading] = useState<'csv' | 'html' | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const summary = useMemo(() => buildLeadSummary(rows), [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(row => {
      if (interestFilter !== 'all' && row.interestStatus !== interestFilter) return false;
      if (sentimentFilter !== 'all' && row.sentiment !== sentimentFilter) return false;
      if (scopeFilter === 'commercial' && row.interestStatus === 'personal') return false;
      if (scopeFilter === 'personal' && row.interestStatus !== 'personal') return false;
      if (!q) return true;
      const haystack = [
        row.contact,
        row.chatId,
        row.interestStatus,
        row.sentiment,
        row.evidenceSnippets.join(' '),
        row.lastInteraction,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, search, interestFilter, sentimentFilter, scopeFilter]);

  const openFilePicker = () => {
    document.getElementById('leads-workflow-file')?.click();
  };

  const applyRows = (nextRows: LeadConversation[], message = 'Dados carregados.') => {
    setRows(nextRows.slice().sort(sortLeadRows));
    setStatusMessage(`${message} ${nextRows.length} conversas carregadas.`);
    setParseError(null);
  };

  const parseInput = () => {
    if (!rawInput.trim()) {
      setParseError('Cole o payload JSON antes de interpretar.');
      return;
    }
    setIsParsing(true);
    try {
      const parsed = parseLeadWorkflowInput(rawInput);
      if (!parsed.conversations.length) {
        throw new Error('O JSON não contém conversas reconhecíveis.');
      }
      applyRows(parsed.conversations);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'Não foi possível interpretar o JSON.');
    } finally {
      setIsParsing(false);
    }
  };

  const loadExample = () => {
    setRawInput(JSON.stringify(samplePayload, null, 2));
    setStatusMessage('Exemplo carregado. Agora clique em "Interpretar JSON".');
    setParseError(null);
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setRawInput(await file.text());
    setStatusMessage(`Arquivo "${file.name}" carregado. Clique em "Interpretar JSON".`);
  };

  const downloadBlob = (filename: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadCsv = () => {
    setIsDownloading('csv');
    try {
      downloadBlob('relatorio-leads.csv', buildLeadCsv(rows), 'text/csv;charset=utf-8;');
    } finally {
      setIsDownloading(null);
    }
  };

  const handleDownloadHtml = () => {
    setIsDownloading('html');
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        conversations: rows,
      };
      downloadBlob('relatorio-leads.html', buildLeadReportHtml(payload, summary), 'text/html;charset=utf-8;');
    } finally {
      setIsDownloading(null);
    }
  };

  return (
    <div className="leads-analyzer-page">
      <PageHeader
        title="Leads Lab"
        subtitle="Cole os resultados do workflow, classifique sinais comerciais e exporte um HTML autônomo ou CSV."
        actions={
          <>
            <button className="btn-secondary" onClick={loadExample}>
              <WandSparkles size={18} />
              Exemplo
            </button>
            <button className="btn-secondary" onClick={openFilePicker}>
              <Upload size={18} />
              Arquivo
            </button>
            <button className="btn-secondary" onClick={handleDownloadCsv} disabled={!rows.length || isDownloading === 'csv'}>
              {isDownloading === 'csv' ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
              CSV
            </button>
            <button className="btn-primary" onClick={handleDownloadHtml} disabled={!rows.length || isDownloading === 'html'}>
              {isDownloading === 'html' ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />}
              HTML
            </button>
          </>
        }
      />

      <div className="hero-grid">
        <section className="hero-panel input-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">Workflow payload</p>
              <h2>Entrada bruta</h2>
            </div>
            <button className="btn-primary" onClick={parseInput} disabled={isParsing}>
              {isParsing ? <Loader2 size={18} className="animate-spin" /> : <FileJson size={18} />}
              Interpretar JSON
            </button>
          </div>
          <textarea
            value={rawInput}
            onChange={event => setRawInput(event.target.value)}
            placeholder="Cole aqui o JSON do workflow, um array de conversas ou um objeto com `conversations`."
            spellCheck={false}
          />
          <div className="status-line" role="status">
            <span className="status-dot" />
            <span>{statusMessage}</span>
          </div>
          {parseError && (
            <div className="error-banner" role="alert">
              <AlertCircle size={18} />
              <span>{parseError}</span>
            </div>
          )}
          <input id="leads-workflow-file" type="file" accept=".json,application/json" hidden onChange={handleFileChange} />
        </section>

        <section className="hero-panel summary-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">Resumo</p>
              <h2>Métricas principais</h2>
            </div>
          </div>
          <div className="summary-grid">
            <article className="summary-card summary-card-hero">
              <span className="summary-label">Conversas</span>
              <strong>{summary.total}</strong>
              <small>
                {summary.commercialTotal} comerciais, {summary.byInterest.personal} pessoais
              </small>
            </article>
            <article className="summary-card">
              <span className="summary-label">Negócios fechados</span>
              <strong>{summary.closedCount}</strong>
              <small>{summary.closedTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</small>
            </article>
            <article className="summary-card">
              <span className="summary-label">Média por fechamento</span>
              <strong>{summary.averageClosedValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</strong>
              <small>Estimativa inferida do texto</small>
            </article>
            <article className="summary-card">
              <span className="summary-label">Pipeline aberto</span>
              <strong>{summary.openPipelineTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</strong>
              <small>Potencial futuro</small>
            </article>
          </div>

          <div className="status-breakdown">
            <div>
              <span className="summary-label">Interest status</span>
              <div className="chip-stack">
                {interestStatuses.map(status => (
                  <span key={status} className={`status-chip ${status}`}>
                    {status}: {summary.byInterest[status]}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <span className="summary-label">Sentimento</span>
              <div className="chip-stack">
                {sentimentStatuses.map(status => (
                  <span key={status} className={`status-chip ${status}`}>
                    {status}: {summary.bySentiment[status]}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <p className="warning-card">
            Os valores em R$ são estimativas inferidas das mensagens e não representam dados contábeis
            confirmados.
          </p>

          <div className="warning-card publication-card">
            <div>
              <strong>Publicação do relatório</strong>
              <p>
                Os pacotes extraídos já estão expostos no app em <code>/reports</code>, com HTML, CSV e JSON para
                30 e 90 dias.
              </p>
            </div>
            <div className="publication-links">
              {publishedReports.map(report => (
                <a key={report.href} href={report.href} target="_blank" rel="noreferrer">
                  {report.label}
                </a>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="table-panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">Exploração</p>
            <h2>Conversas classificadas</h2>
          </div>
          <div className="panel-count">
            {filteredRows.length} de {rows.length}
          </div>
        </div>

        <div className="filters-row">
          <label className="search-field">
            <span>Buscar</span>
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Contato, chatId, trecho..."
            />
          </label>
          <label>
            <span>Status</span>
            <select value={interestFilter} onChange={event => setInterestFilter(event.target.value as typeof interestFilter)}>
              {interestOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Sentimento</span>
            <select value={sentimentFilter} onChange={event => setSentimentFilter(event.target.value as typeof sentimentFilter)}>
              {sentimentOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Escopo</span>
            <select value={scopeFilter} onChange={event => setScopeFilter(event.target.value as typeof scopeFilter)}>
              {scopeOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="table-shell">
          <table className="leads-table">
            <thead>
              <tr>
                <th>Contato</th>
                <th>ChatId</th>
                <th>Status</th>
                <th>Sentimento</th>
                <th>Fechado</th>
                <th>Pipeline</th>
                <th>Evidências</th>
                <th>Última interação</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-state">
                    <div>
                      <strong>Nenhuma conversa encontrada.</strong>
                      <span>Carregue o payload do workflow ou ajuste os filtros.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredRows.map(row => (
                  <tr key={row.chatId}>
                    <td>
                      <strong>{row.contact}</strong>
                    </td>
                    <td className="mono">{row.chatId}</td>
                    <td>
                      <span className={`pill ${row.interestStatus}`}>{row.interestStatus}</span>
                    </td>
                    <td>
                      <span className={`sentiment ${row.sentiment}`}>{row.sentiment}</span>
                    </td>
                    <td className="money">
                      {row.closedValue > 0 ? row.closedValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'}
                    </td>
                    <td className="money">
                      {typeof row.openPipelineValue === 'number'
                        ? row.openPipelineValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
                        : '—'}
                    </td>
                    <td className="snippets">
                      {row.evidenceSnippets.length ? row.evidenceSnippets.join(' · ') : '—'}
                    </td>
                    <td className="mono">{new Date(row.lastInteraction).toLocaleString('pt-BR')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
