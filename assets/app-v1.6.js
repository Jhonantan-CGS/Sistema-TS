'use strict';

const APP_VERSION = '1.6';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwP5apnJVBzo5WuTlggi4mtythC7j2aO-VoEi3RWxitqSnWgECuC3-0_aKlSpcFsFfX/exec';
const checklistItems = [
  'Isolamento da área de projeção de queda',
  'Analisar o ambiente antes de iniciar',
  'Sistema de ancoragem inspecionado',
  'Ancoragem segura da escada',
  'Ferramentas em boas condições',
  'Necessidade de segunda pessoa (escada)',
  'Informar o pessoal da área',
  'Sinalização da área',
  'Andaime não movido com pessoas',
  'Andaime: travas e diagonais',
  'Linhas elétricas próximas',
  'Acesso e saída seguros',
  'Superfícies instáveis',
  'Risco de queda de objetos'
];

const savedSigns = Object.create(null);
const workers = [];
let workerSeq = 0;
let activeSignId = '';
let drawing = false;
let lastPoint = null;

const $ = id => document.getElementById(id);
const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

function toast(message, timeout = 4500) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), timeout);
}

function setBusy(button, busy, text = 'Processando...') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function radioValue(name) {
  return q(`input[name="${name}"]:checked`)?.value || '';
}

function checkedValues(containerId, extraId = '') {
  const values = qa(`#${containerId} input[type="checkbox"]:checked`).map(element => element.value);
  const extra = extraId ? $(extraId)?.value.trim() : '';
  if (extra) values.push(extra);
  return values.join(' | ');
}

function autoExpand(element) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

function initializeDates() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  $('f_emissao_data').value = date;
  $('f_emissao_hora').value = time;
}

function renderChecklist() {
  $('checklist').innerHTML = checklistItems.map((item, index) => `
    <div class="check-row">
      <span>${escapeHtml(item)}</span>
      <div class="segmented">
        ${['Sim', 'Não', 'N/A'].map(value => `
          <label>
            <input type="radio" name="chk_${index}" value="${value}" ${value === 'Sim' ? 'checked' : ''}>
            <span>${value.toUpperCase()}</span>
          </label>`).join('')}
      </div>
    </div>`).join('');
}

function addWorker() {
  workerSeq += 1;
  workers.push(workerSeq);
  const id = workerSeq;
  const card = document.createElement('div');
  card.className = 'worker-card';
  card.id = `worker_${id}`;
  card.innerHTML = `
    <span class="worker-badge">TRABALHADOR ${id}</span>
    <div class="grid">
      <input class="input" id="w_nome_${id}" required placeholder="Nome completo">
      <input class="input" id="w_func_${id}" required placeholder="Função">
      <input class="input" id="w_cpf_${id}" required placeholder="CPF/Matrícula">
      <div class="grid">
        <select id="w_nr35_${id}" required>
          <option value="">NR-35 válido?</option><option>Sim</option><option>Não</option>
        </select>
        <select id="w_aso_${id}" required>
          <option value="">ASO apto?</option><option>Sim</option><option>Não</option>
        </select>
      </div>
      <div class="span-2 worker-actions">
        <button class="btn" type="button" data-sign="w_${id}">Assinar trabalhador</button>
        <img id="img_sign_w_${id}" class="signature-preview" alt="Assinatura do trabalhador">
        <button class="btn btn-red" type="button" data-remove-worker="${id}">Remover</button>
      </div>
    </div>`;
  $('workers').appendChild(card);
  refreshRemoveButtons();
}

function removeWorker(id) {
  if (workers.length <= 1) return;
  const index = workers.indexOf(id);
  if (index >= 0) workers.splice(index, 1);
  $(`worker_${id}`)?.remove();
  delete savedSigns[`w_${id}`];
  refreshRemoveButtons();
}

function refreshRemoveButtons() {
  qa('[data-remove-worker]').forEach(button => {
    button.style.display = workers.length > 1 ? '' : 'none';
  });
}

function resizeSignatureCanvas() {
  const canvas = $('signatureCanvas');
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, rect.width, rect.height);
  context.strokeStyle = '#111';
  context.lineWidth = 2.2;
  context.lineCap = 'round';
  context.lineJoin = 'round';
}

function pointFromEvent(event) {
  const rect = $('signatureCanvas').getBoundingClientRect();
  return {x: event.clientX - rect.left, y: event.clientY - rect.top};
}

