'use strict';

const FORMALIZATION_VERSION = '1.0';
const FORMALIZATION_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyFvLj8wq2gY0enpCiKPWewVpcj_LVWrt9w06Rz2wA582ZY0_GUWxr-gHDUMIQynbmv/exec';

const state = {
  db: null,
  records: [],
  currentId: null,
  products: [],
  dirty: false,
  saveTimer: null,
  sending: false
};

const $f = id => document.getElementById(id);
const escapeHtmlForm = (value = '') => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

function toastForm(message, timeout = 4500) {
  const element = $f('toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), timeout);
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

function switchView(view) {
  document.querySelectorAll('.view').forEach(element => {
    element.classList.toggle('active', element.id === `view${view === 'pta' ? 'Pta' : 'Formalizacao'}`);
  });
  const area = $f('areaActive');
  if (area) area.textContent = `Área ativa: ${view === 'pta' ? 'PTA NR-35' : 'Formalização de Testes'}`;
  document.querySelectorAll('.tab-button').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB não disponível neste navegador.'));
      return;
    }
    const request = indexedDB.open('sistema-ts-formalizacao', 1);
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
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('formalizacoes', 'readonly');
    const store = tx.objectStore('formalizacoes');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function dbPut(record) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('formalizacoes', 'readwrite');
    const store = tx.objectStore('formalizacoes');
    const request = store.put(record);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGet(id) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('formalizacoes', 'readonly');
    const store = tx.objectStore('formalizacoes');
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve({ base64, dataUrl: result });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatDateBr(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toLocaleString('pt-BR');
  }
}

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
      preparation: '',
      products: '',
      equipment: '',
      steps: '',
      duration: '',
      sampling: '',
      safety: ''
    },
    email: {
      to: '',
      cc: '',
      reply: '',
      subject: '',
      body: ''
    },
    history: [],
    communications: [],
    responses: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    syncStatus: 'local'
  };
}

function addHistory(record, action, links = []) {
  record.history.unshift({
    at: nowIso(),
    actor: record.owner || 'Usuário local',
    action,
    revision: record.revision,
    links
  });
}

