'use strict';

/* ============================================
   Formalização de Testes — frontend v2.0
   - Dados reais do usuário; nada é inventado.
   - Rascunho local em IndexedDB; sistema no Sheets.
   - Envio somente após tela de revisão explícita.
   - Chave de acesso via AppCore (nunca no código).
   ============================================ */

const FORMALIZATION_VERSION = '2.0';
const FORMALIZATION_DB_NAME = 'sistema-ts-formalizacao';
const FORMALIZATION_DB_VERSION = 1;

const state = {
  db: null,
  records: [],
  currentId: null,
  dirty: false,
  saveTimer: null,
  sending: false,
  listState: 'loading',
  listError: '',
  serverReachable: true,
  reviewSnapshot: null,
  conflictPayload: null
};

const $f = id => document.getElementById(id);
const escapeHtmlForm = window.AppCore.escapeHtml;
const sha256Form = buffer => window.AppCore.sha256Hex(buffer);
const readFileAsBase64Form = file => window.AppCore.readFileAsBase64(file);
const base64ToBytesForm = b64 => window.AppCore.base64ToBytes(b64);
const formatBytesForm = bytes => window.AppCore.formatBytes(bytes);
const formatDateTimeBrForm = iso => window.AppCore.formatDateTimeBr(iso);

function toastForm(message, tone = 'info', timeout = 4500) {
  const element = $f('toast');
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone === 'error' ? 'error' : 'info';
  element.classList.add('visible');
  clearTimeout(toastForm.timer);
  toastForm.timer = setTimeout(() => element.classList.remove('visible'), timeout);
}

function setBusyForm(button, busy, text) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function nowIsoForm() { return new Date().toISOString(); }

