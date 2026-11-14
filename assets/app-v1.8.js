'use strict';

const APP_VERSION = '2.0';
const AI_TIMEOUT_MS = 45000;

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
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
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
  if (!element) return;
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
    <span class="worker-badge">TRABALHADOR ${String(id).padStart(2, '0')}</span>
    <div class="worker-grid">
      <div class="wg-span-6">
        <label class="field-label" for="w_nome_${id}">Nome completo</label>
        <input class="input" id="w_nome_${id}" required placeholder="Nome completo">
      </div>
      <div class="wg-span-3">
        <label class="field-label" for="w_func_${id}">Função</label>
        <input class="input" id="w_func_${id}" required placeholder="Função">
      </div>
      <div class="wg-span-3">
        <label class="field-label" for="w_cpf_${id}">CPF/Matrícula</label>
        <input class="input" id="w_cpf_${id}" required placeholder="CPF/Matrícula">
      </div>
      <div class="wg-span-3">
        <label class="field-label" for="w_nr35_${id}">NR-35 válido?</label>
        <select id="w_nr35_${id}" required>
          <option value="">Selecione</option><option>Sim</option><option>Não</option>
        </select>
      </div>
      <div class="wg-span-3">
        <label class="field-label" for="w_aso_${id}">ASO apto?</label>
        <select id="w_aso_${id}" required>
          <option value="">Selecione</option><option>Sim</option><option>Não</option>
        </select>
      </div>
      <div class="wg-span-6 worker-actions">
        <button class="btn" type="button" data-sign="w_${id}">Assinar trabalhador</button>
        <img id="img_sign_w_${id}" class="signature-preview" alt="Assinatura do trabalhador ${id}">
        <button class="btn btn-danger" type="button" data-remove-worker="${id}">Remover</button>
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
  $('signModal').hidden = false;
  requestAnimationFrame(resizeSignatureCanvas);
}

