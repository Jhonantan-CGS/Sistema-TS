/* ============================================
   GRUPO SRF - PTA NR-35 v1.9
   Backend Google Apps Script
   
   SEGURANÃ‡A:
   - Chave Groq em ScriptProperties
   - Nunca retorna a chave
   - Prompts montados no servidor
   - ValidaÃ§Ã£o de appId e aÃ§Ã£o
   - Rate limiting
   - Logs sanitizados
   ============================================ */

const APP_VERSION = '1.9';
const APP_NAME = 'PTA NR-35 GRUPO SRF';
const ALLOWED_ACTIONS = ['SAVE_PDF', 'AI_NR35_RISKS', 'AI_NR35_RESCUE', 'FORMALIZATION_SAVE', 'FORMALIZATION_LIST', 'FORMALIZATION_GET', 'SEND_FORMALIZATION_EMAIL'];
const MAX_FIELD_LENGTH = 5000;
const MAX_RATE_CLIENT = 30;
const MAX_RATE_GLOBAL = 200;
const MAX_DAILY_CALLS = 5000;

/* ============================================
   doGet - InformaÃ§Ãµes seguras
   ============================================ */

function doGet(e) {
    const props = PropertiesService.getScriptProperties();
    const aiKey = props.getProperty('GROQ_API_KEY');
    return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        service: APP_NAME,
        version: APP_VERSION,
        aiConfigured: !!(aiKey && aiKey.length > 10)
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
            return jsonResponse({ status: 'error', message: 'AÃ§Ã£o invÃ¡lida.' }, 400);
        }

        checkRateLimits(appId);

        switch (action) {
            case 'SAVE_PDF':
                return handleSavePdf(body);
            case 'AI_NR35_RISKS':
                return handleAiRisks(body);
            case 'AI_NR35_RESCUE':
                return handleAiRescue(body);
            case 'FORMALIZATION_SAVE':
                return handleFormalizationSave(body);
            case 'FORMALIZATION_LIST':
                return handleFormalizationList(body);
            case 'FORMALIZATION_GET':
                return handleFormalizationGet(body);
            case 'SEND_FORMALIZATION_EMAIL':
                return handleSendFormalizationEmail(body);
            default:
                return jsonResponse({ status: 'error', message: 'AÃ§Ã£o nÃ£o implementada.' }, 400);
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
        throw new Error('Limite diÃ¡rio excedido.');
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
                return jsonResponse({ status: 'error', message: 'Campo obrigatÃ³rio ausente: ' + field }, 400);
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
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
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
        return jsonResponse({ status: 'error', message: 'DescriÃ§Ã£o da tarefa obrigatÃ³ria.' }, 400);
    }

    const prompt = 'VocÃª Ã© um especialista em seguranÃ§a do trabalho NR-35 (Trabalho em Altura). ' +
        'Analise a seguinte tarefa e gere uma lista de 3 riscos e 3 medidas de prevenÃ§Ã£o. ' +
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
        return jsonResponse({ status: 'error', message: 'DescriÃ§Ã£o da tarefa obrigatÃ³ria.' }, 400);
    }

    const prompt = 'VocÃª Ã© um especialista em resgate em altura e NR-35. ' +
        'Crie um plano de resgate rÃ¡pido e prÃ¡tico para a seguinte tarefa. ' +
        'Responda APENAS com o texto limpo, sem asteriscos, sem markdown, em tÃ³picos diretos. ' +
        'Inclua: 1) Acionamento inicial, 2) AvaliaÃ§Ã£o do local, 3) Procedimento de resgate, 4) Primeiros socorros, 5) ComunicaÃ§Ã£o.\n\n' +
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
        Logger.log('GROQ_API_KEY nÃ£o configurada. Retornando fallback.');
        return jsonResponse({
            status: 'fallback',
            message: 'IA nÃ£o configurada. Use o preenchimento manual.',
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
                message: 'AutenticaÃ§Ã£o da IA falhou.',
                content: ''
            });
        }

        if (code === 429) {
            Logger.log('Groq rate limit atingido');
            return jsonResponse({
                status: 'fallback',
                message: 'IA temporariamente indisponÃ­vel (limite de uso).',
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
            message: 'IA indisponÃ­vel. Verifique sua conexÃ£o.',
            content: ''
        });
    }
}

/* ============================================
   UtilitÃ¡rios
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
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return folder;
}

/* ============================================
   Menu da Planilha
   ============================================ */

