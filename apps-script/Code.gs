/**
 * PTA NR-35 — GRUPO SRF
 * Backend seguro da aplicação web.
 * Versão 1.8
 *
 * Desenvolvido por Jhonantan Cardoso Gonçalves
 * WhatsApp: https://wa.me/5548992159791
 */

var PTA_CONFIG = Object.freeze({
  VERSION: '1.8',
  APP_ID: 'PTA_GRUPO_SRF',
  SHEET_NAME: 'DADOS',
  FOLDER_NAME: 'PTA_NR35_Arquivos',
  GROQ_URL: 'https://api.groq.com/openai/v1/chat/completions',
  DEFAULT_GROQ_MODEL: 'llama-3.3-70b-versatile',
  MAX_TEXT_LENGTH: 2500,
  MAX_PDF_DATA_LENGTH: 20000000,
  AI_CLIENT_MINUTE_LIMIT: 5,
  AI_GLOBAL_MINUTE_LIMIT: 25,
  AI_GLOBAL_DAILY_LIMIT: 300
});

var PTA_HEADERS = [
  'Data e Hora de Emissão',
  'Data e Hora do Término',
  'Mão de Obra',
  'Qtd. de Profissionais',
  'Equipe (Nomes / NR-35 / ASO)',
  'Local Específico',
  'Altura Aproximada (m)',
  'Descrição Detalhada da Tarefa',
  'Condições Climáticas',
  'EPIs Verificados',
  'EPCs Utilizados',
  'Riscos e Medidas de Controle',
  'Plano de Resgate / Observações',
  'Técnico SST (Emissor)',
  'Supervisor da Área',
  'Link do Arquivo PDF'
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('GRUPO SRF Segurança 4.0')
    .addItem('Inserir/Corrigir Cabeçalhos', 'formatarCabecalhos')
    .addItem('Verificar configuração da IA', 'verificarConfiguracaoIA')
    .addToUi();
}

function formatarCabecalhos() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PTA_CONFIG.SHEET_NAME);

  if (!sheet) {
    ui.alert(
      'Erro',
      "A aba 'DADOS' não foi encontrada. Faça pelo menos um envio pelo aplicativo primeiro.",
      ui.ButtonSet.OK
    );
    return;
  }

  aplicarCabecalhos_(sheet);
  ui.alert(
    'Sucesso!',
    'Os cabeçalhos foram aplicados sem apagar os registros existentes.',
    ui.ButtonSet.OK
  );
}

function verificarConfiguracaoIA() {
  var ui = SpreadsheetApp.getUi();
  var properties = PropertiesService.getScriptProperties();
  var apiKey = properties.getProperty('GROQ_API_KEY');
  var model = properties.getProperty('GROQ_MODEL') || PTA_CONFIG.DEFAULT_GROQ_MODEL;

  if (!apiKey) {
    ui.alert(
      'IA não configurada',
      "Cadastre a propriedade de script GROQ_API_KEY. O aplicativo continuará funcionando com o assistente local enquanto a chave não estiver configurada.",
      ui.ButtonSet.OK
    );
    return;
  }

  ui.alert(
    'IA configurada',
    'A chave Groq está armazenada nas Propriedades do script. Modelo configurado: ' + model + '.',
    ui.ButtonSet.OK
  );
}

function doGet() {
  var properties = PropertiesService.getScriptProperties();
  return respostaJson_({
    status: 'success',
    service: 'PTA NR-35 GRUPO SRF',
    version: PTA_CONFIG.VERSION,
    aiConfigured: Boolean(properties.getProperty('GROQ_API_KEY'))
  });
}

function doPost(e) {
  try {
    var data = lerJsonRequisicao_(e);
    validarAplicacao_(data);

    var action = String(data.action || 'SAVE_PDF').trim().toUpperCase();
    var result;

    switch (action) {
      case 'SAVE_PDF':
        result = salvarPdfERegistro_(data);
        break;
      case 'AI_NR35_RISKS':
        result = processarIaNr35_('RISKS', data);
        break;
      case 'AI_NR35_RESCUE':
        result = processarIaNr35_('RESCUE', data);
        break;
      default:
        throw criarErro_('ACTION_NOT_ALLOWED', 'Ação não permitida.');
    }

    result.status = 'success';
    result.version = PTA_CONFIG.VERSION;
    return respostaJson_(result);
  } catch (error) {
    console.error('[PTA_BACKEND] ' + sanitizarLog_(error));
    return respostaJson_({
      status: 'error',
      code: error && error.code ? error.code : 'INTERNAL_ERROR',
      message: mensagemSegura_(error)
    });
  }
}

function doOptions() {
  return ContentService.createTextOutput('OK');
}

