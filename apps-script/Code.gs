/* ============================================
   GRUPO SRF - PTA NR-35 v1.9
   Backend Google Apps Script
   
   SEGURANÇA:
   - Chave Groq em ScriptProperties
   - Nunca retorna a chave
   - Prompts montados no servidor
   - Validação de appId e ação
   - Rate limiting
   - Logs sanitizados
   ============================================ */

const APP_VERSION = '2.0';
const APP_NAME = 'PTA NR-35 GRUPO SRF';
const ALLOWED_ACTIONS = ['SAVE_PDF', 'AI_NR35_RISKS', 'AI_NR35_RESCUE', 'FORMALIZATION_SAVE', 'FORMALIZATION_LIST', 'FORMALIZATION_GET', 'FORMALIZATION_UPLOAD_DOC', 'FORMALIZATION_DOC_GET', 'FORMALIZATION_SEND', 'FORMALIZATION_SEND_STATUS', 'FORMALIZATION_RESPONSE'];
const MAX_FIELD_LENGTH = 5000;
const MAX_RATE_CLIENT = 30;
const MAX_RATE_GLOBAL = 200;
const MAX_DAILY_CALLS = 5000;

/* ============================================
   doGet - Informações seguras
   ============================================ */

function doGet(e) {
    const props = PropertiesService.getScriptProperties();
    const aiKey = props.getProperty('GROQ_API_KEY');
    return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        service: APP_NAME,
        version: APP_VERSION,
        aiConfigured: !!(aiKey && aiKey.length > 10),
        authConfigured: !!(props.getProperty('FORMALIZATION_ACCESS_KEY') && props.getProperty('FORMALIZATION_ACCESS_KEY').length >= 8)
    })).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================
   doPost - Roteador principal
   ============================================ */

function doPost(e) {
    try {
        const body = JSON.parse(e.postData.contents || '{}');
        const action = body.action;
        const appId = body.appId || 'web';

        if (!action || !ALLOWED_ACTIONS.includes(action)) {
            return jsonResponse({ status: 'error', message: 'Ação inválida.' }, 400);
        }

        checkRateLimits(appId);

        switch (action) {
            case 'SAVE_PDF':
                return requireAccessKey_(body, function() { return handleSavePdf(body); });
            case 'AI_NR35_RISKS':
                return requireAccessKey_(body, function() { return handleAiRisks(body); });
            case 'AI_NR35_RESCUE':
                return requireAccessKey_(body, function() { return handleAiRescue(body); });
            case 'FORMALIZATION_SAVE':
                return requireAccessKey_(body, function() { return handleFormalizationSave(body); });
            case 'FORMALIZATION_LIST':
                return requireAccessKey_(body, function() { return handleFormalizationList(body); });
            case 'FORMALIZATION_GET':
                return requireAccessKey_(body, function() { return handleFormalizationGet(body); });
            case 'FORMALIZATION_UPLOAD_DOC':
                return requireAccessKey_(body, function() { return handleFormalizationUploadDoc(body); });
            case 'FORMALIZATION_DOC_GET':
                return requireAccessKey_(body, function() { return handleFormalizationDocGet(body); });
            case 'FORMALIZATION_SEND':
                return requireAccessKey_(body, function() { return handleFormalizationSend(body); });
            case 'FORMALIZATION_SEND_STATUS':
                return requireAccessKey_(body, function() { return handleFormalizationSendStatus(body); });
            case 'FORMALIZATION_RESPONSE':
                return requireAccessKey_(body, function() { return handleFormalizationResponse(body); });
            default:
                return jsonResponse({ status: 'error', message: 'Ação não implementada.' }, 400);
        }
    } catch (err) {
        Logger.log('Erro doPost: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', message: 'Erro interno do servidor.' }, 500);
    }
}

/* ============================================
   Rate Limiting
   ============================================ */

