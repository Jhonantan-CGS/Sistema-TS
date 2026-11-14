'use strict';
/* ============================================
   Núcleo compartilhado PTA + Formalização
   - Chave de acesso de sessão (sessionStorage)
   - Cliente HTTP para o Google Apps Script
   - Portão de acesso reutilizável (#accessGate)
   A chave NÃO existe no código: é digitada pelo
   responsável e validada pelo servidor a cada
   requisição protegida.
   ============================================ */

window.AppCore = (() => {
  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyFvLj8wq2gY0enpCiKPWewVpcj_LVWrt9w06Rz2wA582ZY0_GUWxr-gHDUMIQynbmv/exec';
  const KEY_STORAGE = 'ptats_access_key';
  const CLIENT_ID_STORAGE = 'ptats_client_id';
  const APP_ID = 'PTA_GRUPO_SRF';

  function getKey() {
    try { return sessionStorage.getItem(KEY_STORAGE) || ''; } catch (_) { return ''; }
  }
  function setKey(key) {
    try { sessionStorage.setItem(KEY_STORAGE, String(key).trim()); } catch (_) { /* sessão privada */ }
  }
  function clearKey() {
    try { sessionStorage.removeItem(KEY_STORAGE); } catch (_) { /* ok */ }
  }
  function hasKey() { return getKey().length >= 8; }

  function getClientId() {
    try {
      let id = localStorage.getItem(CLIENT_ID_STORAGE);
      if (!id) {
        id = (crypto && typeof crypto.randomUUID === 'function')
          ? crypto.randomUUID()
          : `client_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
        localStorage.setItem(CLIENT_ID_STORAGE, id);
      }
      return id;
    } catch (_) {
      return `session_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
    }
  }

  function endpoint() { return SCRIPT_URL; }

  /* ---------- API ---------- */
  async function api(action, payload = {}, options = {}) {
    const timeoutMs = options.timeoutMs || 45000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const accessKey = getKey();
    const body = Object.assign({ action, appId: APP_ID, clientId: getClientId() }, payload);
    if (accessKey) body.accessKey = accessKey;

    let response;
    try {
      response = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (error) {
      const failure = new Error(error.name === 'AbortError'
        ? 'Tempo limite excedido ao contatar o servidor.'
        : 'Sem comunicação com o servidor. Verifique a conexão.');
      failure.code = error.name === 'AbortError' ? 'timeout' : 'network';
      throw failure;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let result = null;
    try { result = JSON.parse(text); } catch (_) { /* tratado abaixo */ }
    if (!result || typeof result !== 'object') {
      const failure = new Error('Resposta inválida do servidor.');
      failure.code = 'invalid_response';
      failure.status = response.status;
      throw failure;
    }
    if (result.status === 'success') return result;

    const failure = new Error(result.message || `Falha no servidor (HTTP ${response.status}).`);
    failure.code = result.code || 'BACKEND_ERROR';
    failure.status = response.status;
    failure.data = result;
    if (failure.code === 'authorization_required' || failure.status === 401) {
      clearKey();
      openGate('Chave de acesso ausente ou inválida. Informe a chave configurada pelo administrador.');
    }
    throw failure;
  }

  /* ---------- Portão de acesso ---------- */
  function gateElements() {
    return {
      gate: document.getElementById('accessGate'),
      input: document.getElementById('accessGateInput'),
      error: document.getElementById('accessGateError'),
      form: document.getElementById('accessGateForm'),
      message: document.getElementById('accessGateMessage')
    };
  }

  function openGate(message) {
    const { gate, input, error, message: msg } = gateElements();
    if (!gate) return;
    if (msg) {
      msg.textContent = message || '';
      msg.hidden = !message;
    }
    if (error) { error.textContent = ''; error.hidden = true; }
    gate.hidden = false;
    gate.classList.add('visible');
    document.body.classList.add('gate-open');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 60);
    }
  }

  function closeGate() {
    const { gate } = gateElements();
    if (!gate) return;
    gate.hidden = true;
    gate.classList.remove('visible');
    document.body.classList.remove('gate-open');
  }

  function initGate() {
    const { gate, form, input, error } = gateElements();
    if (!gate) return;
    gate.addEventListener('click', event => {
      if (event.target === gate) { /* manter aberto: acesso é obrigatório para a sessão */ }
    });
    form?.addEventListener('submit', event => {
      event.preventDefault();
      const value = (input?.value || '').trim();
      if (value.length < 8) {
        if (error) { error.textContent = 'A chave deve ter ao menos 8 caracteres.'; error.hidden = false; }
        input?.focus();
        return;
      }
      setKey(value);
      closeGate();
      document.dispatchEvent(new CustomEvent('ptats:access-key', { detail: { saved: true } }));
    });
  }

  /* ---------- Utilitários compartilhados ---------- */
  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  async function sha256Hex(buffer) {
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
      reader.onerror = () => reject(reader.error || new Error('Falha ao ler o arquivo.'));
      reader.readAsDataURL(file);
    });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toFixed(1)} ${units[unit]}`;
  }

  function formatDateTimeBr(iso) {
    if (!iso) return 'Data desconhecida';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Data desconhecida';
    try {
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(date);
    } catch (_) {
      return date.toLocaleString('pt-BR');
    }
  }

  return {
    api, hasKey, getKey, setKey, clearKey, openGate, closeGate, initGate,
    getClientId, endpoint, escapeHtml, sha256Hex, readFileAsBase64, base64ToBytes,
    formatBytes, formatDateTimeBr
  };
})();