function salvarPdfERegistro_(data) {
  validarTextoObrigatorio_(data.fileName, 'Nome do arquivo', 180);
  validarTextoObrigatorio_(data.pdfBase64, 'Conteúdo do PDF', PTA_CONFIG.MAX_PDF_DATA_LENGTH);

  var pdfData = String(data.pdfBase64);
  if (pdfData.indexOf('data:application/pdf') !== 0 || pdfData.indexOf(',') < 0) {
    throw criarErro_('INVALID_PDF', 'O arquivo PDF recebido é inválido.');
  }

  if (pdfData.length > PTA_CONFIG.MAX_PDF_DATA_LENGTH) {
    throw criarErro_('PDF_TOO_LARGE', 'O PDF excede o limite permitido.');
  }

  var safeFileName = sanitizarNomeArquivo_(data.fileName);
  var base64Data = pdfData.substring(pdfData.indexOf(',') + 1);
  var decoded;

  try {
    decoded = Utilities.base64Decode(base64Data);
  } catch (error) {
    throw criarErro_('INVALID_PDF_BASE64', 'Não foi possível interpretar o PDF recebido.');
  }

  var folder = obterPasta_(PTA_CONFIG.FOLDER_NAME);
  var blob = Utilities.newBlob(decoded, MimeType.PDF, safeFileName);
  var file = folder.createFile(blob);
  var fileUrl = file.getUrl();

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheetByName(PTA_CONFIG.SHEET_NAME);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(PTA_CONFIG.SHEET_NAME);
      aplicarCabecalhos_(sheet);
    } else if (sheet.getRange('A1').getValue() !== PTA_HEADERS[0]) {
      aplicarCabecalhos_(sheet);
    }

    var row = [
      limitarTexto_(data.emissao, 100),
      limitarTexto_(data.termino, 100),
      limitarTexto_(data.maoObra, 100),
      numeroSeguro_(data.qtdTrabalhadores, 0, 100),
      limitarTexto_(data.nomesEquipe, 5000),
      limitarTexto_(data.local, 500),
      limitarTexto_(data.altura, 50),
      limitarTexto_(data.tarefa, 5000),
      limitarTexto_(data.clima, 1500),
      limitarTexto_(data.epis, 2500),
      limitarTexto_(data.epcs, 2500),
      limitarTexto_(data.riscos, 10000),
      limitarTexto_(data.resgate, 10000),
      limitarTexto_(data.emissor, 500),
      limitarTexto_(data.supervisor, 500),
      fileUrl
    ];

    sheet.appendRow(row);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 1, 1, row.length)
      .setVerticalAlignment('top')
      .setWrap(true);
    SpreadsheetApp.flush();
  } catch (error) {
    try {
      file.setTrashed(true);
    } catch (cleanupError) {
      console.error('[PTA_BACKEND][CLEANUP] ' + sanitizarLog_(cleanupError));
    }
    throw error;
  } finally {
    lock.releaseLock();
  }

  return {fileUrl: fileUrl};
}