function openSignModal(id) {
  activeSignId = id;
  $('signModal').classList.add('visible');
  $('signModal').setAttribute('aria-hidden', 'false');
  requestAnimationFrame(resizeSignatureCanvas);
}

function closeSignModal() {
  $('signModal').classList.remove('visible');
  $('signModal').setAttribute('aria-hidden', 'true');
  drawing = false;
  lastPoint = null;
}

function clearSignature() {
  resizeSignatureCanvas();
}

function saveSignature() {
  const canvas = $('signatureCanvas');
  const context = canvas.getContext('2d');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let hasInk = false;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) {
      hasInk = true;
      break;
    }
  }
  if (!hasInk) {
    toast('Desenhe a assinatura antes de confirmar.');
    return;
  }
  const data = canvas.toDataURL('image/png');
  savedSigns[activeSignId] = data;
  const preview = $(`img_sign_${activeSignId}`);
  if (preview) {
    preview.src = data;
    preview.classList.add('visible');
  }
  closeSignModal();
}

function analyzeKeywords(text) {
  const value = text.toLowerCase();
  const items = [];
  const add = (risk, measure) => items.push({risk, measure});

  if (/telhado|cobertura|calha|fibrocimento|telha/.test(value)) {
    add('Queda por ruptura, escorregamento ou deslocamento sobre a cobertura', 'Usar linha de vida e sistema de ancoragem dimensionado; definir rota segura e proibir pisar diretamente em telhas frágeis.');
  }
  if (/escada/.test(value)) {
    add('Queda por posicionamento, inclinação ou movimentação inadequada da escada', 'Inspecionar, fixar e apoiar em base firme; manter três pontos de contato e segunda pessoa quando aplicável.');
  }
  if (/andaime|plataforma/.test(value)) {
    add('Queda por montagem incompleta, falta de guarda-corpo ou deslocamento da estrutura', 'Liberar somente após inspeção; instalar travas, diagonais, rodapé e guarda-corpo; impedir movimentação com pessoas.');
  }
  if (/el[eé]tric|fio|rede|painel|motor/.test(value)) {
    add('Choque elétrico ou arco elétrico próximo à área de trabalho', 'Desenergizar, bloquear e sinalizar; confirmar ausência de tensão e respeitar as distâncias de segurança.');
  }
  if (/solda|corte|maçarico|esmerilh/.test(value)) {
    add('Queimadura, incêndio e projeção de partículas', 'Emitir permissão para trabalho a quente, remover combustíveis, disponibilizar extintor e usar proteção facial.');
  }
  if (/limpeza|lavagem/.test(value)) {
    add('Escorregamento e perda de aderência por superfície molhada ou contaminada', 'Manter o acesso seco, controlar produtos e interromper a atividade se a aderência ficar insegura.');
  }
  if (/manuten|troca|reparo|instala/.test(value)) {
    add('Queda de ferramentas, peças ou materiais sobre pessoas abaixo', 'Isolar a área inferior e usar porta-ferramentas, amarração e içamento controlado.');
  }
  return items;
}

function generateRiskText() {
  const description = $('f_ativ_desc').value.trim();
  if (!description) {
    toast('Preencha a descrição da tarefa.');
    $('f_ativ_desc').focus();
    return;
  }
  const height = Number($('f_ativ_altura').value || 0);
  const climate = checkedValues('chk_clima', 'f_clima_outro').toLowerCase();
  const items = analyzeKeywords(description);

  if (height >= 2) {
    items.unshift({risk: 'Queda de pessoa durante acesso, execução ou deslocamento em altura', measure: 'Usar cinto paraquedista conectado continuamente a ponto de ancoragem seguro; inspecionar EPI/EPC e manter 100% de conexão.'});
  }
  if (/chuva|garoa/.test(climate)) {
    items.push({risk: 'Perda de aderência por chuva ou superfície molhada', measure: 'Suspender a atividade quando não houver condição segura; secar e reavaliar a superfície antes de retomar.'});
  }
  if (/vento forte/.test(climate)) {
    items.push({risk: 'Desequilíbrio por rajadas de vento', measure: 'Interromper o trabalho e retomar somente após nova avaliação das condições climáticas.'});
  }
  if (!items.some(item => /ferramentas|materiais/.test(item.risk.toLowerCase()))) {
    items.push({risk: 'Queda de objetos e ferramentas', measure: 'Isolar e sinalizar a área inferior; usar amarração de ferramentas e impedir circulação sob o serviço.'});
  }
  if (items.length < 3) {
    items.push({risk: 'Falha de comunicação ou resposta tardia em emergência', measure: 'Realizar DDS, definir responsável pelo acompanhamento e manter comunicação disponível durante toda a atividade.'});
  }

  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (!seen.has(item.risk)) {
      seen.add(item.risk);
      unique.push(item);
    }
  }
  $('f_riscos_medidas').value = unique.slice(0, 6).map((item, index) => `${index + 1}. RISCO: ${item.risk}\n   MEDIDA: ${item.measure}`).join('\n\n');
  autoExpand($('f_riscos_medidas'));
  toast('Análise técnica NR-35 gerada sem depender de chave externa.');
}