function checkRateLimits(appId) {
    const props = PropertiesService.getScriptProperties();
    const now = new Date();
    const todayKey = 'rate_' + Utilities.formatDate(now, 'America/Sao_Paulo', 'yyyyMMdd');
    const clientKey = 'client_' + appId + '_' + Math.floor(now.getTime() / 60000);
    const globalKey = 'global_' + Math.floor(now.getTime() / 60000);

    const clientCount = parseInt(props.getProperty(clientKey) || '0');
    if (clientCount >= MAX_RATE_CLIENT) {
        throw new Error('Rate limit do cliente excedido.');
    }
    props.setProperty(clientKey, String(clientCount + 1));
    props.setProperty(clientKey + '_exp', String(Math.floor(now.getTime() / 60000) + 2));

    const globalCount = parseInt(props.getProperty(globalKey) || '0');
    if (globalCount >= MAX_RATE_GLOBAL) {
        throw new Error('Rate limit global excedido.');
    }
    props.setProperty(globalKey, String(globalCount + 1));

    const dailyCount = parseInt(props.getProperty(todayKey) || '0');
    if (dailyCount >= MAX_DAILY_CALLS) {
        throw new Error('Limite diário excedido.');
    }
    props.setProperty(todayKey, String(dailyCount + 1));

    cleanupRateLimits_(props);
}

function cleanupRateLimits_(props) {
    const now = new Date();
    const currentMinute = Math.floor(now.getTime() / 60000);
    const allProps = props.getProperties();
    for (const key in allProps) {
        if (key.startsWith('client_') || key.startsWith('global_')) {
            const parts = key.split('_');
            const ts = parseInt(parts[parts.length - 1]);
            if (!isNaN(ts) && ts < currentMinute - 5) {
                props.deleteProperty(key);
            }
        }
    }
}

/* ============================================
   SAVE_PDF - Salvar PDF no Drive e registrar
   ============================================ */

function handleSavePdf(body) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        return jsonResponse({ status: 'error', message: 'Sistema ocupado. Tente novamente.' }, 503);
    }

    try {
        const required = ['fileName', 'pdfBase64', 'local', 'emissor', 'supervisor'];
        for (const field of required) {
            if (!body[field]) {
                return jsonResponse({ status: 'error', message: 'Campo obrigatório ausente: ' + field }, 400);
            }
        }

        const folder = getOrCreateFolder_('GRUPO SRF - PTA NR-35');
        const pdfData = body.pdfBase64.split(',')[1] || body.pdfBase64;
        const blob = Utilities.newBlob(
            Utilities.base64Decode(pdfData),
            'application/pdf',
            sanitizeFileName(body.fileName)
        );
        const file = folder.createFile(blob);
        const fileUrl = file.getUrl();

        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getSheetByName('Dados PTA') || ss.insertSheet('Dados PTA');

        const lock2 = LockService.getScriptLock();
        try {
            lock2.waitLock(10000);
            const row = [
                new Date(),
                body.emissao || '',
                body.termino || '',
                body.maoObra || '',
                body.qtdTrabalhadores || 0,
                body.nomesEquipe || '',
                body.local || '',
                body.altura || '',
                body.tarefa || '',
                body.clima || '',
                body.epis || '',
                body.epcs || '',
                body.riscos || '',
                body.resgate || '',
                body.emissor || '',
                body.supervisor || '',
                body.checklist || '',
                body.fileName || '',
                fileUrl,
                APP_VERSION
            ];
            sheet.appendRow(row);
        } finally {
            lock2.releaseLock();
        }

        return jsonResponse({
            status: 'success',
            message: 'PDF salvo e registrado com sucesso.',
            fileUrl: fileUrl,
            fileName: body.fileName
        });

    } catch (err) {
        Logger.log('Erro SAVE_PDF: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', message: 'Erro ao salvar PDF: ' + sanitizeLog(err.message) }, 500);
    } finally {
        lock.releaseLock();
    }
}

/* ============================================
   AI_NR35_RISKS - Gerar riscos via Groq
   ============================================ */