function switchView(view) {
  const showFormalizacao = view === 'formalizacao';
  const viewPta = $f('viewPta');
  const viewFormalizacao = $f('viewFormalizacao');
  if (viewPta) {
    viewPta.classList.toggle('active', !showFormalizacao);
    viewPta.hidden = showFormalizacao;
  }
  if (viewFormalizacao) {
    viewFormalizacao.classList.toggle('active', showFormalizacao);
    viewFormalizacao.hidden = !showFormalizacao;
  }
  document.querySelectorAll('.tab-button').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

/* ---------- IndexedDB (apenas rascunhos locais) ---------- */
function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB não disponível neste navegador.'));
      return;
    }
    const request = indexedDB.open(FORMALIZATION_DB_NAME, FORMALIZATION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('formalizacoes')) {
        const store = db.createObjectStore('formalizacoes', { keyPath: 'id' });
        store.createIndex('number', 'number', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbAll() {
  if (!state.db) return Promise.reject(new Error('Armazenamento local indisponível neste navegador.'));
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('formalizacoes', 'readonly');
    const request = tx.objectStore('formalizacoes').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function dbPut(record) {
  if (!state.db) return Promise.reject(new Error('Armazenamento local indisponível neste navegador.'));
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('formalizacoes', 'readwrite');
    const request = tx.objectStore('formalizacoes').put(record);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------- Registro ---------- */
function createEmptyRecord() {
  const count = state.records.length + 1;
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `form_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    number: `FT-${String(count).padStart(4, '0')}`,
    revision: 'R0',
    title: '',
    requester: '',
    owner: '',
    unit: '',
    responsible: '',
    period: '',
    status: 'rascunho',
    objective: '',
    notes: '',
    ptaLink: '',
    products: [],
    procedure: {
      preparation: '', products: '', equipment: '', steps: '', duration: '', sampling: '', safety: ''
    },
    email: { to: '', cc: '', reply: '', subject: '', body: '' },
    history: [],
    communications: [],
    responses: [],
    createdAt: nowIsoForm(),
    updatedAt: nowIsoForm(),
    baseVersion: 0,
    syncStatus: 'local'
  };
}

function addHistory(record, action, links = []) {
  record.history.unshift({
    at: nowIsoForm(),
    actor: record.owner || 'Usuário local',
    action,
    revision: record.revision,
    links
  });
}

function getRecord() {
  return state.records.find(item => item.id === state.currentId) || null;
}

function lastCommunication(record) {
  return record.communications && record.communications.length
    ? record.communications[record.communications.length - 1]
    : null;
}

function revisionNumber(revision) {
  const match = /^R(\d+)$/i.exec(String(revision || 'R0'));
  return match ? parseInt(match[1], 10) : 0;
}

function nextRevision(revision) {
  return 'R' + (revisionNumber(revision) + 1);
}

async function computeContentHash(record) {
  const canonical = {
    id: record.id,
    number: record.number,
    revision: record.revision,
    title: record.title,
    requester: record.requester,
    owner: record.owner,
    unit: record.unit,
    responsible: record.responsible,
    period: record.period,
    objective: record.objective,
    notes: record.notes,
    ptaLink: record.ptaLink,
    products: record.products.map(product => ({
      name: product.name || '',
      manufacturer: product.manufacturer || '',
      quantity: product.quantity || '',
      unit: product.unit || '',
      fdsName: product.fds ? product.fds.name : '',
      fdsHash: product.fds ? product.fds.hash : '',
      fdsSize: product.fds ? product.fds.size : 0,
      fdsRevision: product.fds ? (product.fds.revision || '') : ''
    })),
    procedure: record.procedure,
    email: record.email
  };
  return window.AppCore.sha256Hex(new TextEncoder().encode(JSON.stringify(canonical)));
}

async function maybeBumpRevision(record) {
  if (!record.communications.length) return false;
  const last = lastCommunication(record);
  const currentHash = await computeContentHash(record);
  if (currentHash === (last.contentHash || '') && record.revision === last.revision) return false;
  if (revisionNumber(record.revision) <= revisionNumber(last.revision)) {
    record.revision = nextRevision(last.revision);
    addHistory(record, `Revisão incrementada para ${record.revision} por alteração após envio anterior`);
    return true;
  }
  return false;
}

/* ---------- Lista: estados distintos ---------- */
function setListState(kind, detail = '') {
  state.listState = kind;
  state.listError = detail;
  renderList();
}

function listStateHtml(kind, detail) {
  if (kind === 'loading') {
    return `<div class="list-state list-state--loading" role="status"><div><div class="spinner" aria-hidden="true"></div><strong>Carregando formalizações…</strong><span>Buscando rascunhos locais e o sistema.</span></div></div>`;
  }
  if (kind === 'error') {
    return `<div class="list-state list-state--error" role="alert">
      <div>
        <span class="state-icon" aria-hidden="true">⚠</span>
        <strong>Não foi possível carregar do sistema.</strong>
        <span>${escapeHtmlForm(detail || 'Erro de comunicação.')}</span>
        <div class="actions" style="justify-content:center;margin-top:10px">
          <button type="button" class="btn btn-secondary btn-small" data-action="retry-list">Tentar novamente</button>
        </div>
      </div>
    </div>`;
  }
  if (kind === 'empty') {
    return `<div class="list-state"><div>
      <span class="state-icon" aria-hidden="true">📭</span>
      <strong>Nenhuma formalização encontrada.</strong>
      <span>Crie a primeira formalização com FDS reais anexadas.</span>
      <div class="actions" style="justify-content:center;margin-top:10px">
        <button type="button" class="btn btn-primary btn-small" data-action="new">Nova formalização</button>
      </div>
    </div></div>`;
  }
  if (kind === 'no-results') {
    return `<div class="list-state"><div>
      <span class="state-icon" aria-hidden="true">🔎</span>
      <strong>Nenhum resultado para os filtros.</strong>
      <span>Ajuste a busca, a situação ou o período.</span>
      <div class="actions" style="justify-content:center;margin-top:10px">
        <button type="button" class="btn btn-secondary btn-small" data-action="clear-filters">Limpar filtros</button>
      </div>
    </div></div>`;
  }
  if (kind === 'local') {
    const noKey = !window.AppCore.hasKey();
    return `<div class="list-state list-state--offline"><div>
      <span class="state-icon" aria-hidden="true">💾</span>
      <strong>${noKey ? 'Sessão sem chave de acesso.' : 'Sistema indisponível no momento.'}</strong>
      <span>${noKey
        ? 'Os rascunhos salvos neste dispositivo estão disponíveis abaixo. Informe a chave para consultar o sistema.'
        : 'Exibindo apenas os dados salvos neste dispositivo. Tente novamente quando a conexão voltar.'}</span>
      <div class="actions" style="justify-content:center;margin-top:10px">
        <button type="button" class="btn btn-secondary btn-small" data-action="retry-list">Tentar novamente</button>
        ${noKey ? '<button type="button" class="btn btn-primary btn-small" data-action="open-gate">Informar chave</button>' : ''}
      </div>
    </div></div>`;
  }
  return '';
}

function productNamesForm(record) {
  return (record.products || [])
    .map(product => (typeof product === 'string' ? product : product?.name || ''))
    .filter(Boolean)
    .join(', ') || '-';
}

function renderList() {
  const container = $f('formalizacaoList');
  if (!container) return;

  if (state.listState === 'loading') {
    container.innerHTML = listStateHtml('loading');
    return;
  }
  if (state.listState === 'error' && !state.records.length) {
    container.innerHTML = listStateHtml('error', state.listError);
    return;
  }
  if (state.listState === 'local' && !state.records.length) {
    container.innerHTML = listStateHtml('local');
    return;
  }

  const query = ($f('searchFormalizacao')?.value || '').trim().toLowerCase();
  const status = $f('filterStatus')?.value || '';
  const from = $f('filterFrom')?.value || '';
  const to = $f('filterTo')?.value || '';

  const filtered = state.records.filter(record => {
    const haystack = `${record.number || ''} ${record.title || ''} ${productNamesForm(record)}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (status && record.status !== status) return false;
    const updated = String(record.updatedAt || '').slice(0, 10);
    if (from && updated < from) return false;
    if (to && updated > to) return false;
    return true;
  }).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const offlineBanner = !state.serverReachable
    ? `<div class="list-state list-state--offline" role="status" style="min-height:auto;padding:12px 16px;text-align:left">
         <div><strong>${navigator.onLine === false ? 'Sem conexão com a internet.' : 'Sistema não consultado nesta sessão.'}</strong>
         <span>Exibindo dados salvos neste dispositivo. O envio de e-mail fica bloqueado até a consulta ao sistema. <button type="button" class="btn btn-link btn-small" data-action="retry-list">Tentar novamente</button></span></div>
       </div>`
    : '';

  if (!filtered.length) {
    container.innerHTML = offlineBanner + (state.records.length
      ? listStateHtml('no-results')
      : listStateHtml('empty'));
    return;
  }

  const rows = filtered.map(record => `
    <tr>
      <td>${escapeHtmlForm(record.number || '-')}</td>
      <td>${escapeHtmlForm(record.title || 'Sem título')}</td>
      <td>${escapeHtmlForm(productNamesForm(record))}</td>
      <td>${escapeHtmlForm(record.revision || 'R0')}</td>
      <td><span class="status-badge" data-status="${escapeHtmlForm(record.status || 'rascunho')}">${escapeHtmlForm(record.status || 'rascunho')}</span></td>
      <td>${escapeHtmlForm(formatDateTimeBrForm(record.updatedAt))}</td>
      <td>
        <div class="actions">
          <button type="button" class="btn btn-small" data-open="${escapeHtmlForm(record.id)}">Abrir</button>
          ${record.syncStatus !== 'server' ? '<span class="status-badge" data-status="local">Somente local</span>' : ''}
        </div>
      </td>
    </tr>`).join('');

  const cards = filtered.map(record => `
    <div class="card-item">
      <strong>${escapeHtmlForm(record.number || '-')} — ${escapeHtmlForm(record.title || 'Sem título')}</strong>
      <span>Produtos: ${escapeHtmlForm(productNamesForm(record))}</span>
      <span>Revisão: ${escapeHtmlForm(record.revision || 'R0')} · Situação: <span class="status-badge" data-status="${escapeHtmlForm(record.status || 'rascunho')}">${escapeHtmlForm(record.status || 'rascunho')}</span>${record.syncStatus !== 'server' ? ' · <span class="status-badge" data-status="local">Somente local</span>' : ''}</span>
      <span>Atualizado: ${escapeHtmlForm(formatDateTimeBrForm(record.updatedAt))}</span>
      <div class="actions"><button type="button" class="btn btn-small" data-open="${escapeHtmlForm(record.id)}">Abrir</button></div>
    </div>`).join('');

  container.innerHTML = `${offlineBanner}
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Número</th><th>Teste</th><th>Produtos</th><th>Revisão</th><th>Situação</th><th>Última atualização</th><th>Ações</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="card-list">${cards}</div>`;
}

function updateSaveBadges(localText, localMode, serverText, serverMode) {
  const localBadge = $f('saveLocalBadge');
  const serverBadge = $f('saveServerBadge');
  if (localBadge) {
    localBadge.textContent = localText;
    localBadge.classList.remove('ok', 'pending');
    localBadge.classList.add(localMode === 'ok' ? 'ok' : 'pending');
  }
  if (serverBadge) {
    serverBadge.textContent = serverText;
    serverBadge.classList.remove('ok', 'pending', 'error');
    serverBadge.classList.add(serverMode === 'ok' ? 'ok' : serverMode === 'error' ? 'error' : 'pending');
  }
}

/* ---------- Formulário ---------- */
function collectForm() {
  const record = getRecord();
  if (!record) return null;
  const value = id => $f(id)?.value || '';
  record.title = value('f_test_title').trim();
  record.requester = value('f_test_requester').trim();
  record.owner = value('f_test_owner').trim();
  record.unit = value('f_test_unit').trim();
  record.responsible = value('f_test_responsible').trim();
  record.period = value('f_test_period').trim();
  const selectedStatus = value('f_test_status');
  if (['rascunho', 'pronto', 'enviado', 'resposta', 'arquivado'].includes(selectedStatus)) {
    record.status = selectedStatus;
  }
  record.objective = value('f_test_objective').trim();
  record.notes = value('f_test_notes').trim();
  record.ptaLink = value('f_test_pta_link').trim();
  record.procedure.preparation = value('f_proc_preparation').trim();
  record.procedure.products = value('f_proc_products').trim();
  record.procedure.equipment = value('f_proc_equipment').trim();
  record.procedure.steps = value('f_proc_steps').trim();
  record.procedure.duration = value('f_proc_duration').trim();
  record.procedure.sampling = value('f_proc_sampling').trim();
  record.procedure.safety = value('f_proc_safety').trim();
  record.email.to = value('f_email_to').trim();
  record.email.cc = value('f_email_cc').trim();
  record.email.reply = value('f_email_reply').trim();
  record.email.subject = value('f_email_subject').trim();
  record.email.body = value('f_email_body').trim();
  record.updatedAt = nowIsoForm();
  return record;
}

function renderForm(record) {
  $f('formalizacaoList').hidden = true;
  $f('formalizacaoForm').hidden = false;
  const setValue = (id, value) => { const element = $f(id); if (element) element.value = value || ''; };
  setValue('f_test_number', record.number);
  setValue('f_test_revision', record.revision);
  setValue('f_test_title', record.title);
  setValue('f_test_requester', record.requester);
  setValue('f_test_owner', record.owner);
  setValue('f_test_unit', record.unit);
  setValue('f_test_responsible', record.responsible);
  setValue('f_test_period', record.period);
  setValue('f_test_status', record.status);
  setValue('f_test_objective', record.objective);
  setValue('f_test_notes', record.notes);
  setValue('f_test_pta_link', record.ptaLink);
  setValue('f_proc_preparation', record.procedure.preparation);
  setValue('f_proc_products', record.procedure.products);
  setValue('f_proc_equipment', record.procedure.equipment);
  setValue('f_proc_steps', record.procedure.steps);
  setValue('f_proc_duration', record.procedure.duration);
  setValue('f_proc_sampling', record.procedure.sampling);
  setValue('f_proc_safety', record.procedure.safety);
  setValue('f_email_to', record.email.to);
  setValue('f_email_cc', record.email.cc);
  setValue('f_email_reply', record.email.reply);
  setValue('f_email_subject', record.email.subject);
  setValue('f_email_body', record.email.body);
  renderProducts();
  renderHistory(record);
  renderCommunications(record);
  updateFdsValidation();
  updateSaveBadges(
    record.syncStatus === 'local' ? 'Rascunho salvo neste dispositivo' : 'Salvo neste dispositivo',
    record.syncStatus === 'local' ? 'pending' : 'ok',
    record.syncStatus === 'server' ? 'Salvo no sistema' : 'Aguardando sincronização',
    record.syncStatus === 'server' ? 'ok' : 'pending'
  );
}

function markDirty() {
  state.dirty = true;
  state.reviewSnapshot = null;
  const review = $f('emailReview');
  if (review) review.hidden = true;
  updateSaveBadges('Alterações não salvas', 'pending', 'Aguardando sincronização', 'pending');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveDraft(true), 1200);
}

/* ---------- Salvamento local + sistema (baseVersion) ---------- */
async function saveDraft(silent = false) {
  const record = collectForm();
  if (!record) {
    updateSaveBadges('Nenhuma formalização ativa', 'pending', 'Aguardando sincronização', 'pending');
    if (!silent) toastForm('Crie ou abra uma formalização antes de salvar.');
    return;
  }
  record.syncStatus = 'local';
  try {
    await dbPut(record);
    state.dirty = false;
    updateSaveBadges('Salvo neste dispositivo', 'ok', 'Sincronizando…', 'pending');
    try {
      const result = await window.AppCore.api('FORMALIZATION_SAVE', { formalization: record }, { timeoutMs: 30000 });
      record.baseVersion = result.version || 0;
      record.syncStatus = 'server';
      updateSaveBadges('Salvo neste dispositivo', 'ok', 'Salvo no sistema', 'ok');
      if (!silent) toastForm('Formalização salva no sistema.');
    } catch (error) {
      if (error.code === 'conflict') {
        state.conflictPayload = { record, serverVersion: error.data?.serverVersion, serverRecord: error.data?.serverRecord };
        $f('conflictServerVersion').textContent = String(error.data?.serverVersion ?? '?');
        $f('conflictModal').hidden = false;
        updateSaveBadges('Salvo neste dispositivo', 'ok', 'Conflito de versão', 'error');
        return;
      }
      record.syncStatus = 'local';
      updateSaveBadges('Salvo neste dispositivo', 'ok', 'Falha ao salvar no sistema', 'error');
      if (!silent) toastForm(`Rascunho salvo localmente. Sistema: ${error.message}`, 'error', 7000);
    }
    renderList();
  } catch (error) {
    updateSaveBadges('Falha ao salvar localmente', 'pending', 'Aguardando sincronização', 'pending');
    if (!silent) toastForm('Não foi possível salvar o rascunho localmente.', 'error');
  }
}

function resolveConflict(choice) {
  const payload = state.conflictPayload;
  state.conflictPayload = null;
  $f('conflictModal').hidden = true;
  if (!payload) return;
  const { record, serverVersion, serverRecord } = payload;
  if (choice === 'reload') {
    const merged = Object.assign({}, record, serverRecord, { id: record.id, baseVersion: serverVersion });
    const index = state.records.findIndex(item => item.id === record.id);
    if (index >= 0) state.records[index] = merged;
    state.currentId = merged.id;
    dbPut(merged).catch(() => undefined);
    renderForm(merged);
    renderList();
    toastForm('Versão do sistema carregada. Sua cópia local foi substituída.');
    return;
  }
  if (choice === 'overwrite') {
    if (!window.confirm('Sobrescrever a versão do sistema pela sua versão local? Essa ação substitui o que está salvo no servidor.')) return;
    record.baseVersion = serverVersion;
    saveDraft(false);
    return;
  }
  // keep both: cópia local com novo id
  const copy = JSON.parse(JSON.stringify(record));
  copy.id = crypto.randomUUID ? crypto.randomUUID() : `form_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  copy.number = `${record.number}-C${String(state.records.length + 1).padStart(2, '0')}`;
  copy.baseVersion = 0;
  copy.syncStatus = 'local';
  copy.status = 'rascunho';
  copy.communications = [];
  copy.responses = [];
  copy.history = [];
  addHistory(copy, 'Cópia local criada por conflito de versão');
  state.records.unshift(copy);
  dbPut(copy).catch(() => undefined);
  state.currentId = copy.id;
  state.conflictPayload = null;
  renderForm(copy);
  renderList();
  toastForm('Cópia local criada. O original no sistema foi preservado.');
}

/* ---------- Produtos e FDS ---------- */
function updateFdsValidation() {
  const record = getRecord();
  const summary = $f('fdsValidationSummary');
  if (!record || !summary) return;
  if (!record.products.length) {
    summary.textContent = 'Adicione ao menos um produto para a formalização.';
    summary.className = 'assist-note note--danger';
    return;
  }
  const missing = record.products.filter(product => !product.fds);
  const missingName = record.products.filter(product => !product.name.trim());
  const notOnServer = record.products.filter(product => product.fds && !product.fds.storageId);
  if (missingName.length) {
    summary.textContent = `Informe o nome de todos os produtos (faltam ${missingName.length}).`;
    summary.className = 'assist-note note--danger';
    return;
  }
  if (missing.length) {
    summary.textContent = `Adicione a FDS do produto ${missing.map(p => p.name || 'sem nome').join(', ')} para concluir este envio.`;
    summary.className = 'assist-note note--danger';
    return;
  }
  if (notOnServer.length) {
    summary.textContent = `${notOnServer.length} FDS ainda não enviadas ao arquivo central. O envio tenta arquivar novamente; se o upload falhar, o e-mail não será transmitido.`;
    summary.className = 'assist-note note--warn';
    return;
  }
  summary.textContent = 'Todas as FDS previstas estão anexadas e arquivadas.';
  summary.className = 'assist-note';
}

function renderProducts() {
  const container = $f('productsContainer');
  const record = getRecord();
  if (!container || !record) return;
  container.innerHTML = record.products.map((product, index) => `
    <div class="formalization-product" data-product="${escapeHtmlForm(product.id)}">
      <div class="product-grid">
        <div class="field">
          <label class="field-label" for="prod_name_${escapeHtmlForm(product.id)}">Nome do produto</label>
          <input class="input" id="prod_name_${escapeHtmlForm(product.id)}" data-field="name" value="${escapeHtmlForm(product.name)}" autocomplete="off">
        </div>
        <div class="field">
          <label class="field-label" for="prod_manuf_${escapeHtmlForm(product.id)}">Fabricante/Fornecedor</label>
          <input class="input" id="prod_manuf_${escapeHtmlForm(product.id)}" data-field="manufacturer" value="${escapeHtmlForm(product.manufacturer || '')}" autocomplete="off">
        </div>
        <div class="field">
          <label class="field-label" for="prod_qty_${escapeHtmlForm(product.id)}">Quantidade</label>
          <input class="input" id="prod_qty_${escapeHtmlForm(product.id)}" data-field="quantity" value="${escapeHtmlForm(product.quantity || '')}" autocomplete="off">
        </div>
        <div class="field">
          <label class="field-label" for="prod_unit_${escapeHtmlForm(product.id)}">Unidade</label>
          <input class="input" id="prod_unit_${escapeHtmlForm(product.id)}" data-field="unit" value="${escapeHtmlForm(product.unit || '')}" autocomplete="off">
        </div>
      </div>
      <div class="product-file">
        ${product.fds ? `
          <strong>FDS: ${escapeHtmlForm(product.fds.name)}</strong>
          <span class="file-meta">Tipo: ${escapeHtmlForm(product.fds.type || 'application/pdf')} · Tamanho: ${escapeHtmlForm(formatBytesForm(product.fds.size))} · Revisão: ${escapeHtmlForm(product.fds.revision || 'não informada')} · Hash: ${escapeHtmlForm(String(product.fds.hash || '').slice(0, 16))}…</span>
        ` : '<span class="pendencia">FDS não anexada.</span>'}
      </div>
      <div class="product-actions">
        <input type="file" accept="application/pdf" hidden data-file="${escapeHtmlForm(product.id)}" aria-label="Selecionar FDS do produto ${index + 1}">
        <button type="button" class="btn btn-small" data-select="${escapeHtmlForm(product.id)}">${product.fds ? 'Substituir FDS' : 'Selecionar FDS'}</button>
        ${product.fds ? `<button type="button" class="btn btn-small" data-openfds="${escapeHtmlForm(product.id)}">Abrir arquivo</button>` : ''}
        <button type="button" class="btn btn-danger btn-small" data-remove="${escapeHtmlForm(product.id)}">Remover produto</button>
      </div>
      ${product.fds && !product.fds.revision ? '<p class="note note--warn">Revisão da FDS não informada.</p>' : ''}
      ${product.fds && !product.fds.storageId ? '<p class="note note--warn">FDS ainda não arquivada no sistema.</p>' : ''}
    </div>`).join('');

  container.querySelectorAll('input[data-field]').forEach(input => {
    input.addEventListener('input', event => {
      const card = event.target.closest('[data-product]');
      const product = record.products.find(item => item.id === card?.dataset.product);
      if (!product) return;
      product[event.target.dataset.field] = event.target.value;
      markDirty();
      updateFdsValidation();
    });
  });
  container.querySelectorAll('[data-select]').forEach(button => {
    button.addEventListener('click', () => {
      const input = container.querySelector(`input[data-file="${button.dataset.select}"]`);
      if (input) input.click();
    });
  });
  container.querySelectorAll('input[data-file]').forEach(input => {
    input.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) await attachFds(event.target.dataset.file, file);
    });
  });
  container.querySelectorAll('[data-openfds]').forEach(button => {
    button.addEventListener('click', () => openFds(button.dataset.openfds));
  });
  container.querySelectorAll('[data-remove]').forEach(button => {
    button.addEventListener('click', () => removeProduct(button.dataset.remove));
  });
}

function addProduct() {
  const record = getRecord();
  if (!record) return;
  const product = {
    id: crypto.randomUUID ? crypto.randomUUID() : `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    manufacturer: '',
    quantity: '',
    unit: '',
    fds: null
  };
  record.products.push(product);
  renderProducts();
  updateFdsValidation();
  markDirty();
}