function generateRescueText() {
  const description = $('f_ativ_desc').value.trim();
  if (!description) {
    toast('Preencha a descrição da tarefa.');
    $('f_ativ_desc').focus();
    return;
  }
  const local = $('f_ativ_local').value.trim() || 'local da atividade';
  const height = $('f_ativ_altura').value || 'informada';
  $('f_observacoes').value = `PLANO DE RESGATE – ${description}\n\n1. Antes do início: confirmar equipe autorizada, meios de comunicação, rota de acesso e ponto seguro de ancoragem no ${local}.\n2. Em caso de queda ou mal súbito: interromper a atividade, isolar a área e acionar imediatamente o responsável de emergência. Não improvisar o resgate.\n3. A vítima suspensa deve ser alcançada por profissional capacitado, utilizando sistema de resgate previamente disponível e ancoragem independente.\n4. Reduzir o tempo de suspensão, manter a vítima estabilizada e evitar movimentos bruscos ou retirada inadequada do cinto.\n5. Após alcançar local seguro, avaliar consciência e respiração, prestar primeiros socorros dentro da capacitação da equipe e acionar SAMU 192 ou Bombeiros 193 quando necessário.\n6. Preservar a área, registrar o evento e liberar nova atividade somente após análise e autorização do responsável.\n\nAltura aproximada: ${height} m. A execução deve seguir o procedimento interno e a análise de risco específica.`;
  autoExpand($('f_observacoes'));
  toast('Plano técnico de resgate gerado.');
}

async function getWeather() {
  const button = $('btnWeather');
  if (!navigator.geolocation) {
    toast('Este navegador não oferece geolocalização.');
    return;
  }
  setBusy(button, true, 'Consultando...');
  navigator.geolocation.getCurrentPosition(async position => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(position.coords.latitude)}&longitude=${encodeURIComponent(position.coords.longitude)}&current=temperature_2m,wind_speed_10m,weather_code&timezone=auto`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Clima HTTP ${response.status}`);
      const data = await response.json();
      const current = data.current;
      $('f_clima_outro').value = `Temperatura: ${Math.round(current.temperature_2m)} °C | Vento: ${Math.round(current.wind_speed_10m)} km/h`;
      qa('#chk_clima input').forEach(element => element.checked = false);
      const code = Number(current.weather_code);
      const wind = Number(current.wind_speed_10m);
      if (code <= 1) q('input[value="Céu Limpo/Sol"]').checked = true;
      else if (code <= 3) q('input[value="Nublado"]').checked = true;
      else if (code <= 61) q('input[value="Chuva Leve/Garoa"]').checked = true;
      else q('input[value="Chuva Forte"]').checked = true;
      q(`input[value="${wind > 30 ? 'Vento Forte' : 'Vento Leve'}"]`).checked = true;
      toast('Condições climáticas atualizadas.');
    } catch (error) {
      console.error('[CLIMA]', error);
      toast('Não foi possível consultar o clima. Preencha manualmente.');
    } finally {
      setBusy(button, false);
    }
  }, () => {
    toast('Permissão de localização negada. Preencha o clima manualmente.');
    setBusy(button, false);
  }, {timeout: 12000, enableHighAccuracy: false});
}

function validateForm() {
  const form = $('ptaForm');
  if (!form.checkValidity()) {
    form.reportValidity();
    return false;
  }
  if (!checkedValues('chk_epis')) {
    toast('Selecione pelo menos um EPI.');
    return false;
  }
  if (!checkedValues('chk_epcs')) {
    toast('Selecione pelo menos um EPC.');
    return false;
  }
  if (!savedSigns.emissor || !savedSigns.sup) {
    toast('As assinaturas do emissor e do supervisor são obrigatórias.');
    return false;
  }
  return true;
}