function closeSignModal() {
  $('signModal').hidden = true;
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

function checklistSummary() {
  return checklistItems.map((item, index) => `${item}: ${radioValue(`chk_${index}`) || 'Não informado'}`).join(' | ');
}

function collectAiContext() {
  return {
    descricao: $('f_ativ_desc').value.trim(),
    local: $('f_ativ_local').value.trim(),
    altura: $('f_ativ_altura').value,
    clima: checkedValues('chk_clima', 'f_clima_outro'),
    epis: checkedValues('chk_epis', 'f_epi_outro'),
    epcs: checkedValues('chk_epcs', 'f_epc_outro'),
    checklist: checklistSummary()
  };
}

async function postBackend(payload, timeoutMs = AI_TIMEOUT_MS) {
  const { action, ...rest } = payload;
  return window.AppCore.api(action, rest, { timeoutMs });
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

function buildLocalRiskText() {
  const description = $('f_ativ_desc').value.trim();
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
  return unique.slice(0, 6).map((item, index) => `${index + 1}. RISCO: ${item.risk}\n   MEDIDA: ${item.measure}`).join('\n\n');
}

function buildLocalRescueText() {
  const description = $('f_ativ_desc').value.trim();
  const local = $('f_ativ_local').value.trim() || 'local da atividade';
  const height = $('f_ativ_altura').value || 'informada';
  return `PLANO DE RESGATE – ${description}\n\n1. Antes do início: confirmar equipe autorizada, meios de comunicação, rota de acesso e ponto seguro de ancoragem no ${local}.\n2. Em caso de queda ou mal súbito: interromper a atividade, isolar a área e acionar imediatamente o responsável de emergência. Não improvisar o resgate.\n3. A vítima suspensa deve ser alcançada por profissional capacitado, utilizando sistema de resgate previamente disponível e ancoragem independente.\n4. Reduzir o tempo de suspensão, manter a vítima estabilizada e evitar movimentos bruscos ou retirada inadequada do cinto.\n5. Após alcançar local seguro, avaliar consciência e respiração, prestar primeiros socorros dentro da capacitação da equipe e acionar SAMU 192 ou Bombeiros 193 quando necessário.\n6. Preservar a área, registrar o evento e liberar nova atividade somente após análise e autorização do responsável.\n\nAltura aproximada: ${height} m. A execução deve seguir o procedimento interno e a análise de risco específica.`;
}

async function generateRiskText() {
  const description = $('f_ativ_desc').value.trim();
  if (!description) {
    toast('Preencha a descrição da tarefa.');
    $('f_ativ_desc').focus();
    return;
  }
  const button = $('btnRiskAssistant');
  setBusy(button, true, 'Consultando IA...');
  try {
    const result = await postBackend({action: 'AI_NR35_RISKS', context: collectAiContext()});
    $('f_riscos_medidas').value = result.text;
    autoExpand($('f_riscos_medidas'));
    toast('Análise NR-35 gerada pela IA com a chave protegida.');
  } catch (error) {
    console.warn('[IA][RISCOS] Fallback local:', error);
    $('f_riscos_medidas').value = buildLocalRiskText();
    autoExpand($('f_riscos_medidas'));
    toast('IA indisponível. A análise local de contingência foi aplicada.', 6500);
  } finally {
    setBusy(button, false);
  }
}

async function generateRescueText() {
  const description = $('f_ativ_desc').value.trim();
  if (!description) {
    toast('Preencha a descrição da tarefa.');
    $('f_ativ_desc').focus();
    return;
  }
  const button = $('btnRescueAssistant');
  setBusy(button, true, 'Consultando IA...');
  try {
    const result = await postBackend({action: 'AI_NR35_RESCUE', context: collectAiContext()});
    $('f_observacoes').value = result.text;
    autoExpand($('f_observacoes'));
    toast('Plano de resgate gerado pela IA com a chave protegida.');
  } catch (error) {
    console.warn('[IA][RESGATE] Fallback local:', error);
    $('f_observacoes').value = buildLocalRescueText();
    autoExpand($('f_observacoes'));
    toast('IA indisponível. O plano local de contingência foi aplicado.', 6500);
  } finally {
    setBusy(button, false);
  }
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
      const response = await fetch(url, {cache: 'no-store'});
      if (!response.ok) throw new Error(`Clima HTTP ${response.status}`);
      const data = await response.json();
      const current = data.current;
      $('f_clima_outro').value = `Temperatura: ${Math.round(current.temperature_2m)} °C | Vento: ${Math.round(current.wind_speed_10m)} km/h`;
      qa('#chk_clima input').forEach(element => { element.checked = false; });
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

function getValidWorkers() {
  return workers.map(id => ({
    id,
    nome: $(`w_nome_${id}`)?.value.trim(),
    func: $(`w_func_${id}`)?.value.trim(),
    cpf: $(`w_cpf_${id}`)?.value.trim(),
    nr: $(`w_nr35_${id}`)?.value,
    aso: $(`w_aso_${id}`)?.value
  })).filter(worker => worker.nome);
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

const pdfSafe = value => String(value ?? '')
  .replace(/[—–]/g, '-')
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'");

async function ensurePdfLibraries() {
  if (!window.jspdf?.jsPDF) {
    await loadScript('./assets/vendor/jspdf.umd.min.js');
  }
  if (!window.jspdf?.jsPDF?.API?.autoTable) {
    await loadScript('./assets/vendor/jspdf.plugin.autotable.min.js');
  }
}

function pdfDateTime(date, time) {
  if (!date) return '';
  return `${date.split('-').reverse().join('/')}${time ? ` ${time}` : ''}`;
}

function autoTableBlock(pdf, y, head, body, options = {}) {
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
    tableWidth: 'auto',
    columnStyles: { 0: { cellWidth: 'auto' } },
  }, options));
  return pdf.lastAutoTable.finalY + 6;
}

function pdfBrandHeader(pdf) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 14;
  pdf.setFillColor(17, 23, 21);
  pdf.rect(0, 0, pageWidth, 24, 'F');
  pdf.setTextColor(244, 247, 245);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.text('GRUPO SRF', margin, 10);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text('PERMISSAO DE TRABALHO EM ALTURA (PTA) - NR-35', margin, 16);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`V ${APP_VERSION}`, pageWidth - margin, 10, { align: 'right' });
  pdf.setTextColor(0, 0, 0);
  return 32;
}