function removeProduct(productId) {
  const record = getRecord();
  if (!record) return;
  const product = record.products.find(item => item.id === productId);
  if (!window.confirm(`Remover o produto "${product?.name || 'sem nome'}" e seu vínculo de FDS?`)) return;
  record.products = record.products.filter(item => item.id !== productId);
  renderProducts();
  updateFdsValidation();
  markDirty();
}

async function attachFds(productId, file) {
  const record = getRecord();
  const product = record?.products.find(item => item.id === productId);
  if (!record || !product) return;
  if (file.type !== 'application/pdf' && !String(file.name || '').toLowerCase().endsWith('.pdf')) {
    toastForm('Selecione um arquivo PDF para a FDS.', 'error');
    return;
  }
  const revision = window.prompt('Revisão da FDS (deixe em branco se não constar):', product.fds?.revision || '');
  if (revision === null) return;
  try {
    const { base64, dataUrl } = await readFileAsBase64Form(file);
    const hash = await sha256Form(base64ToBytesForm(base64).buffer);
    product.fds = {
      id: crypto.randomUUID ? crypto.randomUUID() : `fds_${Date.now()}`,
      name: file.name,
      type: file.type || 'application/pdf',
      size: file.size,
      revision: revision.trim(),
      date: '',
      hash,
      dataUrl,
      storageId: null,
      syncStatus: 'local'
    };
    addHistory(record, `FDS anexada ao produto ${product.name || 'sem nome'}`, [product.fds.id]);
    renderProducts();
    updateFdsValidation();
    markDirty();
    toastForm('FDS anexada neste dispositivo. O arquivo será arquivado no sistema no próximo salvamento ou envio.');
  } catch (error) {
    toastForm('Não foi possível ler a FDS. Tente novamente.', 'error');
  }
}

async function openFds(productId) {
  const record = getRecord();
  const product = record?.products.find(item => item.id === productId);
  const fds = product?.fds;
  if (!fds) {
    toastForm('FDS não anexada.', 'error');
    return;
  }
  if (fds.dataUrl) {
    openDocViewFromDataUrl(fds.name, fds.type, fds.dataUrl);
    return;
  }
  if (fds.storageId) {
    await openDocViewFromServer(fds.storageId, fds.name);
    return;
  }
  toastForm('Arquivo da FDS indisponível offline.', 'error');
}

/* FDS precisam existir no arquivo central antes de qualquer envio */
async function ensureFdsOnServer(record) {
  const failures = [];
  for (const product of record.products) {
    const fds = product.fds;
    if (!fds) { failures.push(`${product.name || 'produto sem nome'}: FDS ausente`); continue; }
    if (fds.storageId) continue;
    if (!fds.dataUrl) { failures.push(`${product.name || 'produto sem nome'}: FDS não disponível neste dispositivo`); continue; }
    try {
      const upload = await window.AppCore.api('FORMALIZATION_UPLOAD_DOC', {
        formalizationId: record.id,
        kind: 'fds',
        revision: record.revision,
        productName: product.name || '',
        fileName: fds.name,
        mimeType: fds.type || 'application/pdf',
        size: fds.size,
        sha256: fds.hash,
        base64: fds.dataUrl.split(',')[1] || ''
      }, { timeoutMs: 90000 });
      fds.storageId = upload.storageId;
      fds.sha256 = upload.sha256;
      fds.syncStatus = 'server';
    } catch (error) {
      failures.push(`${product.name || 'produto sem nome'}: ${error.message}`);
    }
  }
  return failures;
}

/* ---------- PDF do procedimento (jsPDF + autotable, blocos paginados) ---------- */
const ftPdfSafe = value => String(value ?? '')
  .replace(/[—–]/g, '-')
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'");