function processarIaNr35_(type, data) {
  validarClienteIa_(data);
  aplicarLimiteIa_(data.clientId);

  var context = data.context || {};
  var descricao = limitarTexto_(context.descricao, PTA_CONFIG.MAX_TEXT_LENGTH);
  if (!descricao) {
    throw criarErro_('MISSING_DESCRIPTION', 'Preencha a descrição da atividade.');
  }

  var properties = PropertiesService.getScriptProperties();
  var apiKey = properties.getProperty('GROQ_API_KEY');
  if (!apiKey) {
    throw criarErro_('AI_NOT_CONFIGURED', 'A IA ainda não está configurada no servidor.');
  }

  var model = properties.getProperty('GROQ_MODEL') || PTA_CONFIG.DEFAULT_GROQ_MODEL;
  var prompt = montarPromptNr35_(type, context);
  var maxTokens = type === 'RISKS' ? 1300 : 1100;

  var payload = {
    model: model,
    temperature: 0.15,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'system',
        content: 'Você é um assistente técnico de Segurança do Trabalho especializado em NR-35. Produza apoio técnico objetivo em português do Brasil. Não invente dados, certificados, equipamentos disponíveis ou condições que não foram informadas. A resposta deve ser revisada e aprovada pelo responsável de SST antes da liberação da atividade.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  };

  var response;
  try {
    response = UrlFetchApp.fetch(PTA_CONFIG.GROQ_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {Authorization: 'Bearer ' + apiKey},
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (error) {
    throw criarErro_('AI_NETWORK_ERROR', 'A IA está temporariamente indisponível.');
  }

  var statusCode = response.getResponseCode();
  var bodyText = response.getContentText() || '{}';
  var body;

  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw criarErro_('AI_INVALID_RESPONSE', 'A IA retornou uma resposta inválida.');
  }

  if (statusCode < 200 || statusCode >= 300) {
    console.error('[GROQ] HTTP ' + statusCode + ' | ' + limitarTexto_(bodyText, 500));
    if (statusCode === 401 || statusCode === 403) {
      throw criarErro_('AI_AUTH_ERROR', 'A configuração da IA precisa ser atualizada.');
    }
    if (statusCode === 429) {
      throw criarErro_('AI_RATE_LIMIT', 'O limite temporário da IA foi atingido.');
    }
    throw criarErro_('AI_SERVICE_ERROR', 'A IA está temporariamente indisponível.');
  }

  var text = body && body.choices && body.choices[0] && body.choices[0].message
    ? String(body.choices[0].message.content || '').trim()
    : '';

  if (!text) {
    throw criarErro_('AI_EMPTY_RESPONSE', 'A IA não retornou conteúdo útil.');
  }

  return {
    text: limitarTexto_(text, 12000),
    source: 'groq',
    model: model
  };
}

function montarPromptNr35_(type, context) {
  var dados = [
    'ATIVIDADE: ' + limitarTexto_(context.descricao, PTA_CONFIG.MAX_TEXT_LENGTH),
    'LOCAL: ' + (limitarTexto_(context.local, 500) || 'Não informado'),
    'ALTURA APROXIMADA: ' + (limitarTexto_(context.altura, 50) || 'Não informada') + ' m',
    'CLIMA: ' + (limitarTexto_(context.clima, 1000) || 'Não informado'),
    'EPIs INFORMADOS: ' + (limitarTexto_(context.epis, 1500) || 'Não informados'),
    'EPCs INFORMADOS: ' + (limitarTexto_(context.epcs, 1500) || 'Não informados'),
    'CHECKLIST: ' + (limitarTexto_(context.checklist, 2500) || 'Não informado')
  ].join('\n');

  if (type === 'RISKS') {
    return [
      'Analise os dados abaixo e gere de 4 a 7 riscos relevantes e suas medidas de controle.',
      'Priorize queda de pessoas, queda de objetos, acesso, ancoragem, clima, energia, ferramentas, isolamento e resposta a emergências quando aplicável.',
      'Não afirme que um item foi inspecionado ou aprovado se isso não estiver explícito nos dados.',
      'Use exatamente este formato, sem introdução e sem conclusão:',
      '1. RISCO: descrição objetiva',
      '   MEDIDA: controle preventivo objetivo e executável',
      '',
      dados
    ].join('\n');
  }

  return [
    'Elabore um plano de resgate específico e executável para a atividade abaixo.',
    'Inclua preparação antes do início, comunicação, isolamento, equipe capacitada, sistema de resgate e ancoragem independente, redução do tempo de suspensão, primeiros socorros, acionamento do SAMU 192 ou Bombeiros 193 quando necessário e critérios para retomada.',
    'Não presuma que equipamentos ou profissionais existem; quando necessário, use a expressão “confirmar previamente”.',
    'Apresente um título e de 6 a 9 etapas numeradas. Não use tabelas.',
    '',
    dados
  ].join('\n');
}

function aplicarLimiteIa_(clientIdRaw) {
  var clientId = sanitizarClientId_(clientIdRaw);
  var now = new Date();
  var minuteKey = Utilities.formatDate(now, 'GMT', 'yyyyMMddHHmm');
  var dayKey = Utilities.formatDate(now, Session.getScriptTimeZone() || 'America/Sao_Paulo', 'yyyyMMdd');
  var cache = CacheService.getScriptCache();
  var properties = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();

  lock.waitLock(5000);
  try {
    var clientCacheKey = 'AI_CLIENT_' + clientId + '_' + minuteKey;
    var globalCacheKey = 'AI_GLOBAL_' + minuteKey;
    var clientCount = Number(cache.get(clientCacheKey) || 0);
    var globalCount = Number(cache.get(globalCacheKey) || 0);

    if (clientCount >= PTA_CONFIG.AI_CLIENT_MINUTE_LIMIT) {
      throw criarErro_('AI_CLIENT_RATE_LIMIT', 'Aguarde um minuto antes de solicitar outra análise.');
    }
    if (globalCount >= PTA_CONFIG.AI_GLOBAL_MINUTE_LIMIT) {
      throw criarErro_('AI_GLOBAL_RATE_LIMIT', 'O serviço está temporariamente ocupado.');
    }

    var dailyKey = 'AI_DAILY_' + dayKey;
    var dailyCount = Number(properties.getProperty(dailyKey) || 0);
    if (dailyCount >= PTA_CONFIG.AI_GLOBAL_DAILY_LIMIT) {
      throw criarErro_('AI_DAILY_LIMIT', 'O limite diário de IA foi atingido.');
    }

    cache.put(clientCacheKey, String(clientCount + 1), 90);
    cache.put(globalCacheKey, String(globalCount + 1), 90);
    properties.setProperty(dailyKey, String(dailyCount + 1));
    limparContadoresAntigos_(properties, dailyKey);
  } finally {
    lock.releaseLock();
  }
}

function limparContadoresAntigos_(properties, currentKey) {
  var all = properties.getProperties();
  Object.keys(all).forEach(function(key) {
    if (key.indexOf('AI_DAILY_') === 0 && key !== currentKey) {
      properties.deleteProperty(key);
    }
  });
}

function validarAplicacao_(data) {
  if (!data || typeof data !== 'object') {
    throw criarErro_('INVALID_REQUEST', 'Requisição inválida.');
  }
  if (data.appId && String(data.appId) !== PTA_CONFIG.APP_ID) {
    throw criarErro_('INVALID_APP', 'Aplicação não autorizada.');
  }
}

function validarClienteIa_(data) {
  if (String(data.appId || '') !== PTA_CONFIG.APP_ID) {
    throw criarErro_('INVALID_APP', 'Aplicação não autorizada.');
  }
  if (!data.clientId) {
    throw criarErro_('INVALID_CLIENT', 'Identificação do cliente ausente.');
  }
}

function aplicarCabecalhos_(sheet) {
  var firstCellValue = String(sheet.getRange('A1').getValue() || '').trim();
  if (firstCellValue && firstCellValue !== PTA_HEADERS[0]) {
    sheet.insertRowBefore(1);
  }

  var headerRange = sheet.getRange(1, 1, 1, PTA_HEADERS.length);
  headerRange.setValues([PTA_HEADERS]);
  headerRange
    .setFontWeight('bold')
    .setBackground('#10261C')
    .setFontColor('#86CB38')
    .setWrap(true)
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('center');

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(5, 300);
  sheet.setColumnWidth(8, 320);
  sheet.setColumnWidth(12, 380);
  sheet.setColumnWidth(13, 380);
}

function obterPasta_(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
}

function lerJsonRequisicao_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw criarErro_('EMPTY_REQUEST', 'Requisição sem conteúdo.');
  }
  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    throw criarErro_('INVALID_JSON', 'O conteúdo recebido não é um JSON válido.');
  }
}