function drawSignatureBoxes(pdf, startY, entries) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 14;
  const boxWidth = 78;
  const boxHeight = 30;
  const columnGap = pageWidth - margin * 2 - boxWidth * 2;
  let column = 0;
  let rowStartY = startY;
  pdf.setFontSize(9);
  for (const entry of entries) {
    if (rowStartY + boxHeight > pageHeight - (margin + 4)) {
      pdf.addPage();
      rowStartY = margin + 4;
    }
    const x = margin + column * (boxWidth + columnGap);
    pdf.setDrawColor(140);
    pdf.rect(x, rowStartY, boxWidth, boxHeight - 8, 'S');
    try {
      pdf.addImage(entry.data, 'PNG', x + 3, rowStartY + 2, boxWidth - 6, boxHeight - 14);
    } catch (_) { /* assinatura inválida: mantém a caixa */ }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.5);
    pdf.text(pdfSafe(entry.label || 'Sem nome'), x, rowStartY + boxHeight - 5);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(90);
    pdf.text(pdfSafe(entry.caption || ''), x, rowStartY + boxHeight - 1.5);
    pdf.setTextColor(0);
    column += 1;
    if (column === 2) {
      column = 0;
      rowStartY += boxHeight + 6;
    }
  }
  return rowStartY + (column === 2 ? 0 : boxHeight + 4);
}