function handleAiRisks(body) {
    const description = sanitizeField(body.description);
    if (!description) {
        return jsonResponse({ status: 'error', message: 'Descrição da tarefa obrigatória.' }, 400);
    }

    const prompt = 'Você é um especialista em segurança do trabalho NR-35 (Trabalho em Altura). ' +
        'Analise a seguinte tarefa e gere uma lista de 3 riscos e 3 medidas de prevenção. ' +
        'Responda APENAS com o texto limpo, sem asteriscos, sem markdown, em formato:\n' +
        'RISCOS:\n1. ...\n2. ...\n3. ...\n\nMEDIDAS:\n1. ...\n2. ...\n3. ...\n\n' +
        'Tarefa: ' + description;

    return callGroqApi(prompt);
}

/* ============================================
   AI_NR35_RESCUE - Gerar plano de resgate
   ============================================ */

function handleAiRescue(body) {
    const description = sanitizeField(body.description);
    if (!description) {
        return jsonResponse({ status: 'error', message: 'Descrição da tarefa obrigatória.' }, 400);
    }

    const prompt = 'Você é um especialista em resgate em altura e NR-35. ' +
        'Crie um plano de resgate rápido e prático para a seguinte tarefa. ' +
        'Responda APENAS com o texto limpo, sem asteriscos, sem markdown, em tópicos diretos. ' +
        'Inclua: 1) Acionamento inicial, 2) Avaliação do local, 3) Procedimento de resgate, 4) Primeiros socorros, 5) Comunicação.\n\n' +
        'Tarefa: ' + description;

    return callGroqApi(prompt);
}

/* ============================================
   Groq API Integration (Backend only)
   ============================================ */

function callGroqApi(prompt) {
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('GROQ_API_KEY');
    const model = props.getProperty('GROQ_MODEL') || 'llama-3.3-70b-versatile';

    if (!apiKey || apiKey.length < 10) {
        Logger.log('GROQ_API_KEY não configurada. Retornando fallback.');
        return jsonResponse({
            status: 'fallback',
            message: 'IA não configurada. Use o preenchimento manual.',
            content: ''
        });
    }

    try {
        const payload = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 1024
        });

        const response = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'post',
            contentType: 'application/json',
            headers: {
                'Authorization': 'Bearer ' + apiKey
            },
            payload: payload,
            muteHttpExceptions: true,
            timeout: 25000
        });

        const code = response.getResponseCode();
        const data = JSON.parse(response.getContentText());

        if (code === 401 || code === 403) {
            Logger.log('Groq auth error: ' + code);
            return jsonResponse({
                status: 'fallback',
                message: 'Autenticação da IA falhou.',
                content: ''
            });
        }

        if (code === 429) {
            Logger.log('Groq rate limit atingido');
            return jsonResponse({
                status: 'fallback',
                message: 'IA temporariamente indisponível (limite de uso).',
                content: ''
            });
        }

        if (code !== 200) {
            Logger.log('Groq error: ' + code);
            return jsonResponse({
                status: 'fallback',
                message: 'Erro na IA.',
                content: ''
            });
        }

        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content) {
            return jsonResponse({
                status: 'fallback',
                message: 'Resposta vazia da IA.',
                content: ''
            });
        }

        return jsonResponse({
            status: 'success',
            content: content.replace(/\*/g, '').trim()
        });

    } catch (err) {
        Logger.log('Erro Groq: ' + sanitizeLog(err.message));
        return jsonResponse({
            status: 'fallback',
            message: 'IA indisponível. Verifique sua conexão.',
            content: ''
        });
    }
}

/* ============================================
   Utilitários
   ============================================ */