async function ensurePdfLibsForm() {
  const loadScript = url => new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Falha ao carregar ${url}`));
    document.head.appendChild(script);
  });
  if (!window.jspdf?.jsPDF) await loadScript('./assets/vendor/jspdf.umd.min.js');
  if (!window.jspdf?.jsPDF?.API?.autoTable) await loadScript('./assets/vendor/jspdf.plugin.autotable.min.js');
}

function ftAutoTable(pdf, y, head, body, options = {}) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 14;
  pdf.autoTable(Object.assign({
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body,
    theme: 'grid',
    headStyles: { fillColor: [34, 44, 39], textColor: [244, 247, 245], fontStyle: 'bold', fontSize: 9, cellPadding: 2.6 },
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.6, overflow: 'linebreak', textColor: [17, 23, 21] },
    tableWidth: 'auto'
  }, options));
  return pdf.lastAutoTable.finalY + 5;
}

function ftBrandHeader(pdf, record) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 14;
  pdf.setFillColor(17, 23, 21);
  pdf.rect(0, 0, pageWidth, 24, 'F');
  pdf.setTextColor(244, 247, 245);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text('GRUPO SRF', margin, 10);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text('FORMALIZACAO DE TESTES - PROCEDIMENTO', margin, 16);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`${ftPdfSafe(record.number)} - ${ftPdfSafe(record.revision)}`, pageWidth - margin, 10, { align: 'right' });
  pdf.text(`V ${FORMALIZATION_VERSION}`, pageWidth - margin, 16, { align: 'right' });
  pdf.setTextColor(0, 0, 0);
  return 32;
}

async function buildProcedurePdf(record) {
  await ensurePdfLibsForm();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 14;
  let y = ftBrandHeader(pdf, record);

  if (record.status === 'rascunho') {
    pdf.setTextColor(190, 30, 30);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text('RASCUNHO - NAO ENVIADO', margin, y);
    pdf.setTextColor(0, 0, 0);
    y += 6;
  }

  y = ftAutoTable(pdf, y, [[{ content: '1. IDENTIFICACAO', colSpan: 2 }]], [
    ['Titulo', ftPdfSafe(record.title || 'Nao informado')],
    ['Solicitante', ftPdfSafe(record.requester || 'Nao informado')],
    ['Responsavel pelo registro', ftPdfSafe(record.owner || 'Nao informado')],
    ['Unidade/Local', ftPdfSafe(record.unit || 'Nao informado')],
    ['Responsavel pelo teste', ftPdfSafe(record.responsible || 'Nao informado')],
    ['Periodo previsto', ftPdfSafe(record.period || 'Nao definido')],
    ['Objetivo', ftPdfSafe(record.objective || 'Nao informado')],
    ['Observacoes', ftPdfSafe(record.notes || 'Nao informadas')],
    ['Vinculo com PTA (opcional)', ftPdfSafe(record.ptaLink || 'Sem vinculo informado')]
  ], { columnStyles: { 0: { cellWidth: 46, fontStyle: 'bold' }, 1: { cellWidth: 'auto' } } });

  const productRows = record.products.length
    ? record.products.map((product, index) => [
      String(index + 1),
      ftPdfSafe(product.name || 'Produto sem nome'),
      ftPdfSafe(product.manufacturer || '-'),
      ftPdfSafe(`${product.quantity || '-'} ${product.unit || ''}`.trim()),
      product.fds ? ftPdfSafe(product.fds.name) : 'FDS nao anexada',
      product.fds ? ftPdfSafe(product.fds.revision || 'nao informada') : '-',
      product.fds ? ftPdfSafe(String(product.fds.hash || '').slice(0, 24)) : '-'
    ])
    : [[{ content: 'Nenhum produto cadastrado.', colSpan: 7 }]];
  y = ftAutoTable(pdf, y, [
    [{ content: '2. PRODUTOS E FDS', colSpan: 7 }],
    ['#', 'Produto', 'Fabricante', 'Qtd./Un.', 'Arquivo FDS', 'Revisao FDS', 'Hash (SHA-256)']
  ], productRows, { styles: { fontSize: 8 } });

  y = ftAutoTable(pdf, y, [[{ content: '3. PROCEDIMENTO', colSpan: 1 }]], [
    [ftPdfSafe(`Preparacao e condicoes iniciais:\n${record.procedure.preparation || 'Nao informado'}`)],
    [ftPdfSafe(`Produtos, quantidades e unidades:\n${record.procedure.products || 'Nao informado'}`)],
    [ftPdfSafe(`Equipamentos e recursos:\n${record.procedure.equipment || 'Nao informado'}`)],
    [ftPdfSafe(`Sequencia das etapas e forma de aplicacao:\n${record.procedure.steps || 'Nao informado'}`)],
    [ftPdfSafe(`Duracao prevista e acompanhamento:\n${record.procedure.duration || 'Nao informado'}`)],
    [ftPdfSafe(`Coleta de amostras e avaliacao dos resultados:\n${record.procedure.sampling || 'Nao informado'}`)],
    [ftPdfSafe(`Observacoes de seguranca e referencias as FDS:\n${record.procedure.safety || 'Nao informado'}`)]
  ], { columnStyles: { 0: { cellWidth: pageWidth - margin * 2 } }, styles: { cellPadding: 3.2 } });

  const commRows = record.communications.length
    ? record.communications.map(comm => [
      ftPdfSafe(comm.revision || 'R0'),
      ftPdfSafe(comm.subject || '-'),
      ftPdfSafe(comm.recipients?.to || '-'),
      ftPdfSafe(comm.status || 'processamento'),
      ftPdfSafe(comm.sentAt ? formatDateTimeBrForm(comm.sentAt) : 'sem data confirmada')
    ])
    : [[{ content: 'Nenhuma comunicacao registrada.', colSpan: 5 }]];
  y = ftAutoTable(pdf, y, [
    [{ content: '4. COMUNICACOES REGISTRADAS (registro interno)', colSpan: 5 }],
    ['Revisao', 'Assunto', 'Destinatario', 'Situacao', 'Data']
  ], commRows, { styles: { fontSize: 8 } });

  const respRows = record.responses.length
    ? record.responses.map(resp => [
      ftPdfSafe(resp.sender || '-'),
      ftPdfSafe(resp.receivedAt ? formatDateTimeBrForm(resp.receivedAt) : 'data desconhecida'),
      ftPdfSafe((resp.content || '').slice(0, 220)),
      resp.manual ? 'Transcricao manual' : 'Original anexado'
    ])
    : [[{ content: 'Nenhuma resposta registrada.', colSpan: 4 }]];
  y = ftAutoTable(pdf, y, [
    [{ content: '5. RESPOSTAS REGISTRADAS', colSpan: 4 }],
    ['Remetente', 'Recebida em', 'Conteudo', 'Origem']
  ], respRows, { styles: { fontSize: 8 } });

  const pageCount = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    pdf.setPage(i);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(110);
    pdf.text('GRUPO SRF - documento gerado pelo Sistema-TS. Composicao de e-mail e historico sao registros internos.', margin, pageHeight - 6);
    pdf.text(`Pagina ${i} de ${pageCount}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
    pdf.setTextColor(0);
  }
  return pdf;
}

async function previewPdf() {
  const record = collectForm();
  if (!record) return;
  const previewWindow = window.open('', '_blank');
  if (previewWindow) previewWindow.opener = null;
  try {
    const pdf = await buildProcedurePdf(record);
    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);
    if (previewWindow) previewWindow.location.href = url;
    else downloadBlobForm(blob, `Pre-visualizacao_${record.number || 'formalizacao'}_${record.revision || 'R0'}.pdf`);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toastForm('Pré-visualização do PDF gerada.');
  } catch (error) {
    if (previewWindow) previewWindow.close();
    toastForm(`Não foi possível gerar o PDF: ${error.message}`, 'error', 7000);
  }
}

function bytesToBase64Form(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/* ---------- Revisão explícita ---------- */
function buildEmailBodyDefault(record) {
  const products = record.products.map(product => `- ${product.name || 'Produto'}${product.manufacturer ? ` (${product.manufacturer})` : ''}`).join('\n');
  const period = record.period ? `previsto para ${record.period}${record.unit ? ` em ${record.unit}` : ''}` : 'com data a definir';
  return `Prezados,

Encaminho as FDS dos produtos e a descrição de como será realizado o teste ${record.title || ''}, ${period}.

Produtos envolvidos:
${products || '-'}

Seguem anexos o procedimento do teste e as respectivas FDS.

Peço que respondam a este e-mail com suas observações, para mantermos a comunicação e os documentos arquivados.

${record.owner || 'Responsável pelo registro'}`;
}

function validateForSend() {
  const record = collectForm();
  if (!record) return false;
  const errors = [];
  if (!record.title) errors.push('Informe o título do teste.');
  if (!record.procedure.steps && !record.procedure.preparation) errors.push('Descreva o procedimento do teste.');
  if (!record.email.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email.to)) errors.push('Informe um e-mail válido do destinatário antes de revisar a mensagem.');
  if (!record.products.length) errors.push('Adicione ao menos um produto.');
  if (record.products.some(product => !product.name.trim())) errors.push('Informe o nome de todos os produtos.');
  const missingFds = record.products.filter(product => !product.fds);
  if (missingFds.length) errors.push(`Adicione a FDS do produto ${missingFds.map(p => p.name || 'sem nome').join(', ')} para concluir este envio.`);
  if (errors.length) {
    toastForm(errors[0], 'error', 6500);
    return false;
  }
  return true;
}

async function reviewEmail() {
  const record = collectForm();
  if (!record || !validateForSend()) return;
  if (!record.email.subject) {
    record.email.subject = `[Sistema-TS] Formalização de teste — ${record.number} — ${record.title}`;
    $f('f_email_subject').value = record.email.subject;
  }
  if (!record.email.body) {
    record.email.body = buildEmailBodyDefault(record);
    $f('f_email_body').value = record.email.body;
  }
  collectForm();
  /* A revisão é congelada no momento da revisão do e-mail, nunca entre a revisão e o envio. */
  let bumped = false;
  try {
    bumped = await maybeBumpRevision(record);
  } catch (_) {
    bumped = false;
  }
  if (bumped) {
    const revisionField = $f('f_test_revision');
    if (revisionField) revisionField.value = record.revision;
    try { await dbPut(record); } catch (_) { /* segue em memória */ }
    toastForm(`O conteúdo mudou desde a última comunicação. A revisão ${record.revision} foi criada para este envio.`, 'info', 6000);
  }
  const contentHash = await computeContentHash(record);
  let pdfAttachment = null;
  try {
    const pdf = await buildProcedurePdf(record);
    const pdfBytes = new Uint8Array(pdf.output('arraybuffer'));
    pdfAttachment = {
      name: `Procedimento_${record.number}_${record.revision}.pdf`,
      type: 'application/pdf',
      size: pdfBytes.length,
      revision: record.revision,
      sha256: await sha256Form(pdfBytes.buffer),
      base64: bytesToBase64Form(pdfBytes)
    };
  } catch (error) {
    toastForm(`Não foi possível preparar o PDF do procedimento: ${error.message}`, 'error', 7000);
    return;
  }
  state.reviewSnapshot = {
    contentHash,
    revision: record.revision,
    recipients: { ...record.email },
    subject: record.email.subject,
    body: record.email.body,
    pdf: pdfAttachment,
    attachments: record.products.map(product => ({
      name: product.fds?.name || 'FDS pendente',
      type: product.fds?.type || '',
      size: product.fds?.size || 0,
      revision: product.fds?.revision || '',
      sha256: product.fds?.sha256 || product.fds?.hash || '',
      storageId: product.fds?.storageId || ''
    }))
  };
  const review = $f('emailReview');
  review.hidden = false;
  review.innerHTML = `
    <h3>Revisão do e-mail — conferência obrigatória</h3>
    <dl>
      <dt>Destinatário</dt><dd>${escapeHtmlForm(state.reviewSnapshot.recipients.to)}</dd>
      <dt>Cópias</dt><dd>${escapeHtmlForm(state.reviewSnapshot.recipients.cc || 'Nenhuma')}</dd>
      <dt>Resposta para</dt><dd>${escapeHtmlForm(state.reviewSnapshot.recipients.reply || 'Não informado')}</dd>
      <dt>Assunto</dt><dd>${escapeHtmlForm(state.reviewSnapshot.subject)}</dd>
      <dt>Revisão</dt><dd>${escapeHtmlForm(state.reviewSnapshot.revision)}</dd>
    </dl>
    <p><strong>Corpo da mensagem:</strong></p>
    <pre>${escapeHtmlForm(state.reviewSnapshot.body)}</pre>
    <p><strong>Anexos (nome, tamanho, revisão, hash):</strong></p>
    <ul class="formalization-attachments">
      <li>
        <span class="att-name">${escapeHtmlForm(state.reviewSnapshot.pdf.name)}</span>
        <span class="att-meta">${escapeHtmlForm(formatBytesForm(state.reviewSnapshot.pdf.size))} · Revisão: ${escapeHtmlForm(state.reviewSnapshot.pdf.revision)} · Hash: ${escapeHtmlForm(String(state.reviewSnapshot.pdf.sha256).slice(0, 16))}…</span>
      </li>
      ${state.reviewSnapshot.attachments.map(att => `
        <li>
          <span class="att-name">${escapeHtmlForm(att.name)}</span>
          <span class="att-meta">${escapeHtmlForm(formatBytesForm(att.size))} · Revisão: ${escapeHtmlForm(att.revision || 'não informada')} · Hash: ${escapeHtmlForm(String(att.sha256 || '').slice(0, 16))}…</span>
        </li>`).join('')}
    </ul>
    <p class="note">O envio só acontece após esta confirmação. Destinatários, assunto, corpo e anexos exibidos aqui são exatamente o que será transmitido.</p>
    <div class="actions">
      <button type="button" class="btn btn-secondary" id="btnBackEdit">Voltar e editar</button>
      <button type="button" class="btn btn-primary" id="btnConfirmSend">Enviar e-mail</button>
    </div>`;
  $f('btnBackEdit').addEventListener('click', () => {
    state.reviewSnapshot = null;
    review.hidden = true;
  });
  $f('btnConfirmSend').addEventListener('click', confirmSend);
}