function renderList() {
  const container = $f('formalizacaoList');
  if (!container) return;
  const search = ($f('searchFormalizacao')?.value || '').toLowerCase();
  const status = $f('filterStatus')?.value || '';
  const from = $f('filterFrom')?.value || '';
  const to = $f('filterTo')?.value || '';

  const filtered = state.records.filter(record => {
    const haystack = `${record.number} ${record.title} ${record.products.map(p => p.name).join(' ')}`.toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (status && record.status !== status) return false;
    if (from && record.updatedAt.slice(0, 10) < from) return false;
    if (to && record.updatedAt.slice(0, 10) > to) return false;
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = '<p class="assist-note">Nenhuma formalização encontrada.</p>';
    return;
  }

  const table = `
    <div class="table-wrap">
      <table class="formalizacao-table">
        <thead>
          <tr><th>Número</th><th>Teste</th><th>Produtos</th><th>Revisão</th><th>Situação</th><th>Última atualização</th><th>Ações</th></tr>
        </thead>
        <tbody>
          ${filtered.map(record => `
            <tr>
              <td>${escapeHtmlForm(record.number)}</td>
              <td>${escapeHtmlForm(record.title || 'Sem título')}</td>
              <td>${escapeHtmlForm(record.products.map(p => p.name).join(', ') || '-')}</td>
              <td>${escapeHtmlForm(record.revision)}</td>
              <td>${escapeHtmlForm(record.status)}</td>
              <td>${escapeHtmlForm(formatDateBr(record.updatedAt))}</td>
              <td><button type="button" class="btn" data-open="${escapeHtmlForm(record.id)}">Abrir</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="card-list">
      ${filtered.map(record => `
        <div class="card-item">
          <strong>${escapeHtmlForm(record.number)} — ${escapeHtmlForm(record.title || 'Sem título')}</strong>
          <span>Produtos: ${escapeHtmlForm(record.products.map(p => p.name).join(', ') || '-')}</span>
          <span>Revisão: ${escapeHtmlForm(record.revision)} | Situação: ${escapeHtmlForm(record.status)}</span>
          <span>Atualizado: ${escapeHtmlForm(formatDateBr(record.updatedAt))}</span>
          <button type="button" class="btn" data-open="${escapeHtmlForm(record.id)}">Abrir</button>
        </div>
      `).join('')}
    </div>
  `;
  container.innerHTML = table;
  container.querySelectorAll('[data-open]').forEach(button => {
    button.addEventListener('click', () => openRecord(button.dataset.open));
  });
}

async function newFormalizacao() {
  const record = createEmptyRecord();
  state.records.unshift(record);
  state.currentId = record.id;
  state.products = record.products;
  addHistory(record, 'Formalização criada');
  renderForm(record);
  renderList();
  await saveDraft(true);
  toastForm('Nova formalização criada.');
}

function openRecord(id) {
  const record = state.records.find(item => item.id === id);
  if (!record) return;
  state.currentId = id;
  state.products = record.products;
  renderForm(record);
}

function getRecord() {
  return state.records.find(item => item.id === state.currentId);
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
  updateFdsValidation();
}

function collectForm() {
  const record = getRecord();
  if (!record) return null;
  const getValue = id => $f(id)?.value || '';
  record.title = getValue('f_test_title').trim();
  record.requester = getValue('f_test_requester').trim();
  record.owner = getValue('f_test_owner').trim();
  record.unit = getValue('f_test_unit').trim();
  record.responsible = getValue('f_test_responsible').trim();
  record.period = getValue('f_test_period').trim();
  const selectedStatus = getValue('f_test_status');
  if (['rascunho', 'pronto', 'arquivado'].includes(selectedStatus)) {
    record.status = selectedStatus;
  }
  record.objective = getValue('f_test_objective').trim();
  record.notes = getValue('f_test_notes').trim();
  record.ptaLink = getValue('f_test_pta_link').trim();
  record.procedure.preparation = getValue('f_proc_preparation').trim();
  record.procedure.products = getValue('f_proc_products').trim();
  record.procedure.equipment = getValue('f_proc_equipment').trim();
  record.procedure.steps = getValue('f_proc_steps').trim();
  record.procedure.duration = getValue('f_proc_duration').trim();
  record.procedure.sampling = getValue('f_proc_sampling').trim();
  record.procedure.safety = getValue('f_proc_safety').trim();
  record.email.to = getValue('f_email_to').trim();
  record.email.cc = getValue('f_email_cc').trim();
  record.email.reply = getValue('f_email_reply').trim();
  record.email.subject = getValue('f_email_subject').trim();
  record.email.body = getValue('f_email_body').trim();
  record.updatedAt = nowIso();
  return record;
}

function addProduct() {
  const record = getRecord();
  if (!record) return;
  const product = {
    id: crypto.randomUUID ? crypto.randomUUID() : `prod_${Date.now()}`,
    name: '',
    manufacturer: '',
    quantity: '',
    unit: '',
    fds: null
  };
  record.products.push(product);
  state.products = record.products;
  renderProducts();
  updateFdsValidation();
  markDirty();
}

function removeProduct(productId) {
  const record = getRecord();
  if (!record) return;
  const product = record.products.find(item => item.id === productId);
  const name = product?.name || 'produto sem nome';
  if (!confirm(`Remover o produto "${name}" e seu vínculo de FDS?`)) return;
  record.products = record.products.filter(item => item.id !== productId);
  state.products = record.products;
  renderProducts();
  updateFdsValidation();
  markDirty();
}

function renderProducts() {
  const container = $f('productsContainer');
  if (!container) return;
  const record = getRecord();
  if (!record) return;
  container.innerHTML = record.products.map(product => `
    <div class="product-card" data-product="${escapeHtmlForm(product.id)}">
      <div class="grid">
        <div>
          <label class="field-label" for="prod_name_${product.id}">Nome do produto</label>
          <input class="input" id="prod_name_${product.id}" data-field="name" value="${escapeHtmlForm(product.name)}">
        </div>
        <div>
          <label class="field-label" for="prod_manuf_${product.id}">Fabricante/Fornecedor</label>
          <input class="input" id="prod_manuf_${product.id}" data-field="manufacturer" value="${escapeHtmlForm(product.manufacturer)}">
        </div>
        <div>
          <label class="field-label" for="prod_qty_${product.id}">Quantidade</label>
          <input class="input" id="prod_qty_${product.id}" data-field="quantity" value="${escapeHtmlForm(product.quantity)}">
        </div>
        <div>
          <label class="field-label" for="prod_unit_${product.id}">Unidade</label>
          <input class="input" id="prod_unit_${product.id}" data-field="unit" value="${escapeHtmlForm(product.unit)}">
        </div>
      </div>
      <div class="product-file">
        ${product.fds ? `
          <strong>FDS:</strong> ${escapeHtmlForm(product.fds.name)}<br>
          Tipo: ${escapeHtmlForm(product.fds.type)} | Tamanho: ${formatBytes(product.fds.size)} | Revisão: ${escapeHtmlForm(product.fds.revision || 'não informada')}<br>
          Hash: ${escapeHtmlForm(product.fds.hash.slice(0, 16))}...
        ` : '<span class="pendencia">FDS não anexada.</span>'}
      </div>
      <div class="actions">
        <input type="file" accept="application/pdf" hidden data-file="${escapeHtmlForm(product.id)}">
        <button type="button" class="btn" data-select="${escapeHtmlForm(product.id)}">Selecionar FDS</button>
        ${product.fds ? `<button type="button" class="btn" data-openfds="${escapeHtmlForm(product.id)}">Abrir arquivo</button>` : ''}
        <button type="button" class="btn" data-replace="${escapeHtmlForm(product.id)}">Substituir versão</button>
        <button type="button" class="btn btn-red" data-remove="${escapeHtmlForm(product.id)}">Remover produto</button>
      </div>
      ${product.fds && !product.fds.revision ? '<p class="pendencia">Revisão da FDS não informada.</p>' : ''}
    </div>
  `).join('');

  container.querySelectorAll('input[data-field]').forEach(input => {
    input.addEventListener('input', event => {
      const card = event.target.closest('[data-product]');
      const productId = card?.dataset.product;
      const product = record.products.find(item => item.id === productId);
      if (product) {
        product[event.target.dataset.field] = event.target.value;
        markDirty();
        updateFdsValidation();
      }
    });
  });

  container.querySelectorAll('[data-select],[data-replace]').forEach(button => {
    button.addEventListener('click', () => {
      const productId = button.dataset.select || button.dataset.replace;
      const input = container.querySelector(`input[data-file="${productId}"]`);
      if (input) input.click();
    });
  });

  container.querySelectorAll('input[data-file]').forEach(input => {
    input.addEventListener('change', async event => {
      const productId = event.target.dataset.file;
      const file = event.target.files?.[0];
      if (!file) return;
      await attachFds(productId, file);
      event.target.value = '';
    });
  });

  container.querySelectorAll('[data-openfds]').forEach(button => {
    button.addEventListener('click', () => openFds(button.dataset.openfds));
  });

  container.querySelectorAll('[data-remove]').forEach(button => {
    button.addEventListener('click', () => removeProduct(button.dataset.remove));
  });
}

async function attachFds(productId, file) {
  const record = getRecord();
  const product = record?.products.find(item => item.id === productId);
  if (!product) return;
  if (file.type !== 'application/pdf') {
    toastForm('Selecione um arquivo PDF para a FDS.');
    return;
  }
  const revision = prompt('Revisão da FDS (deixe em branco se não constar):', product.fds?.revision || '');
  if (revision === null) return;
  try {
    const { base64, dataUrl } = await readFileAsBase64(file);
    const buffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
    const hash = await sha256(buffer);
    product.fds = {
      id: crypto.randomUUID ? crypto.randomUUID() : `fds_${Date.now()}`,
      name: file.name,
      type: file.type,
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
    toastForm('FDS anexada neste dispositivo.');
  } catch (error) {
    toastForm('Não foi possível ler a FDS. Tente novamente.');
  }
}

function openFds(productId) {
  const record = getRecord();
  const product = record?.products.find(item => item.id === productId);
  if (!product?.fds?.dataUrl) {
    toastForm('Arquivo da FDS não disponível.');
    return;
  }
  const link = document.createElement('a');
  link.href = product.fds.dataUrl;
  link.download = product.fds.name;
  link.click();
}

function updateFdsValidation() {
  const record = getRecord();
  const summary = $f('fdsValidationSummary');
  if (!record || !summary) return;
  const missing = record.products.filter(product => !product.fds);
  if (!record.products.length) {
    summary.textContent = 'Adicione ao menos um produto para a formalização.';
    return;
  }
  if (missing.length) {
    summary.textContent = `Adicione a FDS do produto ${missing.map(p => p.name || 'sem nome').join(', ')} para concluir este envio.`;
  } else {
    summary.textContent = 'Todas as FDS previstas estão anexadas.';
  }
}

function markDirty() {
  state.dirty = true;
  updateSaveStatus('Alterações ainda não sincronizadas');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveDraft(true), 1200);
}

function updateSaveStatus(text) {
  const element = $f('saveStatus');
  if (element) element.textContent = text;
}

async function syncFormalization(record) {
  try {
    const result = await postBackendForm({ action: 'FORMALIZATION_SAVE', formalization: record });
    if (result.status === 'success') {
      record.syncStatus = 'server';
      return true;
    }
  } catch (_) {}
  record.syncStatus = 'local';
  return false;
}

async function saveDraft(silent = false) {
  const record = collectForm();
  if (!record) {
    updateSaveStatus('Nenhuma formalização ativa');
    if (!silent) toastForm('Crie ou abra uma formalização antes de salvar.');
    return;
  }
  record.syncStatus = 'local';
  try {
    await dbPut(record);
    state.dirty = false;
    const synced = await syncFormalization(record);
    updateSaveStatus(synced ? 'Salvo no sistema' : 'Salvo neste dispositivo');
    if (!silent) toastForm(synced ? 'Formalização salva no sistema.' : 'Rascunho salvo neste dispositivo.');
  } catch (error) {
    updateSaveStatus('Alterações ainda não sincronizadas');
    if (!silent) toastForm('Não foi possível salvar o rascunho localmente.');
  }
}

function validateForSend() {
  const record = collectForm();
  if (!record) return false;
  const errors = [];
  if (!record.title) errors.push('Informe o título do teste.');
  if (!record.procedure.steps && !record.procedure.preparation) errors.push('Descreva o procedimento do teste.');
  if (!record.email.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email.to)) errors.push('Informe um e-mail válido da destinatária antes de revisar a mensagem.');
  if (!record.products.length) errors.push('Adicione ao menos um produto.');
  if (record.products.some(p => !p.name.trim())) errors.push('Informe o nome de todos os produtos.');
  const missingFds = record.products.filter(product => !product.fds);
  if (missingFds.length) errors.push(`Adicione a FDS do produto ${missingFds.map(p => p.name || 'sem nome').join(', ')} para concluir este envio.`);
  if (errors.length) {
    toastForm(errors[0]);
    return false;
  }
  return true;
}

function buildEmailBody(record) {
  const products = record.products.map(product => `- ${product.name || 'Produto'}${product.manufacturer ? ` (${product.manufacturer})` : ''}`).join('\n');
  const period = record.period ? `previsto para ${record.period}${record.unit ? ` em ${record.unit}` : ''}` : 'com data a definir';
  return `Olá, Suelen.

Encaminho as FDS dos produtos e a descrição de como será realizado o teste ${record.title}, ${period}.

Produtos envolvidos:
${products || '-'}

Seguem anexos o procedimento do teste e as respectivas FDS.

Peço que responda a este e-mail com suas observações, para mantermos a comunicação e os documentos arquivados.

${record.owner || 'Responsável pelo registro'}`;
}

function reviewEmail() {
  const record = collectForm();
  if (!record) return;
  if (!record.email.to) {
    toastForm('Informe o e-mail da destinatária antes de revisar a mensagem.');
    return;
  }
  if (!record.email.subject) {
    record.email.subject = `[Sistema-TS] Formalização de teste — ${record.number} — ${record.title}`;
    $f('f_email_subject').value = record.email.subject;
  }
  if (!record.email.body) {
    record.email.body = buildEmailBody(record);
    $f('f_email_body').value = record.email.body;
  }
  collectForm();
  const review = $f('emailReview');
  review.hidden = false;
  review.innerHTML = `
    <h3>Revisão do e-mail</h3>
    <p><strong>Destinatário:</strong> ${escapeHtmlForm(record.email.to)}</p>
    <p><strong>Cópias:</strong> ${escapeHtmlForm(record.email.cc || 'Nenhuma')}</p>
    <p><strong>Endereço de resposta:</strong> ${escapeHtmlForm(record.email.reply || 'Não informado')}</p>
    <p><strong>Assunto:</strong> ${escapeHtmlForm(record.email.subject)}</p>
    <p><strong>Corpo da mensagem:</strong></p>
    <pre>${escapeHtmlForm(record.email.body)}</pre>
    <p><strong>Anexos:</strong></p>
    <ul>
      <li>Procedimento do teste (PDF) — ${escapeHtmlForm(record.number)} ${escapeHtmlForm(record.revision)}</li>
      ${record.products.map(product => `<li>${escapeHtmlForm(product.fds?.name || 'FDS pendente')} — ${escapeHtmlForm(product.name || 'Produto')} — ${escapeHtmlForm(product.fds?.revision || 'revisão não informada')} — ${formatBytes(product.fds?.size || 0)}</li>`).join('')}
    </ul>
    <div class="actions">
      <button type="button" class="btn" id="btnBackEdit">Voltar e editar</button>
      <button type="button" class="btn btn-primary" id="btnConfirmSend">Enviar e-mail</button>
    </div>
  `;
  $f('btnBackEdit').addEventListener('click', () => { review.hidden = true; });
  $f('btnConfirmSend').addEventListener('click', () => sendEmail());
}

async function postBackendForm(payload) {
  const response = await fetch(FORMALIZATION_APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, appId: 'PTA_GRUPO_SRF', version: FORMALIZATION_VERSION }),
    cache: 'no-store'
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch (_) { throw new Error('Resposta inválida do servidor.'); }
  if (!response.ok || result.status !== 'success') {
    const error = new Error(result.message || `Servidor HTTP ${response.status}`);
    error.code = result.code || 'BACKEND_ERROR';
    throw error;
  }
  return result;
}

async function sendEmail() {
  if (state.sending) return;
  const record = collectForm();
  if (!record || !validateForSend()) return;
  await ensurePdfLibrariesForm();
  state.sending = true;
  const button = $f('btnSendEmail');
  setBusyForm(button, true, 'Enviando...');

  try {
    const contentHash = await sha256(new TextEncoder().encode(JSON.stringify({
      recipients: record.email,
      subject: record.email.subject,
      body: record.email.body,
      attachments: record.products.map(p => p.fds?.name)
    })));
    const idempotencyKey = `send_${record.id}_${record.revision}_${contentHash}`;
    const pdfBase64 = generatePdfBlob(record).output('datauristring').split(',')[1];
    const attachments = [
    { name: `Formalizacao_${record.number}_${record.revision}.pdf`, type: 'application/pdf', base64: pdfBase64 },
    ...record.products.map(product => ({
      name: product.fds.name,
      type: product.fds.type,
      size: product.fds.size,
      product: product.name,
      revision: product.fds.revision,
      base64: product.fds.dataUrl.split(',')[1]
    }))
  ];
  const communication = {
    id: crypto.randomUUID ? crypto.randomUUID() : `comm_${Date.now()}`,
    idempotencyKey,
    revision: record.revision,
    recipients: { to: record.email.to, cc: record.email.cc, reply: record.email.reply },
    subject: record.email.subject,
    body: record.email.body,
    attachments,
    status: 'processamento',
    createdAt: nowIso()
  };
  record.communications.push(communication);
  addHistory(record, 'Tentativa de envio iniciada', [communication.id]);
  await saveDraft(true);

    const result = await postBackendForm({
      action: 'SEND_FORMALIZATION_EMAIL',
      formalizationId: record.id,
      communicationId: communication.id,
      idempotencyKey,
      revision: record.revision,
      recipients: communication.recipients,
      subject: communication.subject,
      body: communication.body,
      attachments: communication.attachments,
      contentHash: JSON.stringify({ subject: communication.subject, body: communication.body, attachments: communication.attachments.map(a => a.name) })
    });
    communication.status = 'enviado';
    communication.result = result;
    communication.sentAt = nowIso();
    record.status = 'enviado';
    addHistory(record, 'E-mail enviado com sucesso', [communication.id]);
    await saveDraft(true);
    toastForm('E-mail enviado e registrado no sistema.');
  } catch (error) {
    communication.status = 'confirmacao_pendente';
    communication.error = error.message;
    addHistory(record, 'Confirmação de envio pendente', [communication.id]);
    await saveDraft(true);
    toastForm('Não foi possível confirmar o envio. Consulte a situação desta comunicação antes de tentar novamente.', 7000);
  } finally {
    state.sending = false;
    setBusyForm(button, false);
    renderForm(record);
  }
}

function generatePdfBlob(record) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 12;
  let y = margin;
  const writeLine = (text, size = 10.5, bold = false) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal');
    pdf.setFontSize(size);
    const lines = pdf.splitTextToSize(String(text || ''), pageWidth - margin * 2);
    lines.forEach(line => {
      if (y + 6 > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }
      pdf.text(line, margin, y);
      y += 5;
    });
  };
  const section = (title) => {
    y += 2;
    writeLine(title, 12, true);
    y += 1;
  };

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text('GRUPO SRF — Formalização de Teste', margin, y);
  y += 7;
  pdf.setFontSize(10);
  pdf.text(`Número: ${record.number} | Revisão: ${record.revision} | Situação: ${record.status}`, margin, y);
  y += 8;

  if (record.status === 'rascunho') {
    pdf.setTextColor(200, 0, 0);
    pdf.text('RASCUNHO', margin, y);
    pdf.setTextColor(0, 0, 0);
    y += 8;
  }

  section('1. Identificação');
  writeLine(`Título: ${record.title}`);
  writeLine(`Solicitante: ${record.requester || 'Não informado'}`);
  writeLine(`Responsável pelo registro: ${record.owner || 'Não informado'}`);
  writeLine(`Unidade/Local: ${record.unit || 'Não informado'}`);
  writeLine(`Responsável pelo teste: ${record.responsible || 'Não informado'}`);
  writeLine(`Período previsto: ${record.period || 'Não definido'}`);
  writeLine(`Objetivo: ${record.objective || 'Não informado'}`);
  writeLine(`Observações: ${record.notes || 'Não informadas'}`);
  if (record.ptaLink) writeLine(`Vínculo com PTA: ${record.ptaLink}`);

  section('2. Produtos e FDS');
  if (!record.products.length) writeLine('Nenhum produto cadastrado.');
  record.products.forEach((product, index) => {
    writeLine(`${index + 1}. ${product.name || 'Produto sem nome'} — Fabricante: ${product.manufacturer || 'não informado'} — Quantidade: ${product.quantity || '-'} ${product.unit || ''}`, 10.5, true);
    if (product.fds) {
      writeLine(`   FDS: ${product.fds.name} | Tipo: ${product.fds.type} | Tamanho: ${formatBytes(product.fds.size)} | Revisão: ${product.fds.revision || 'não informada'}`);
      writeLine(`   Hash: ${product.fds.hash}`);
    } else {
      writeLine('   FDS: pendente');
    }
  });

  section('3. Procedimento');
  const proc = record.procedure;
  const procLines = [
    ['Preparação e condições iniciais', proc.preparation],
    ['Produtos, quantidades e unidades', proc.products],
    ['Equipamentos e recursos', proc.equipment],
    ['Sequência das etapas e forma de aplicação', proc.steps],
    ['Duração prevista e acompanhamento', proc.duration],
    ['Coleta de amostras e avaliação dos resultados', proc.sampling],
    ['Observações de segurança e referências às FDS', proc.safety]
  ];
  procLines.forEach(([label, value]) => {
    writeLine(`${label}:`, 10.5, true);
    writeLine(value || 'Não informado');
  });

  section('4. Histórico resumido');
  record.history.slice(0, 10).forEach(event => {
    writeLine(`${formatDateBr(event.at)} — ${event.action} (${event.revision})`);
  });

  const pageCount = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    pdf.text(`Página ${i} de ${pageCount}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }
  return pdf;
}