function onOpen() {
    SpreadsheetApp.getUi()
        .createMenu('GRUPO SRF SeguranÃ§a 4.0')
        .addItem('Inserir/Corrigir CabeÃ§alhos', 'setupHeaders')
        .addItem('Verificar configuraÃ§Ã£o da IA', 'checkAIConfig')
        .addToUi();
}

function setupHeaders() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Dados PTA');
    if (!sheet) {
        sheet = ss.insertSheet('Dados PTA');
    }

    const headers = [
        'Data Registro', 'EmissÃ£o', 'TÃ©rmino', 'MÃ£o de Obra', 'Qtd Trabalhadores',
        'Nomes Equipe', 'Local', 'Altura', 'Tarefa', 'Clima', 'EPIs', 'EPCs',
        'Riscos', 'Plano Resgate', 'Emissor', 'Supervisor', 'Checklist',
        'Nome Arquivo', 'URL Drive', 'VersÃ£o'
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
        SpreadsheetApp.getUi().alert('CabeÃ§alhos inseridos com sucesso!');
    } else {
        const ui = SpreadsheetApp.getUi();
        const response = ui.alert(
            'CabeÃ§alhos existentes',
            'JÃ¡ existem cabeÃ§alhos. Deseja substituÃ­-los?',
            ui.ButtonSet.YES_NO
        );
        if (response === ui.Button.YES) {
            sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
            sheet.getRange(1, 1, 1, headers.length)
                .setFontWeight('bold')
                .setBackground('#FFC107')
                .setFontColor('#000000');
            ui.alert('CabeÃ§alhos atualizados!');
        }
    }
}

function checkAIConfig() {
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('GROQ_API_KEY');
    const model = props.getProperty('GROQ_MODEL') || 'llama-3.3-70b-versatile';

    const configured = !!(apiKey && apiKey.length > 10);
    const status = configured ? 'Configurada' : 'NÃƒO configurada';

    SpreadsheetApp.getUi().alert(
        'ConfiguraÃ§Ã£o da IA - GRUPO SRF',
        'Status: ' + status + '\n' +
        'Modelo: ' + model + '\n' +
        'VersÃ£o: ' + APP_VERSION + '\n\n' +
        (configured ? 'A chave estÃ¡ segura nas Propriedades do Script.' : 'Configure a propriedade GROQ_API_KEY nas Propriedades do Script.')
    );
}

/* ============================================
   FORMALIZACAO DE TESTES
   ============================================ */

function handleFormalizationSave(body) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        return jsonResponse({ status: 'error', message: 'Sistema ocupado. Tente novamente.' }, 503);
    }

    try {
        if (!body.formalization || typeof body.formalization !== 'object') {
            return jsonResponse({ status: 'error', message: 'Formalização inválida.' }, 400);
        }
        const formalization = body.formalization;
        if (!formalization.id || !formalization.number) {
            return jsonResponse({ status: 'error', message: 'Identificador e número obrigatórios.' }, 400);
        }

        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getSheetByName('Dados Formalizacao') || ss.insertSheet('Dados Formalizacao');
        if (sheet.getLastRow() === 0) {
            sheet.appendRow(['ID', 'Número', 'Título', 'Situação', 'Revisão', 'Atualizado em', 'JSON']);
        }

        const values = sheet.getDataRange().getValues();
        let rowIndex = -1;
        for (let i = 1; i < values.length; i++) {
            if (String(values[i][0]) === String(formalization.id)) {
                rowIndex = i + 1;
                break;
            }
        }

        const row = [
            formalization.id,
            formalization.number,
            sanitizeField(formalization.title),
            sanitizeField(formalization.status),
            sanitizeField(formalization.revision),
            new Date().toISOString(),
            JSON.stringify(formalization)
        ];

        if (rowIndex > 0) {
            sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
        } else {
            sheet.appendRow(row);
        }

        return jsonResponse({
            status: 'success',
            message: 'Formalização salva.',
            formalizationId: formalization.id,
            savedAt: new Date().toISOString()
        });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_SAVE: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', message: 'Erro ao salvar formalização: ' + sanitizeLog(err.message) }, 500);
    } finally {
        lock.releaseLock();
    }
}