async function renderPdf() {
  await ensurePdfLibraries();
  const validWorkers = getValidWorkers();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 14;
  let y = pdfBrandHeader(pdf);

  y = autoTableBlock(pdf, y, [
    [{ content: '1. IDENTIFICAÇÃO BÁSICA', colSpan: 4 }],
  ], [[
    `Emissão: ${pdfSafe(pdfDateTime($('f_emissao_data').value, $('f_emissao_hora').value) || 'Não informada')}`,
    `Término: ${pdfSafe(pdfDateTime($('f_termino_data').value, $('f_termino_hora').value) || 'Não informado')}`,
    `Mão de Obra: ${pdfSafe(radioValue('f_mao_obra') || 'Não informada')}`,
    `Qtd. Profissionais: ${validWorkers.length}`,
  ]]);

  const teamRows = validWorkers.length
    ? validWorkers.map(worker => [pdfSafe(worker.nome), pdfSafe(worker.func), pdfSafe(worker.cpf), pdfSafe(worker.nr), pdfSafe(worker.aso)])
    : [[{ content: 'Nenhum trabalhador informado', colSpan: 5 }]];
  y = autoTableBlock(pdf, y, [
    [{ content: '2. PROFISSIONAIS LIBERADOS', colSpan: 5 }],
    ['Nome', 'Função', 'CPF/Matrícula', 'NR-35', 'ASO APTO'],
  ], teamRows);

  y = autoTableBlock(pdf, y, [
    [{ content: '3. DADOS DA ATIVIDADE', colSpan: 2 }],
  ], [
    [pdfSafe(`Local: ${$('f_ativ_local').value || 'Não informado'}`), pdfSafe(`Altura Aproximada: ${$('f_ativ_altura').value || '0'} m`)],
    [{ content: pdfSafe(`Tarefa: ${$('f_ativ_desc').value || 'Não informada'}`), colSpan: 2 }],
  ]);

  y = autoTableBlock(pdf, y, [
    [{ content: '4. SEGURANÇA E CLIMA', colSpan: 2 }],
  ], [
    [{ content: 'Clima', styles: { fontStyle: 'bold' } }, pdfSafe(checkedValues('chk_clima', 'f_clima_outro') || 'Não informado')],
    [{ content: 'EPIs verificados', styles: { fontStyle: 'bold' } }, pdfSafe(checkedValues('chk_epis', 'f_epi_outro') || 'Não informado')],
    [{ content: 'EPCs instalados', styles: { fontStyle: 'bold' } }, pdfSafe(checkedValues('chk_epcs', 'f_epc_outro') || 'Não informado')],
  ]);

  y = autoTableBlock(pdf, y, [
    [{ content: '5. CHECKLIST DE VERIFICAÇÃO', colSpan: 2 }],
  ], checklistItems.map((item, index) => [pdfSafe(item), pdfSafe(radioValue(`chk_${index}`) || 'Não informado')]), {
    columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'center', fontStyle: 'bold', cellWidth: 32 } },
  });

  y = autoTableBlock(pdf, y, [
    [{ content: '6. RISCOS E PLANO DE RESGATE', colSpan: 1 }],
  ], [
    [pdfSafe(`Riscos e medidas:\n${$('f_riscos_medidas').value || 'Não informado'}`)],
    [pdfSafe(`Plano de resgate / observações:\n${$('f_observacoes').value || 'Não informado'}`)],
  ], { columnStyles: { 0: { cellWidth: pageWidth - margin * 2 } }, styles: { cellPadding: 3.4 } });

  const signatureEntries = [];
  validWorkers.forEach(worker => {
    if (savedSigns[`w_${worker.id}`]) {
      signatureEntries.push({ label: worker.nome, caption: `Trabalhador Autorizado (${worker.func || 'função não informada'})`, data: savedSigns[`w_${worker.id}`] });
    }
  });
  signatureEntries.push({ label: $('f_nome_emissor').value, caption: 'Resp. Emissão (SST)', data: savedSigns.emissor });
  signatureEntries.push({ label: $('f_nome_sup').value, caption: 'Supervisor de Área', data: savedSigns.sup });
  y = drawSignatureBoxes(pdf, y, signatureEntries);

  const pageCount = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    pdf.setPage(i);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(110);
    pdf.text('Desenvolvido por Jhonantan Cardoso Gonçalves · WhatsApp (48) 99215-9791 · V ' + APP_VERSION, margin, pageHeight - 6);
    pdf.text(`Página ${i} de ${pageCount}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
    pdf.setTextColor(0);
  }
  return pdf;
}

function pdfFilename() {
  const local = $('f_ativ_local').value.trim().replace(/[^a-zA-Z0-9À-ÿ_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Atividade';
  return `PTA_${local}_GRUPO_SRF_V${APP_VERSION}_${Date.now()}.pdf`;
}

function workersSummary(validWorkers) {
  return validWorkers.map((worker, index) => `${index + 1}. ${worker.nome} | Função: ${worker.func} | CPF/Matrícula: ${worker.cpf} | NR-35: ${worker.nr} | ASO: ${worker.aso}`).join('\n');
}

async function generatePdf(action) {
  if (!validateForm()) return;
  const button = action === 'drive' ? $('btnDrive') : $('btnDownload');
  setBusy(button, true, 'Gerando PDF...');
  try {
    const validWorkers = getValidWorkers();
    const pdf = await renderPdf();
    const fileName = pdfFilename();
    if (action === 'download') {
      pdf.save(fileName);
      toast('PDF gerado com a logo e o nome GRUPO SRF.');
      return;
    }
    setBusy(button, true, 'Enviando...');
    const result = await postBackend({
      action: 'SAVE_PDF',
      fileName,
      pdfBase64: pdf.output('datauristring'),
      emissao: `${$('f_emissao_data').value.split('-').reverse().join('/')} ${$('f_emissao_hora').value}`,
      termino: `${$('f_termino_data').value.split('-').reverse().join('/')} ${$('f_termino_hora').value}`,
      maoObra: radioValue('f_mao_obra'),
      qtdTrabalhadores: validWorkers.length,
      nomesEquipe: workersSummary(validWorkers),
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
      brand: 'GRUPO SRF'
    }, 90000);
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