async function confirmSend() {
  if (state.sending) return;
  const record = getRecord();
  const snapshot = state.reviewSnapshot;
  if (!record || !snapshot) {
    toastForm('Revise o e-mail antes de confirmar o envio.', 'error');
    return;
  }
  if (navigator.onLine === false) {
    toastForm('Sem conexão. O envio exige comunicação com o sistema.', 'error');
    return;
  }
  const button = $f('btnConfirmSend');
  state.sending = true;
  setBusyForm(button, true, 'Enviando…');

  try {
    collectForm();
    const currentHash = await computeContentHash(record);
    if (currentHash !== snapshot.contentHash) {
      state.reviewSnapshot = null;
      $f('emailReview').hidden = true;
      toastForm('O registro mudou desde a revisão. Revise o e-mail novamente.', 'error', 7000);
      return;
    }
    const finalHash = await computeContentHash(record);
    const revision = record.revision;
    const idempotencyKey = `send_${record.id}_${revision}_${finalHash.slice(0, 32)}`;

    const uploadFailures = await ensureFdsOnServer(record);
    if (uploadFailures.length) {
      updateFdsValidation();
      throw new Error(`FDS não arquivadas no sistema: ${uploadFailures.join(' | ')}`);
    }

    if (!snapshot.pdf || !snapshot.pdf.base64) {
      throw new Error('O PDF revisado não está mais disponível. Revise o e-mail novamente.');
    }
    const attachments = [
      { name: snapshot.pdf.name, type: 'application/pdf', size: snapshot.pdf.size, sha256: snapshot.pdf.sha256, base64: snapshot.pdf.base64 },
      ...record.products.map(product => ({
        name: product.fds.name,
        type: product.fds.type || 'application/pdf',
        size: product.fds.size,
        sha256: product.fds.sha256 || product.fds.hash,
        storageId: product.fds.storageId
      }))
    ];

    const communication = {
      id: crypto.randomUUID ? crypto.randomUUID() : `comm_${Date.now()}`,
      idempotencyKey,
      contentHash: finalHash,
      revision,
      recipients: { to: record.email.to, cc: record.email.cc, reply: record.email.reply },
      subject: snapshot.subject,
      body: snapshot.body,
      attachments: attachments.map(att => ({ name: att.name, type: att.type, size: att.size, sha256: att.sha256, storageId: att.storageId || '' })),
      status: 'processamento',
      createdAt: nowIsoForm(),
      sentAt: '',
      simulated: false,
      error: ''
    };
    record.communications.push(communication);
    addHistory(record, `Envio iniciado na revisão ${revision}`, [communication.id]);
    await dbPut(record);

    try {
      const result = await window.AppCore.api('FORMALIZATION_SEND', {
        formalizationId: record.id,
        communicationId: communication.id,
        revision,
        idempotencyKey,
        contentHash: finalHash,
        recipients: communication.recipients,
        subject: communication.subject,
        body: communication.body,
        attachments
      }, { timeoutMs: 120000 });

      if (result.communicationState === 'enviado') {
        communication.status = 'enviado';
        communication.sentAt = result.sentAt || nowIsoForm();
        communication.simulated = result.simulated === true;
        record.status = 'enviado';
        addHistory(record, result.simulated ? 'Envio simulado registrado (transporte de teste)' : 'E-mail enviado e registrado', [communication.id]);
        toastForm(result.simulated
          ? 'Envio simulado registrado. Nenhuma mensagem real foi transmitida.'
          : 'E-mail enviado e registrado no sistema.');
      } else {
        communication.status = 'pendente';
        communication.error = result.message || 'Estado de envio não confirmado.';
        addHistory(record, 'Confirmação de envio pendente', [communication.id]);
        toastForm('Confirmação de envio pendente. Consulte a situação desta comunicação antes de reenviar.', 'error', 8000);
      }
    } catch (error) {
      if (error.code === 'send_uncertain' || error.code === 'network' || error.code === 'timeout') {
        communication.status = 'confirmacao_pendente';
        communication.error = error.message;
        addHistory(record, 'Confirmação de envio pendente', [communication.id]);
        toastForm('Não foi possível confirmar o envio. Consulte a situação desta comunicação antes de tentar novamente.', 'error', 9000);
      } else if (error.code === 'idempotency_conflict') {
        communication.status = 'pendente';
        communication.error = error.message;
        addHistory(record, 'Conflito de idempotência no envio', [communication.id]);
        toastForm(error.message, 'error', 8000);
      } else {
        communication.status = 'pendente';
        communication.error = error.message;
        addHistory(record, `Falha no envio: ${error.message}`, [communication.id]);
        toastForm(`Falha no envio: ${error.message}`, 'error', 8000);
      }
    } finally {
      state.reviewSnapshot = null;
      $f('emailReview').hidden = true;
      await dbPut(record);
      renderForm(record);
      renderList();
      saveDraft(true);
    }
  } catch (error) {
    toastForm(error.message || 'Não foi possível preparar o envio.', 'error', 8000);
  } finally {
    state.sending = false;
    setBusyForm(button, false);
  }
}