function handleFormalizationList(body) {
    try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getSheetByName('Dados Formalizacao');
        if (!sheet) {
            return jsonResponse({ status: 'success', items: [] });
        }
        const values = sheet.getDataRange().getValues();
        const items = [];
        for (let i = 1; i < values.length; i++) {
            let record = null;
            try { record = JSON.parse(String(values[i][6] || '{}')); } catch (e) { record = null; }
            if (!record) continue;
            items.push({
                id: values[i][0],
                number: values[i][1],
                title: values[i][2],
                status: values[i][3],
                revision: values[i][4],
                updatedAt: values[i][5],
                products: (record.products || []).map(function (p) { return p.name; })
            });
        }
        return jsonResponse({ status: 'success', items: items });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_LIST: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', message: 'Erro ao listar formalizações.' }, 500);
    }
}

function handleFormalizationGet(body) {
    try {
        if (!body.id) {
            return jsonResponse({ status: 'error', message: 'Identificador obrigatório.' }, 400);
        }
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getSheetByName('Dados Formalizacao');
        if (!sheet) {
            return jsonResponse({ status: 'error', message: 'Formalização não encontrada.' }, 404);
        }
        const values = sheet.getDataRange().getValues();
        for (let i = 1; i < values.length; i++) {
            if (String(values[i][0]) === String(body.id)) {
                let record = null;
                try { record = JSON.parse(String(values[i][6] || '{}')); } catch (e) { record = null; }
                return jsonResponse({ status: 'success', formalization: record });
            }
        }
        return jsonResponse({ status: 'error', message: 'Formalização não encontrada.' }, 404);
    } catch (err) {
        Logger.log('Erro FORMALIZATION_GET: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', message: 'Erro ao obter formalização.' }, 500);
    }
}

function handleSendFormalizationEmail(body) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        return jsonResponse({ status: 'error', message: 'Sistema ocupado. Tente novamente.' }, 503);
    }

    try {
        if (!body.recipients || !body.recipients.to) {
            return jsonResponse({ status: 'error', message: 'Destinatário obrigatório.' }, 400);
        }
        if (!body.idempotencyKey) {
            return jsonResponse({ status: 'error', message: 'Chave de idempotência obrigatória.' }, 400);
        }

        const props = PropertiesService.getScriptProperties();
        const operationKey = 'FORMALIZATION_SEND_' + body.idempotencyKey;
        const existing = props.getProperty(operationKey);
        if (existing) {
            let parsed = null;
            try { parsed = JSON.parse(existing); } catch (e) { parsed = null; }
            if (parsed && parsed.contentHash && body.contentHash && parsed.contentHash !== body.contentHash) {
                return jsonResponse({ status: 'error', message: 'Conflito de idempotência: conteúdo diferente.' }, 409);
            }
            return jsonResponse({
                status: 'success',
                reused: true,
                communicationId: body.communicationId,
                message: 'Envio já registrado.'
            });
        }

        props.setProperty(operationKey, JSON.stringify({
            status: 'processamento',
            contentHash: body.contentHash || '',
            createdAt: new Date().toISOString()
        }));

        const attachments = [];
        if (Array.isArray(body.attachments)) {
            body.attachments.forEach(function (att, index) {
                if (att && att.base64) {
                    const bytes = Utilities.base64Decode(att.base64);
                    attachments.push(Utilities.newBlob(bytes, att.type || MimeType.PDF, att.name || ('anexo_' + index + '.pdf')));
                }
            });
        }

        const options = {
            to: body.recipients.to,
            subject: sanitizeField(body.subject),
            body: sanitizeField(body.body),
            name: 'Sistema-TS - Grupo SRF'
        };
        if (body.recipients.cc) options.cc = body.recipients.cc;
        if (body.recipients.reply) options.replyTo = body.recipients.reply;
        if (attachments.length) options.attachments = attachments;

        MailApp.sendEmail(options);

        props.setProperty(operationKey, JSON.stringify({
            status: 'enviado',
            contentHash: body.contentHash || '',
            createdAt: new Date().toISOString()
        }));

        return jsonResponse({
            status: 'success',
            message: 'E-mail enviado.',
            communicationId: body.communicationId,
            sentAt: new Date().toISOString()
        });
    } catch (err) {
        Logger.log('Erro SEND_FORMALIZATION_EMAIL: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', message: 'Erro ao enviar e-mail: ' + sanitizeLog(err.message) }, 500);
    } finally {
        lock.releaseLock();
    }
}