function respostaJson_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function validarTextoObrigatorio_(value, label, maxLength) {
  var text = String(value || '');
  if (!text) {
    throw criarErro_('MISSING_FIELD', label + ' não informado.');
  }
  if (text.length > maxLength) {
    throw criarErro_('FIELD_TOO_LARGE', label + ' excede o limite permitido.');
  }
}

function limitarTexto_(value, maxLength) {
  return String(value == null ? '' : value).trim().substring(0, maxLength);
}

function numeroSeguro_(value, min, max) {
  var number = Number(value);
  if (!isFinite(number)) number = min;
  return Math.max(min, Math.min(max, number));
}

function sanitizarNomeArquivo_(value) {
  var name = String(value || 'PTA_GRUPO_SRF.pdf')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180);
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}

function sanitizarClientId_(value) {
  var clientId = String(value || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80);
  return clientId.length >= 8 ? clientId : 'anonymous';
}

function criarErro_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function mensagemSegura_(error) {
  var allowedCodes = {
    ACTION_NOT_ALLOWED: true,
    INVALID_REQUEST: true,
    INVALID_APP: true,
    INVALID_CLIENT: true,
    EMPTY_REQUEST: true,
    INVALID_JSON: true,
    MISSING_FIELD: true,
    FIELD_TOO_LARGE: true,
    INVALID_PDF: true,
    PDF_TOO_LARGE: true,
    INVALID_PDF_BASE64: true,
    MISSING_DESCRIPTION: true,
    AI_NOT_CONFIGURED: true,
    AI_NETWORK_ERROR: true,
    AI_INVALID_RESPONSE: true,
    AI_AUTH_ERROR: true,
    AI_RATE_LIMIT: true,
    AI_SERVICE_ERROR: true,
    AI_EMPTY_RESPONSE: true,
    AI_CLIENT_RATE_LIMIT: true,
    AI_GLOBAL_RATE_LIMIT: true,
    AI_DAILY_LIMIT: true
  };
  return error && allowedCodes[error.code]
    ? String(error.message || 'Não foi possível concluir a solicitação.')
    : 'Não foi possível concluir a solicitação.';
}

function sanitizarLog_(error) {
  if (!error) return 'Erro desconhecido';
  return String(error.stack || error.message || error)
    .replace(/gsk_[a-zA-Z0-9_-]+/g, '[CHAVE_REMOVIDA]')
    .substring(0, 2000);
}