function jsonResponse(data, code) {
    return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeField(str) {
    if (!str) return '';
    return String(str).substring(0, MAX_FIELD_LENGTH).replace(/[<>]/g, '');
}

function sanitizeFileName(name) {
    if (!name) return 'pta_' + Date.now() + '.pdf';
    return String(name).replace(/[^a-zA-Z0-9_\-.]/g, '_').substring(0, 200);
}

function sanitizeLog(msg) {
    if (!msg) return '';
    return String(msg).replace(/\n/g, ' ').substring(0, 200);
}

function getOrCreateFolder_(folderName) {
    const parentFolders = DriveApp.getFoldersByName(folderName);
    if (parentFolders.hasNext()) {
        return parentFolders.next();
    }
    const folder = DriveApp.createFolder(folderName);
    return folder;
}

/* ============================================
   Autorização por chave de acesso (servidor)
   A chave vive somente em Script Properties e é
   validada a cada requisição protegida. Ela não é
   um segredo de frontend: não está no código-fonte.
   ============================================ */

function requireAccessKey_(body, handler) {
    const props = PropertiesService.getScriptProperties();
    const expected = props.getProperty('FORMALIZATION_ACCESS_KEY');
    if (!expected || expected.length < 8) {
        return jsonResponse({
            status: 'error',
            code: 'authorization_not_configured',
            message: 'Acesso não configurado no servidor. O administrador deve definir FORMALIZATION_ACCESS_KEY nas Propriedades do Script (mínimo 8 caracteres).'
        }, 503);
    }
    const provided = body && body.accessKey ? String(body.accessKey) : '';
    if (!provided || !constantTimeEquals_(provided, expected)) {
        return jsonResponse({
            status: 'error',
            code: 'authorization_required',
            message: 'Chave de acesso ausente ou inválida. Informe a chave configurada no servidor.'
        }, 401);
    }
    return handler();
}

function constantTimeEquals_(a, b) {
    const x = String(a);
    const y = String(b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) {
        diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    }
    return diff === 0;
}

function sha256Hex_(bytes) {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
    return digest.map(function (b) {
        const value = (b < 0 ? b + 256 : b).toString(16);
        return value.length === 1 ? '0' + value : value;
    }).join('');
}

function bytesToBase64_(bytes) {
    return Utilities.base64Encode(bytes);
}

/* ============================================
   Menu da Planilha
   ============================================ */

function onOpen() {
    SpreadsheetApp.getUi()
        .createMenu('GRUPO SRF Segurança 4.0')
        .addItem('Inserir/Corrigir Cabeçalhos', 'setupHeaders')
        .addItem('Verificar configuração da IA', 'checkAIConfig')
        .addToUi();
}

function setupHeaders() {
    const ss = obterSpreadsheetFormalizacao_();
    let sheet = ss.getSheetByName('Dados PTA');
    if (!sheet) {
        sheet = ss.insertSheet('Dados PTA');
    }

    const headers = [
        'Data Registro', 'Emissão', 'Término', 'Mão de Obra', 'Qtd Trabalhadores',
        'Nomes Equipe', 'Local', 'Altura', 'Tarefa', 'Clima', 'EPIs', 'EPCs',
        'Riscos', 'Plano Resgate', 'Emissor', 'Supervisor', 'Checklist',
        'Nome Arquivo', 'URL Drive', 'Versão'
    ];

    const existingHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const hasHeaders = existingHeaders.some(h => h && String(h).trim() !== '');

    if (!hasHeaders) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.getRange(1, 1, 1, headers.length)
            .setFontWeight('bold')
            .setBackground('#FFC107')
            .setFontColor('#000000');
        sheet.setFrozenRows(1);
        SpreadsheetApp.getUi().alert('Cabeçalhos inseridos com sucesso!');
    } else {
        const ui = SpreadsheetApp.getUi();
        const response = ui.alert(
            'Cabeçalhos existentes',
            'Já existem cabeçalhos. Deseja substituí-los?',
            ui.ButtonSet.YES_NO
        );
        if (response === ui.Button.YES) {
            sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
            sheet.getRange(1, 1, 1, headers.length)
                .setFontWeight('bold')
                .setBackground('#FFC107')
                .setFontColor('#000000');
            ui.alert('Cabeçalhos atualizados!');
        }
    }
}

function checkAIConfig() {
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('GROQ_API_KEY');
    const model = props.getProperty('GROQ_MODEL') || 'llama-3.3-70b-versatile';

    const configured = !!(apiKey && apiKey.length > 10);
    const status = configured ? 'Configurada' : 'NÃO configurada';

    SpreadsheetApp.getUi().alert(
        'Configuração da IA - GRUPO SRF',
        'Status: ' + status + '\n' +
        'Modelo: ' + model + '\n' +
        'Versão: ' + APP_VERSION + '\n\n' +
        (configured ? 'A chave está segura nas Propriedades do Script.' : 'Configure a propriedade GROQ_API_KEY nas Propriedades do Script.')
    );
}