function fillPdfTemplate() {
  const formatDate = (date, time) => date ? `${date.split('-').reverse().join('/')} às ${time}` : '';
  $('p_emissao').textContent = formatDate($('f_emissao_data').value, $('f_emissao_hora').value);
  $('p_termino').textContent = formatDate($('f_termino_data').value, $('f_termino_hora').value);
  $('p_obra').textContent = radioValue('f_mao_obra');

  const validWorkers = workers.map(id => ({
    id,
    nome: $(`w_nome_${id}`)?.value.trim(),
    func: $(`w_func_${id}`)?.value.trim(),
    cpf: $(`w_cpf_${id}`)?.value.trim(),
    nr: $(`w_nr35_${id}`)?.value,
    aso: $(`w_aso_${id}`)?.value
  })).filter(worker => worker.nome);

  $('p_qtd').textContent = validWorkers.length;
  $('p_tabela_equipe').innerHTML = `<tr><th colspan="5">PROFISSIONAIS LIBERADOS</th></tr><tr><th width="30%">NOME</th><th width="20%">FUNÇÃO</th><th width="25%">CPF/MATRÍCULA</th><th width="10%">NR-35</th><th width="15%">ASO APTO</th></tr>${validWorkers.map(worker => `<tr><td>${escapeHtml(worker.nome)}</td><td>${escapeHtml(worker.func)}</td><td>${escapeHtml(worker.cpf)}</td><td>${escapeHtml(worker.nr)}</td><td>${escapeHtml(worker.aso)}</td></tr>`).join('')}`;
  $('p_local').textContent = $('f_ativ_local').value;
  $('p_altura').textContent = $('f_ativ_altura').value;
  $('p_tarefa').textContent = $('f_ativ_desc').value;
  $('p_clima').textContent = checkedValues('chk_clima', 'f_clima_outro') || 'Não informado';
  $('p_epi').textContent = checkedValues('chk_epis', 'f_epi_outro');
  $('p_epc').textContent = checkedValues('chk_epcs', 'f_epc_outro');
  $('p_checklist').innerHTML = checklistItems.map((item, index) => `<tr><td>${escapeHtml(item)}</td><td style="text-align:center;font-weight:bold">${escapeHtml(radioValue(`chk_${index}`))}</td></tr>`).join('');
  $('p_riscos').textContent = $('f_riscos_medidas').value;
  $('p_obs').textContent = $('f_observacoes').value;

  const signBoxes = [];
  validWorkers.forEach(worker => {
    if (savedSigns[`w_${worker.id}`]) {
      signBoxes.push(`<div class="pdf-sign-box"><img class="pdf-sign-img" src="${savedSigns[`w_${worker.id}`]}"><strong>Trabalhador Autorizado</strong><br>${escapeHtml(worker.nome)}</div>`);
    }
  });
  signBoxes.push(`<div class="pdf-sign-box"><img class="pdf-sign-img" src="${savedSigns.emissor}"><strong>Resp. Emissão (SST)</strong><br>${escapeHtml($('f_nome_emissor').value)}</div>`);
  signBoxes.push(`<div class="pdf-sign-box"><img class="pdf-sign-img" src="${savedSigns.sup}"><strong>Supervisor de Área</strong><br>${escapeHtml($('f_nome_sup').value)}</div>`);
  $('p_assinaturas').innerHTML = signBoxes.join('');
  return validWorkers;
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Falha ao carregar ${url}`));
    document.head.appendChild(script);
  });
}

async function loadWithFallback(urls, check) {
  if (check()) return;
  let lastError;
  for (const url of urls) {
    try {
      await loadScript(url);
      if (check()) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Biblioteca indisponível');
}

async function ensurePdfLibraries() {
  await loadWithFallback([
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'
  ], () => typeof window.html2canvas === 'function');
  await loadWithFallback([
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'
  ], () => Boolean(window.jspdf?.jsPDF));
}

async function renderPdf() {
  await ensurePdfLibraries();
  fillPdfTemplate();
  await Promise.all(qa('#pdfTemplate img').map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
    image.onload = resolve;
    image.onerror = resolve;
  })));

  const template = $('pdfTemplate');
  template.style.left = '0';
  try {
    const canvas = await window.html2canvas(template, {
      scale: 2.5,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      imageTimeout: 15000
    });
    const {jsPDF} = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imageHeight = canvas.height * pageWidth / canvas.width;
    const imageData = canvas.toDataURL('image/jpeg', 0.94);
    let remaining = imageHeight;
    let position = 0;
    pdf.addImage(imageData, 'JPEG', 0, position, pageWidth, imageHeight);
    remaining -= pageHeight;
    while (remaining > 0) {
      position = remaining - imageHeight;
      pdf.addPage();
      pdf.addImage(imageData, 'JPEG', 0, position, pageWidth, imageHeight);
      remaining -= pageHeight;
    }
    return pdf;
  } finally {
    template.style.left = '-10000px';
  }
}

function pdfFilename() {
  const local = $('f_ativ_local').value.trim().replace(/[^a-zA-Z0-9À-ÿ_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Atividade';
  return `PTA_${local}_GRUPO_SRF_V${APP_VERSION}_${Date.now()}.pdf`;
}

async function generatePdf(action) {
  if (!validateForm()) return;
  const button = action === 'drive' ? $('btnDrive') : $('btnDownload');
  setBusy(button, true, 'Gerando PDF...');
  try {
    const pdf = await renderPdf();
    const fileName = pdfFilename();
    if (action === 'download') {
      pdf.save(fileName);
      toast('PDF gerado com a logo e o nome GRUPO SRF.');
      return;
    }
    if (!APPS_SCRIPT_URL.startsWith('https://script.google.com/')) {
      throw new Error('URL do Apps Script inválida');
    }
    setBusy(button, true, 'Enviando...');
    const payload = {
      fileName,
      pdfBase64: pdf.output('datauristring'),
      emissao: `${$('f_emissao_data').value.split('-').reverse().join('/')} ${$('f_emissao_hora').value}`,
      termino: `${$('f_termino_data').value.split('-').reverse().join('/')} ${$('f_termino_hora').value}`,
      maoObra: radioValue('f_mao_obra'),
      qtdTrabalhadores: workers.length,
      local: $('f_ativ_local').value,
      altura: $('f_ativ_altura').value,
      tarefa: $('f_ativ_desc').value,
      clima: checkedValues('chk_clima', 'f_clima_outro'),
      epis: checkedValues('chk_epis', 'f_epi_outro'),
      epcs: checkedValues('chk_epcs', 'f_epc_outro'),
      riscos: $('f_riscos_medidas').value,
      resgate: $('f_observacoes').value,
      emissor: $('f_nome_emissor').value,
      supervisor: $('f_nome_sup').value,
      version: APP_VERSION,
      brand: 'GRUPO SRF'
    };
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.message || 'O servidor não confirmou o salvamento');
    toast('PDF salvo na nuvem.');
    if (result.fileUrl) window.open(result.fileUrl, '_blank', 'noopener');
  } catch (error) {
    console.error('[PTA]', error);
    toast(`Falha: ${error.message || 'não foi possível gerar o PDF.'}`, 7000);
  } finally {
    setBusy(button, false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initializeDates();
  renderChecklist();
  addWorker();

  $('btnAddWorker').addEventListener('click', addWorker);
  $('btnWeather').addEventListener('click', getWeather);
  $('btnRiskAssistant').addEventListener('click', generateRiskText);
  $('btnRescueAssistant').addEventListener('click', generateRescueText);
  $('btnDownload').addEventListener('click', () => generatePdf('download'));
  $('btnDrive').addEventListener('click', () => generatePdf('drive'));

  document.addEventListener('click', event => {
    const signButton = event.target.closest('[data-sign]');
    if (signButton) openSignModal(signButton.dataset.sign);
    const removeButton = event.target.closest('[data-remove-worker]');
    if (removeButton) removeWorker(Number(removeButton.dataset.removeWorker));
  });

  $('btnCloseSign').addEventListener('click', closeSignModal);
  $('btnClearSign').addEventListener('click', clearSignature);
  $('btnSaveSign').addEventListener('click', saveSignature);

  const canvas = $('signatureCanvas');
  canvas.addEventListener('pointerdown', event => {
    drawing = true;
    lastPoint = pointFromEvent(event);
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    const point = pointFromEvent(event);
    const context = canvas.getContext('2d');
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPoint = point;
  });
  const stopDrawing = () => {
    drawing = false;
    lastPoint = null;
  };
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointercancel', stopDrawing);
  canvas.addEventListener('pointerleave', stopDrawing);
  qa('textarea').forEach(element => element.addEventListener('input', () => autoExpand(element)));
});