async function ensurePdfLibrariesForm() {
  const loadScript = (url) => new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Falha ao carregar ${url}`));
    document.head.appendChild(script);
  });
  if (!window.jspdf?.jsPDF) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  }
}

async function previewPdf() {
  const record = collectForm();
  if (!record) return;
  try {
    await ensurePdfLibrariesForm();
    const pdf = generatePdfBlob(record);
    const url = pdf.output('bloburl');
    window.open(url, '_blank', 'noopener');
    toastForm('Pré-visualização do PDF aberta.');
  } catch (error) {
    toastForm('Não foi possível gerar a pré-visualização do PDF.');
  }
}

function exportDocumentation() {
  const record = collectForm();
  if (!record) return;
  const bundle = {
    formalization: record,
    exportedAt: nowIso(),
    note: 'Composição interna de e-mail e histórico; não é o arquivo original da mensagem transmitida.'
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `formalizacao_${record.number}_${record.revision}.json`;
  link.click();
  URL.revokeObjectURL(url);
  toastForm('Documentação exportada.');
}

function renderHistory(record) {
  const container = $f('historyList');
  if (!container) return;
  const events = [...record.history].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!events.length) {
    container.innerHTML = '<p class="assist-note">Sem eventos registrados.</p>';
    return;
  }
  container.innerHTML = events.map(event => `
    <div class="card-item">
      <strong>${escapeHtmlForm(event.action)}</strong>
      <span>Data/hora: ${escapeHtmlForm(formatDateBr(event.at))}</span>
      <span>Responsável: ${escapeHtmlForm(event.actor)}</span>
      <span>Revisão: ${escapeHtmlForm(event.revision)}</span>
      <span>Vínculos: ${escapeHtmlForm((event.links || []).join(', ') || 'Nenhum')}</span>
    </div>
  `).join('');
}

async function registerResponse() {
  const record = getRecord();
  if (!record) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.eml,.pdf,application/pdf,message/rfc822';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const sender = prompt('Remetente da resposta (conforme a mensagem recebida):', '');
    if (sender === null) return;
    const receivedAt = prompt('Data/hora de recebimento da resposta (deixe em branco para usar agora):', '');
    if (receivedAt === null) return;
    const content = prompt('Conteúdo ou resumo fiel da resposta:', '');
    if (content === null) return;
    try {
      const { base64, dataUrl } = await readFileAsBase64(file);
      const buffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
      const hash = await sha256(buffer);
      const response = {
        id: crypto.randomUUID ? crypto.randomUUID() : `resp_${Date.now()}`,
        communicationId: record.communications.length ? record.communications[record.communications.length - 1].id : null,
        sender: sender.trim(),
        receivedAt: receivedAt.trim() || nowIso(),
        registeredAt: nowIso(),
        registeredBy: record.owner || 'Usuário local',
        content: content.trim(),
        sourceType: file.name.toLowerCase().endsWith('.eml') ? 'eml' : 'pdf',
        manual: true,
        file: {
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          hash,
          dataUrl
        }
      };
      record.responses.push(response);
      addHistory(record, 'Resposta registrada', [response.id, response.file.name]);
      record.status = 'resposta';
      await saveDraft(true);
      renderHistory(record);
      toastForm('Resposta registrada. O teste não foi aprovado automaticamente.');
    } catch (error) {
      toastForm('Não foi possível registrar a resposta.');
    }
  };
  input.click();
}

function backToList() {
  $f('formalizacaoForm').hidden = true;
  $f('formalizacaoList').hidden = false;
  state.currentId = null;
  renderList();
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    state.db = await openDb();
    state.records = await dbAll();
  } catch (error) {
    toastForm('Armazenamento local indisponível. Algumas funções serão limitadas.');
    state.records = [];
  }

  switchView('pta');

  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  $f('btnNewFormalizacao')?.addEventListener('click', newFormalizacao);
  $f('btnAddProduct')?.addEventListener('click', addProduct);
  $f('btnSaveDraft')?.addEventListener('click', () => saveDraft(false));
  $f('btnPreviewPdf')?.addEventListener('click', previewPdf);
  $f('btnExportDocs')?.addEventListener('click', exportDocumentation);
  $f('btnRegisterResponse')?.addEventListener('click', registerResponse);
  $f('btnReviewEmail')?.addEventListener('click', reviewEmail);
  $f('btnSendEmail')?.addEventListener('click', sendEmail);

  ['searchFormalizacao', 'filterStatus', 'filterFrom', 'filterTo'].forEach(id => {
    $f(id)?.addEventListener('input', renderList);
    $f(id)?.addEventListener('change', renderList);
  });

  document.addEventListener('input', event => {
    if (event.target.closest('#formalizacaoForm')) markDirty();
  });

  renderList();
});