/* ---------- Comunicações ---------- */
function renderCommunications(record) {
  const container = $f('communicationsList');
  if (!container) return;
  if (!record.communications.length) {
    container.innerHTML = '<p class="assist-note">Nenhuma comunicação registrada. Cada envio gera uma comunicação rastreável com revisão e anexos.</p>';
    return;
  }
  const seenLabels = new Set();
  container.innerHTML = record.communications.map(comm => {
    const stateLabel = comm.status === 'enviado' ? 'Enviado' : comm.status === 'confirmacao_pendente' ? 'Confirmação de envio pendente' : comm.status === 'pendente' ? 'Pendente' : 'Em processamento';
    const stateClass = comm.status === 'enviado' ? 'sent' : comm.status === 'pendente' || comm.status === 'confirmacao_pendente' ? 'pending' : '';
    const when = comm.sentAt ? formatDateTimeBrForm(comm.sentAt) : formatDateTimeBrForm(comm.createdAt);
    const attachments = (comm.attachments || []).map(att => att.name).join(', ');
    return `<div class="communication-card" data-communication="${escapeHtmlForm(comm.id)}">
      <span class="comm-subject">${escapeHtmlForm(comm.subject || 'Sem assunto')}</span>
      <span class="comm-meta">Revisão ${escapeHtmlForm(comm.revision || 'R0')} · ${escapeHtmlForm(when)} · Para: ${escapeHtmlForm(comm.recipients?.to || '-')}</span>
      <span class="comm-meta">Anexos: ${escapeHtmlForm(attachments || 'nenhum')}</span>
      <span class="comm-state ${stateClass}">${escapeHtmlForm(stateLabel)}${comm.simulated ? ' (simulado)' : ''}</span>
      ${comm.error ? `<span class="comm-meta">Detalhe: ${escapeHtmlForm(comm.error)}</span>` : ''}
      <div class="comm-actions">
        ${comm.status !== 'enviado' ? `<button type="button" class="btn btn-small" data-check-comm="${escapeHtmlForm(comm.id)}">Consultar situação</button>` : ''}
        ${comm.status === 'pendente' || comm.status === 'confirmacao_pendente' ? `<button type="button" class="btn btn-small" data-resend-comm="${escapeHtmlForm(comm.id)}">Reenviar (com aviso)</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function checkCommunicationStatus(communicationId) {
  const record = getRecord();
  const comm = record?.communications.find(item => item.id === communicationId);
  if (!comm) return;
  try {
    const result = await window.AppCore.api('FORMALIZATION_SEND_STATUS', { communicationId }, { timeoutMs: 30000 });
    const serverState = result.communicationState || result.status?.communicationState || '';
    if (serverState === 'enviado') {
      comm.status = 'enviado';
      comm.sentAt = result.sentAt || result.status?.sentAt || comm.sentAt;
      if (record.status !== 'resposta' && record.status !== 'arquivado') record.status = 'enviado';
      addHistory(record, 'Situação do envio consultada: enviado', [comm.id]);
      toastForm('Envio confirmado como enviado.');
    } else if (serverState === 'pendente') {
      comm.status = 'pendente';
      addHistory(record, 'Situação do envio consultada: pendente', [comm.id]);
      toastForm('O sistema ainda registra este envio como pendente.', 'error', 7000);
    } else {
      toastForm(`Situação retornada pelo sistema: ${serverState || 'desconhecida'}.`, 'error', 7000);
    }
    await dbPut(record);
    renderForm(record);
    renderList();
    saveDraft(true);
  } catch (error) {
    toastForm(`Não foi possível consultar a situação: ${error.message}`, 'error', 7000);
  }
}

async function resendCommunication(communicationId) {
  const record = getRecord();
  const comm = record?.communications.find(item => item.id === communicationId);
  if (!record || !comm) return;
  const currentHash = await computeContentHash(record);
  if (currentHash !== comm.contentHash) {
    toastForm('O conteúdo mudou desde este envio. Salve o rascunho (nova revisão) e revise o e-mail novamente.', 'error', 8000);
    return;
  }
  if (!window.confirm('Reenviar esta comunicação? Se a mensagem anterior tiver sido transmitida, o destinatário pode receber uma duplicata. Esta é a única forma de reenvio.')) return;
  try {
    const pdf = await buildProcedurePdf(record);
    const pdfBytes = new Uint8Array(pdf.output('arraybuffer'));
    const pdfHash = await sha256Form(pdfBytes.buffer);
    const attachments = [
      { name: `Procedimento_${record.number}_${record.revision}.pdf`, type: 'application/pdf', size: pdfBytes.length, sha256: pdfHash, base64: bytesToBase64Form(pdfBytes) },
      ...record.products.map(product => ({
        name: product.fds.name,
        type: product.fds.type || 'application/pdf',
        size: product.fds.size,
        sha256: product.fds.sha256 || product.fds.hash,
        storageId: product.fds.storageId
      }))
    ];
    const result = await window.AppCore.api('FORMALIZATION_SEND', {
      formalizationId: record.id,
      communicationId: comm.id,
      revision: comm.revision,
      idempotencyKey: comm.idempotencyKey,
      contentHash: comm.contentHash,
      recipients: comm.recipients,
      subject: comm.subject,
      body: comm.body,
      attachments
    }, { timeoutMs: 120000 });
    if (result.reused === true) {
      comm.status = result.communicationState === 'enviado' ? 'enviado' : 'pendente';
      comm.sentAt = result.sentAt || comm.sentAt;
      toastForm(result.communicationState === 'enviado'
        ? 'O sistema confirmou que esta comunicação já estava enviada. Nenhuma duplicata foi transmitida.'
        : 'O sistema mantém esta comunicação pendente.');
    } else if (result.communicationState === 'enviado') {
      comm.status = 'enviado';
      comm.sentAt = result.sentAt || nowIsoForm();
      record.status = 'enviado';
      addHistory(record, 'Reenvio explícito confirmado', [comm.id]);
      toastForm('Comunicação reenviada e confirmada.');
    }
    await dbPut(record);
    renderForm(record);
    renderList();
    saveDraft(true);
  } catch (error) {
    toastForm(`Não foi possível reenviar: ${error.message}`, 'error', 8000);
  }
}

/* ---------- Visualizador de documentos ---------- */
let currentDocDownload = null;
let currentDocUrl = '';

function openDocModal(title) {
  $f('docViewTitle').textContent = title || 'Documento';
  $f('docViewBody').innerHTML = '';
  $f('docViewModal').hidden = false;
}

function closeDocModal() {
  $f('docViewModal').hidden = true;
  $f('docViewBody').innerHTML = '';
  if (currentDocUrl) {
    URL.revokeObjectURL(currentDocUrl);
    currentDocUrl = '';
  }
  currentDocDownload = null;
}

function openDocViewFromBytes(name, mimeType, bytes) {
  openDocModal(name || 'Documento');
  const body = $f('docViewBody');
  const isPdf = /pdf/i.test(mimeType || '') || /\.pdf$/i.test(name || '');
  const blob = new Blob([bytes], { type: mimeType || (isPdf ? 'application/pdf' : 'text/plain') });
  currentDocDownload = { name: name || 'documento', blob };
  if (isPdf) {
    currentDocUrl = URL.createObjectURL(blob);
    body.innerHTML = `<iframe title="${escapeHtmlForm(name || 'Documento PDF')}" src="${currentDocUrl}" style="width:100%;height:60dvh;border:0;background:#fff"></iframe>`;
  } else {
    const text = new TextDecoder('utf-8').decode(bytes);
    body.innerHTML = `<pre>${escapeHtmlForm(text)}</pre>`;
  }
}

function openDocViewFromDataUrl(name, mimeType, dataUrl) {
  const parts = String(dataUrl || '').split(',');
  const header = parts[0] || '';
  const base64 = parts[1] || '';
  const inferred = mimeType || (header.includes('application/pdf') ? 'application/pdf' : 'text/plain');
  openDocViewFromBytes(name, inferred, base64ToBytesForm(base64));
}

async function openDocViewFromServer(storageId, fallbackName) {
  openDocModal(fallbackName || 'Documento');
  const body = $f('docViewBody');
  body.innerHTML = '<div class="list-state" style="min-height:120px"><div><div class="spinner" aria-hidden="true"></div><strong>Abrindo documento…</strong></div></div>';
  try {
    const result = await window.AppCore.api('FORMALIZATION_DOC_GET', { storageId }, { timeoutMs: 60000 });
    openDocViewFromBytes(result.name || fallbackName, result.mimeType, base64ToBytesForm(result.base64));
  } catch (error) {
    body.innerHTML = `<div class="list-state list-state--error" style="min-height:120px"><div><strong>Não foi possível abrir o documento.</strong><span>${escapeHtmlForm(error.message)}</span></div></div>`;
  }
}

function downloadCurrentDoc() {
  if (!currentDocDownload) {
    toastForm('Nenhum documento carregado.', 'error');
    return;
  }
  const url = URL.createObjectURL(currentDocDownload.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = currentDocDownload.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- Histórico ---------- */
function renderHistory(record) {
  const container = $f('historyList');
  if (!container) return;
  const events = [...record.history].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  if (!events.length) {
    container.innerHTML = '<p class="assist-note">Sem eventos registrados.</p>';
    return;
  }
  container.innerHTML = events.map(event => {
    const links = Array.isArray(event.links) ? event.links : [];
    const buttons = [];
    links.forEach(linkId => {
      const response = record.responses.find(item => item.id === linkId);
      if (response && response.file && response.file.storageId) {
        buttons.push(`<button type="button" class="btn btn-small" data-open-doc="${escapeHtmlForm(response.file.storageId)}" data-doc-name="${escapeHtmlForm(response.file.name)}">Abrir resposta original</button>`);
      }
      const product = record.products.find(item => item.fds && item.fds.id === linkId);
      if (product && product.fds.storageId) {
        buttons.push(`<button type="button" class="btn btn-small" data-open-doc="${escapeHtmlForm(product.fds.storageId)}" data-doc-name="${escapeHtmlForm(product.fds.name)}">Abrir FDS</button>`);
      }
    });
    return `<div class="formalization-history-item">
      <strong>${escapeHtmlForm(event.action)}</strong>
      <span class="history-meta">${escapeHtmlForm(formatDateTimeBrForm(event.at))} · Responsável: ${escapeHtmlForm(event.actor || '-')} · Revisão: ${escapeHtmlForm(event.revision || 'R0')}</span>
      ${buttons.length ? `<div class="history-links">${buttons.join('')}</div>` : ''}
    </div>`;
  }).join('');
}

/* ---------- Registrar resposta ---------- */
function showResponseError(message) {
  const element = $f('responseError');
  element.textContent = message;
  element.hidden = !message;
}

function toDateTimeLocalValue(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function decodeMimeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, payload) => {
    try {
      let bytes;
      if (String(encoding).toUpperCase() === 'B') {
        const binary = atob(String(payload).replace(/\s+/g, ''));
        bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      } else {
        const decoded = String(payload).replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
      }
      return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch (_) {
      return match;
    }
  });
}

function parseEmlHeaders(text) {
  const headerBlock = String(text || '').split(/\r?\n\r?\n/)[0] || '';
  const headers = {};
  let current = '';
  headerBlock.split(/\r?\n/).forEach(line => {
    if (/^\s/.test(line) && current) {
      headers[current] += ' ' + line.trim();
      return;
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (match) {
      current = match[1].toLowerCase();
      headers[current] = match[2];
    }
  });
  const date = headers.date ? new Date(headers.date) : null;
  return {
    from: decodeMimeWords(headers.from || ''),
    subject: decodeMimeWords(headers.subject || ''),
    date: date && !isNaN(date.getTime()) ? date : null
  };
}

function openResponseModal() {
  const record = getRecord();
  if (!record) return;
  if (!record.communications.length) {
    toastForm('Envie o procedimento por e-mail antes de registrar respostas.', 'error', 7000);
    return;
  }
  const select = $f('responseCommunication');
  select.innerHTML = '<option value="" selected disabled>Selecione a comunicação correta…</option>' + record.communications.map(comm => {
    const label = `${comm.revision || 'R0'} · ${comm.subject || 'sem assunto'} · ${formatDateTimeBrForm(comm.sentAt || comm.createdAt)}`;
    return `<option value="${escapeHtmlForm(comm.id)}">${escapeHtmlForm(label)}</option>`;
  }).join('');
  $f('responseReceivedAt').value = '';
  $f('responseSender').value = '';
  $f('responseContent').value = '';
  $f('responseFile').value = '';
  $f('responseManual').checked = false;
  showResponseError('');
  $f('responseModal').hidden = false;
  select.focus();
}

async function handleResponseFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!/\.eml$/i.test(file.name)) return;
  try {
    const text = await file.text();
    const parsed = parseEmlHeaders(text);
    if (parsed.from) $f('responseSender').value = parsed.from;
    if (parsed.date) $f('responseReceivedAt').value = toDateTimeLocalValue(parsed.date);
    $f('responseManual').checked = false;
    if (!parsed.from && !parsed.date) {
      $f('responseManual').checked = true;
      showResponseError('Não foi possível ler remetente/data do .eml. Preencha manualmente e marque a transcrição.');
    } else {
      showResponseError('');
    }
  } catch (_) {
    $f('responseManual').checked = true;
    showResponseError('Não foi possível ler o .eml. Preencha manualmente e marque a transcrição.');
  }
}

async function submitResponse(event) {
  event.preventDefault();
  const record = getRecord();
  if (!record) return;
  const communicationId = $f('responseCommunication').value;
  if (!communicationId) {
    showResponseError('Selecione a comunicação correspondente. Não usamos "a mais recente" automaticamente.');
    return;
  }
  const sender = $f('responseSender').value.trim();
  const content = $f('responseContent').value.trim();
  const receivedRaw = $f('responseReceivedAt').value;
  const manual = $f('responseManual').checked;
  const file = $f('responseFile').files?.[0] || null;
  if (!content && !file) {
    showResponseError('Anexe o original (.eml/PDF) ou informe o conteúdo/resumo da resposta.');
    return;
  }
  const submitButton = $f('btnResponseSubmit');
  setBusyForm(submitButton, true, 'Registrando…');
  try {
    const payload = {
      formalizationId: record.id,
      communicationId,
      sender,
      receivedAt: receivedRaw ? new Date(receivedRaw).toISOString() : '',
      content,
      manual
    };
    let fileHash = '';
    if (file) {
      const { base64 } = await readFileAsBase64Form(file);
      const bytes = base64ToBytesForm(base64);
      fileHash = await sha256Form(bytes.buffer);
      payload.fileName = file.name;
      payload.mimeType = file.type || (/\.eml$/i.test(file.name) ? 'message/rfc822' : 'application/pdf');
      payload.size = file.size;
      payload.sha256 = fileHash;
      payload.fileBase64 = base64;
    }
    let result;
    try {
      result = await window.AppCore.api('FORMALIZATION_RESPONSE', payload, { timeoutMs: 90000 });
    } catch (error) {
      if (error.code === 'duplicate_document') {
        if (!window.confirm('Este arquivo já foi registrado como resposta (hash idêntico). Registrar mesmo assim?')) {
          setBusyForm(submitButton, false);
          return;
        }
        result = await window.AppCore.api('FORMALIZATION_RESPONSE', { ...payload, confirmDuplicate: true }, { timeoutMs: 90000 });
      } else {
        throw error;
      }
    }
    const response = {
      id: crypto.randomUUID ? crypto.randomUUID() : `resp_${Date.now()}`,
      communicationId,
      sender: result.sender || sender,
      receivedAt: result.receivedAt || '',
      registeredAt: result.registeredAt || nowIsoForm(),
      registeredBy: record.owner || 'Usuário local',
      content,
      sourceType: file ? (/\.eml$/i.test(file.name) ? 'eml' : 'pdf') : 'manual',
      manual: result.manual === true || manual || !file,
      file: result.storageId ? {
        name: result.fileName || file.name,
        type: file?.type || (/\.eml$/i.test(file?.name || '') ? 'message/rfc822' : 'application/pdf'),
        size: result.size || file?.size || 0,
        hash: result.sha256 || fileHash,
        storageId: result.storageId
      } : null
    };
    record.responses.push(response);
    addHistory(record, 'Resposta registrada', [response.id]);
    if (record.status !== 'arquivado') record.status = 'resposta';
    await dbPut(record);
    $f('responseModal').hidden = true;
    renderForm(record);
    renderList();
    toastForm('Resposta registrada. O teste não foi aprovado automaticamente.');
    saveDraft(true);
  } catch (error) {
    showResponseError(error.message || 'Não foi possível registrar a resposta.');
  } finally {
    setBusyForm(submitButton, false);
  }
}

/* ============================================
   Exportação da documentação (ZIP sem compressão)
   - PDF do procedimento
   - FDS originais
   - Respostas originais
   - histórico.json + INDICE.txt + LEIA-ME.txt
   ============================================ */
const FT_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32Form(bytes) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = FT_CRC_TABLE[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTimeForm(date = new Date()) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { time, day };
}

function buildZipForm(entries) {
  const chunks = [];
  const central = [];
  const { time, day } = dosDateTimeForm();
  let offset = 0;
  entries.forEach(entry => {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || []);
    const crc = crc32Form(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034B50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); /* nomes em UTF-8 */
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const directory = new Uint8Array(46 + nameBytes.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014B50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, 0x0800, true);
    directoryView.setUint16(10, 0, true);
    directoryView.setUint16(12, time, true);
    directoryView.setUint16(14, day, true);
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, data.length, true);
    directoryView.setUint32(24, data.length, true);
    directoryView.setUint16(28, nameBytes.length, true);
    directoryView.setUint32(38, 0, true);
    directoryView.setUint32(42, offset, true);
    directory.set(nameBytes, 46);
    central.push(directory);
    offset += local.length + data.length;
  });

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054B50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

function safeFileNameForm(value, fallback = 'documento') {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
  const cleaned = normalized.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 90);
  return cleaned || fallback;
}

function uniqueZipName(used, folder, fileName) {
  const clean = safeFileNameForm(fileName, 'documento');
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const extension = dot > 0 ? clean.slice(dot) : '';
  let counter = 2;
  let name = folder ? `${folder}/${clean}` : clean;
  while (used.has(name.toLowerCase())) {
    const candidate = `${stem}_${counter}${extension}`;
    name = folder ? `${folder}/${candidate}` : candidate;
    counter += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function downloadBlobForm(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

function stripHeavyFieldsForm(record) {
  const copy = JSON.parse(JSON.stringify(record));
  (copy.products || []).forEach(product => { if (product.fds) delete product.fds.dataUrl; });
  (copy.responses || []).forEach(response => { if (response.file) delete response.file.dataUrl; });
  (copy.communications || []).forEach(communication => {
    (communication.attachments || []).forEach(attachment => { delete attachment.base64; delete attachment.dataUrl; });
  });
  return copy;
}

function docBytesFromDataUrl(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  return base64 ? base64ToBytesForm(base64) : null;
}

async function fetchDocBytesForm(storageId) {
  const result = await window.AppCore.api('FORMALIZATION_DOC_GET', { storageId }, { timeoutMs: 60000 });
  return {
    name: result.name || '',
    mimeType: result.mimeType || '',
    bytes: base64ToBytesForm(result.base64)
  };
}

async function exportDocumentation() {
  const record = collectForm();
  if (!record) {
    toastForm('Crie ou abra uma formalização antes de exportar.', 'error');
    return;
  }
  const button = $f('btnExportDocs');
  setBusyForm(button, true, 'Gerando pacote…');
  const entries = [];
  const used = new Set();
  const pending = [];
  try {
    const pdf = await buildProcedurePdf(record);
    const pdfBytes = new Uint8Array(pdf.output('arraybuffer'));
    entries.push({
      name: uniqueZipName(used, '', `Procedimento_${record.number}_${record.revision}.pdf`),
      data: pdfBytes
    });

    for (const product of record.products) {
      const fds = product.fds;
      if (!fds) {
        pending.push(`FDS ausente: ${product.name || 'produto sem nome'}.`);
        continue;
      }
      let bytes = fds.dataUrl ? docBytesFromDataUrl(fds.dataUrl) : null;
      if (!bytes && fds.storageId) {
        try {
          bytes = (await fetchDocBytesForm(fds.storageId)).bytes;
        } catch (error) {
          pending.push(`FDS não recuperada do sistema (${product.name || 'produto sem nome'}): ${error.message}`);
        }
      }
      if (!bytes) {
        pending.push(`FDS sem arquivo recuperável: ${product.name || 'produto sem nome'}.`);
        continue;
      }
      entries.push({ name: uniqueZipName(used, 'FDS', fds.name || `FDS_${product.name}.pdf`), data: bytes });
    }

    for (const response of record.responses) {
      const file = response.file;
      if (!file) {
        pending.push(`Resposta de ${response.sender || 'remetente não informado'} sem arquivo original (transcrição manual).`);
        continue;
      }
      let bytes = file.dataUrl ? docBytesFromDataUrl(file.dataUrl) : null;
      if (!bytes && file.storageId) {
        try {
          bytes = (await fetchDocBytesForm(file.storageId)).bytes;
        } catch (error) {
          pending.push(`Resposta não recuperada do sistema (${file.name || 'arquivo'}): ${error.message}`);
        }
      }
      if (!bytes) {
        pending.push(`Resposta sem arquivo recuperável: ${file.name || 'arquivo'}.`);
        continue;
      }
      entries.push({ name: uniqueZipName(used, 'Respostas', file.name || 'resposta.eml'), data: bytes });
    }

    entries.push({
      name: uniqueZipName(used, '', 'historico.json'),
      data: new TextEncoder().encode(JSON.stringify(stripHeavyFieldsForm(record), null, 2))
    });

    const indexLines = [
      'GRUPO SRF — FORMALIZAÇÃO DE TESTES',
      '=================================',
      `Registro: ${record.number || 'sem número'} — ${record.revision || 'R0'}`,
      `Título: ${record.title || 'não informado'}`,
      `Responsável: ${record.owner || 'não informado'}`,
      `Situação: ${record.status || 'rascunho'}`,
      `Exportado em: ${formatDateTimeBrForm(nowIsoForm())}`,
      '',
      'ARQUIVOS',
      '--------'
    ];
    entries.forEach((entry, index) => {
      indexLines.push(`${String(index + 1).padStart(2, '0')}. ${entry.name} (${formatBytesForm(entry.data.length)})`);
    });
    indexLines.push('', 'PENDÊNCIAS', '----------');
    indexLines.push(...(pending.length ? pending.map(item => `- ${item}`) : ['Nenhuma pendência registrada no momento da exportação.']));
    indexLines.push(
      '',
      'OBSERVAÇÕES',
      '-----------',
      '- historico.json é o registro interno completo (composição de e-mail, envios e eventos).',
      '- A composição de e-mail exibida é um registro interno, não um documento assinado.',
      '- FDS e respostas são os arquivos originais, sem edição.',
      '- Este pacote não substitui os originais arquivados no sistema.'
    );
    entries.push({
      name: uniqueZipName(used, '', 'INDICE.txt'),
      data: new TextEncoder().encode(indexLines.join('\n'))
    });
    entries.push({
      name: uniqueZipName(used, '', 'LEIA-ME.txt'),
      data: new TextEncoder().encode([
        'GRUPO SRF — SISTEMA-TS',
        '',
        'Este pacote reúne o procedimento em PDF, as FDS e as respostas originais',
        'registradas para esta formalização, além do histórico interno em JSON.',
        '',
        'Nenhum conteúdo foi inventado pelo sistema: campos não preenchidos',
        'permanecem vazios e documentos ausentes são listados como pendência.',
        '',
        `Gerado em ${formatDateTimeBrForm(nowIsoForm())} pela versão ${FORMALIZATION_VERSION}.`
      ].join('\n'))
    });

    const zip = buildZipForm(entries);
    downloadBlobForm(zip, `Formalizacao_${safeFileNameForm(record.number || record.id)}_${safeFileNameForm(record.revision || 'R0')}.zip`);
    toastForm(pending.length
      ? `Pacote gerado com ${pending.length} pendência(s). Consulte INDICE.txt.`
      : 'Pacote de documentação gerado.', pending.length ? 'error' : 'info', pending.length ? 8000 : 4500);
  } catch (error) {
    toastForm(`Não foi possível exportar: ${error.message}`, 'error', 8000);
  } finally {
    setBusyForm(button, false);
  }
}

/* ============================================
   Lista / abertura de registros
   ============================================ */
function stubFromListItem(item) {
  return {
    stub: true,
    id: item.id,
    number: item.number || '',
    title: item.title || '',
    status: item.status || 'rascunho',
    revision: item.revision || 'R0',
    updatedAt: item.updatedAt || '',
    createdAt: item.updatedAt || '',
    products: Array.isArray(item.products) ? item.products.map(name => ({ name: String(name || '') })) : [],
    procedure: { preparation: '', products: '', equipment: '', steps: '', duration: '', sampling: '', safety: '' },
    email: { to: '', cc: '', reply: '', subject: '', body: '' },
    history: [],
    communications: [],
    responses: [],
    baseVersion: Number(item.version) || 0,
    syncStatus: 'server'
  };
}

function mergeServerItems(items) {
  const serverIds = new Set();
  items.forEach(item => {
    if (!item || !item.id) return;
    serverIds.add(item.id);
    const existing = state.records.find(record => record.id === item.id);
    if (!existing) {
      state.records.push(stubFromListItem(item));
      return;
    }
    if (existing.stub) {
      Object.assign(existing, stubFromListItem(item));
      return;
    }
    existing.onServer = true;
    existing.serverVersion = Number(item.version) || 0;
    if (existing.serverVersion > (existing.baseVersion || 0)) {
      existing.serverUpdatedAt = item.updatedAt || '';
    }
  });
  state.records = state.records.filter(record => !record.stub || serverIds.has(record.id));
}

async function loadRecords(options = {}) {
  state.listState = 'loading';
  renderList();

  let localRecords = [];
  try {
    localRecords = await dbAll();
  } catch (_) {
    localRecords = [];
  }
  localRecords.forEach(record => {
    if (!record || !record.id) return;
    if (!state.records.some(item => item.id === record.id)) state.records.push(record);
  });

  if (!window.AppCore.hasKey()) {
    state.serverReachable = false;
    state.listState = 'local';
    renderList();
    return;
  }
  if (navigator.onLine === false) {
    state.serverReachable = false;
    state.listState = 'local';
    state.listError = 'Sem conexão com a internet.';
    renderList();
    return;
  }

  const attempts = options.retry === false ? 1 : 2;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await window.AppCore.api('FORMALIZATION_LIST', {}, { timeoutMs: 30000 });
      mergeServerItems(Array.isArray(result.items) ? result.items : []);
      state.serverReachable = true;
      state.listError = '';
      state.listState = 'ready';
      renderList();
      return;
    } catch (error) {
      lastError = error;
      if (error.code === 'authorization_required') {
        state.serverReachable = false;
        state.listState = state.records.length ? 'ready' : 'local';
        renderList();
        return;
      }
    }
  }

  state.serverReachable = false;
  state.listError = lastError?.message || 'Erro de comunicação.';
  state.listState = state.records.length ? 'ready' : 'error';
  renderList();
  if (state.records.length) {
    toastForm(`Lista do sistema indisponível: ${state.listError} Exibindo dados deste dispositivo.`, 'error', 7000);
  }
}

async function flushPendingSave() {
  clearTimeout(state.saveTimer);
  if (state.dirty) await saveDraft(true);
}

function nextFormalizationNumber() {
  let max = 0;
  state.records.forEach(record => {
    const match = /^FT-(\d+)/i.exec(String(record.number || ''));
    if (match) max = Math.max(max, parseInt(match[1], 10));
  });
  return `FT-${String(max + 1).padStart(4, '0')}`;
}

async function newFormalizacao() {
  await flushPendingSave();
  const record = createEmptyRecord();
  record.number = nextFormalizationNumber();
  if (!record.number || record.number === 'FT-0000') record.number = 'FT-0001';
  state.records.unshift(record);
  state.currentId = record.id;
  try { await dbPut(record); } catch (_) { /* rascunho em memória */ }
  state.listState = 'ready';
  renderForm(record);
  $f('f_test_title')?.focus();
  toastForm('Nova formalização criada neste dispositivo. Preencha os dados reais.');
}

function replaceRecord(updated) {
  const index = state.records.findIndex(record => record.id === updated.id);
  if (index >= 0) state.records[index] = updated;
  else state.records.unshift(updated);
}

async function openRecord(recordId) {
  const existing = state.records.find(record => record.id === recordId);
  if (!existing) return;
  await flushPendingSave();
  state.currentId = recordId;

  if (!existing.stub) renderForm(existing);

  if (!window.AppCore.hasKey() || navigator.onLine === false) {
    if (existing.stub) {
      state.currentId = null;
      toastForm('Conecte-se ao sistema e informe a chave de acesso para abrir este registro.', 'error', 7000);
      if (!window.AppCore.hasKey()) window.AppCore.openGate('Informe a chave para abrir o registro arquivado no sistema.');
    }
    return;
  }

  try {
    const result = await window.AppCore.api('FORMALIZATION_GET', { id: recordId }, { timeoutMs: 30000 });
    const serverRecord = result.formalization;
    if (!serverRecord || typeof serverRecord !== 'object') throw new Error('Registro vazio no sistema.');
    serverRecord.baseVersion = Number(result.version) || 0;
    serverRecord.syncStatus = 'server';
    serverRecord.stub = false;

    if (!existing.stub && existing.syncStatus === 'local' && !state.dirty) {
      const localTime = new Date(existing.updatedAt || 0).getTime();
      const serverTime = new Date(serverRecord.updatedAt || 0).getTime();
      if (localTime > serverTime) {
        state.conflictPayload = { record: existing, serverVersion: serverRecord.baseVersion, serverRecord };
        $f('conflictServerVersion').textContent = String(serverRecord.baseVersion);
        $f('conflictModal').hidden = false;
        return;
      }
    }

    replaceRecord(serverRecord);
    state.currentId = serverRecord.id;
    try { await dbPut(serverRecord); } catch (_) { /* segue em memória */ }
    renderForm(serverRecord);
  } catch (error) {
    if (existing.stub) {
      state.currentId = null;
      $f('formalizacaoForm').hidden = true;
      $f('formalizacaoList').hidden = false;
      renderList();
      toastForm(`Não foi possível abrir o registro no sistema: ${error.message}`, 'error', 8000);
    } else {
      toastForm(`Abrindo a cópia salva neste dispositivo. Sistema: ${error.message}`, 'error', 8000);
    }
  }
}

async function backToList() {
  await flushPendingSave();
  state.currentId = null;
  state.reviewSnapshot = null;
  const review = $f('emailReview');
  if (review) review.hidden = true;
  $f('formalizacaoForm').hidden = true;
  $f('formalizacaoList').hidden = false;
  renderList();
}

function clearFilters() {
  const search = $f('searchFormalizacao');
  if (search) search.value = '';
  ['filterStatus', 'filterFrom', 'filterTo'].forEach(id => { const element = $f(id); if (element) element.value = ''; });
  renderList();
}

/* ============================================
   Eventos e inicialização
   ============================================ */
function wireFormalizationEvents() {
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  $f('btnNewFormalizacao')?.addEventListener('click', () => { newFormalizacao(); });

  $f('formalizacaoList')?.addEventListener('click', event => {
    const openButton = event.target.closest('[data-open]');
    if (openButton) {
      openRecord(openButton.dataset.open);
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    if (actionButton.dataset.action === 'retry-list') loadRecords();
    if (actionButton.dataset.action === 'new') newFormalizacao();
    if (actionButton.dataset.action === 'clear-filters') clearFilters();
    if (actionButton.dataset.action === 'open-gate') window.AppCore.openGate('Informe a chave de acesso para consultar o sistema.');
  });

  $f('searchFormalizacao')?.addEventListener('input', renderList);
  ['filterStatus', 'filterFrom', 'filterTo'].forEach(id => {
    $f(id)?.addEventListener('change', renderList);
  });
  $f('btnClearFilters')?.addEventListener('click', clearFilters);

  const form = $f('formalizacaoForm');
  form?.addEventListener('submit', event => event.preventDefault());
  form?.addEventListener('input', event => {
    if (event.target.closest('#emailReview')) return;
    markDirty();
  });
  form?.addEventListener('change', event => {
    if (event.target.closest('#emailReview')) return;
    markDirty();
  });

  $f('btnAddProduct')?.addEventListener('click', addProduct);
  $f('btnReviewEmail')?.addEventListener('click', () => { reviewEmail(); });
  $f('btnSaveDraft')?.addEventListener('click', () => { saveDraft(false); });
  $f('btnPreviewPdf')?.addEventListener('click', () => { previewPdf(); });
  $f('btnExportDocs')?.addEventListener('click', () => { exportDocumentation(); });
  $f('btnRegisterResponse')?.addEventListener('click', openResponseModal);
  $f('btnBackToList')?.addEventListener('click', () => { backToList(); });

  $f('btnConflictKeepBoth')?.addEventListener('click', () => resolveConflict('keep'));
  $f('btnConflictReload')?.addEventListener('click', () => resolveConflict('reload'));
  $f('btnConflictOverwrite')?.addEventListener('click', () => resolveConflict('overwrite'));

  $f('responseForm')?.addEventListener('submit', submitResponse);
  $f('responseFile')?.addEventListener('change', handleResponseFile);
  $f('btnResponseCancel')?.addEventListener('click', () => { $f('responseModal').hidden = true; });
  $f('btnDocClose')?.addEventListener('click', closeDocModal);
  $f('btnDocDownload')?.addEventListener('click', downloadCurrentDoc);

  $f('docViewModal')?.addEventListener('click', event => {
    if (event.target === $f('docViewModal')) closeDocModal();
  });

  $f('viewFormalizacao')?.addEventListener('click', event => {
    const checkButton = event.target.closest('[data-check-comm]');
    if (checkButton) { checkCommunicationStatus(checkButton.dataset.checkComm); return; }
    const resendButton = event.target.closest('[data-resend-comm]');
    if (resendButton) { resendCommunication(resendButton.dataset.resendComm); return; }
    const docButton = event.target.closest('[data-open-doc]');
    if (docButton) { openDocViewFromServer(docButton.dataset.openDoc, docButton.dataset.docName); }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if ($f('docViewModal') && !$f('docViewModal').hidden) { closeDocModal(); return; }
    if ($f('responseModal') && !$f('responseModal').hidden) { $f('responseModal').hidden = true; return; }
    if ($f('conflictModal') && !$f('conflictModal').hidden) { $f('conflictModal').hidden = true; }
  });

  window.addEventListener('offline', () => {
    state.serverReachable = false;
    renderList();
    toastForm('Sem conexão. Dados locais continuam disponíveis; o envio está bloqueado.', 'error', 7000);
  });
  window.addEventListener('online', () => {
    toastForm('Conexão restabelecida. Atualizando a lista…');
    loadRecords();
  });

  document.addEventListener('ptats:access-key', () => { loadRecords(); });
}

async function initFormalizacaoFrontend() {
  if (!window.AppCore) {
    console.error('[Formalização] AppCore não carregado.');
    return;
  }
  window.AppCore.initGate();
  wireFormalizationEvents();
  try {
    state.db = await openDb();
  } catch (error) {
    state.db = null;
    toastForm('Armazenamento local indisponível. Os rascunhos não serão salvos neste dispositivo.', 'error', 8000);
  }
  await loadRecords();
  if (!window.AppCore.hasKey()) {
    window.AppCore.openGate('Informe a chave de acesso configurada pelo administrador. Ela não fica salva no código e vale apenas para esta sessão.');
  }
}

document.addEventListener('DOMContentLoaded', initFormalizacaoFrontend);
