/* ============================================
   FORMALIZACAO DE TESTES — backend
   Arquivo central: Drive privado + índice em Sheets.
   Nunca gravar documentos base64 em célula.
   ============================================ */

const FORMALIZATION_MAX_DOC_BYTES = 15 * 1024 * 1024;
const FORMALIZATION_MAX_MAIL_BYTES = 18 * 1024 * 1024;
const FORMALIZATION_ALLOWED_MIME = ['application/pdf', 'message/rfc822', 'application/octet-stream', 'text/plain'];

const HEADERS_INDEX = ['ID', 'Número', 'Título', 'Situação', 'Revisão', 'Atualizado em', 'JSON', 'Versão'];
const HEADERS_DOC = ['DocID', 'FormalizationID', 'Revisão', 'Tipo', 'Produto', 'Arquivo', 'MimeType', 'Tamanho', 'SHA256', 'StorageId', 'Criado em', 'Vínculo'];
const HEADERS_COMM = ['CommID', 'FormalizationID', 'Revisão', 'Para', 'Cópias', 'Resposta', 'Assunto', 'ContentHash', 'SendKey', 'Status', 'Criado em', 'Enviado em', 'Detalhe'];

function obterSpreadsheetFormalizacao_() {
    const props = PropertiesService.getScriptProperties();
    const ssId = props.getProperty('FORMALIZATION_SS_ID');
    if (ssId) {
        try {
            return SpreadsheetApp.openById(ssId);
        } catch (e) {
            throw new Error('Planilha central (FORMALIZATION_SS_ID) inacessível. Corrija o ID ou a permissão em Propriedades do Script; não crie outra planilha silenciosamente.');
        }
    }
    const ss = SpreadsheetApp.create('Sistema-TS Formalizacoes');
    props.setProperty('FORMALIZATION_SS_ID', ss.getId());
    return ss;
}

function obterPastaRaizFormalizacao_() {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty('FORMALIZATION_FOLDER_ID');
    if (id) {
        try {
            return DriveApp.getFolderById(id);
        } catch (e) {
            throw new Error('Pasta central de formalizações (FORMALIZATION_FOLDER_ID) inacessível. Corrija o ID em Propriedades do Script.');
        }
    }
    const folder = DriveApp.createFolder('GRUPO SRF - Formalizacoes (privado)');
    props.setProperty('FORMALIZATION_FOLDER_ID', folder.getId());
    Logger.log('Pasta raiz de formalizações criada: ' + folder.getId());
    return folder;
}

function obterPastaDoRegistro_(formalizationId, subfolder) {
    const root = obterPastaRaizFormalizacao_();
    const name = 'formalizacao-' + String(formalizationId).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);
    let recordFolder = null;
    const it = root.getFoldersByName(name);
    if (it.hasNext()) {
        recordFolder = it.next();
    } else {
        recordFolder = root.createFolder(name);
    }
    if (!subfolder) return recordFolder;
    const subIt = recordFolder.getFoldersByName(subfolder);
    return subIt.hasNext() ? subIt.next() : recordFolder.createFolder(subfolder);
}

function arquivoPertenceARaiz_(file) {
    const rootId = obterPastaRaizFormalizacao_().getId();
    let parents = file.getParents();
    for (let depth = 0; depth < 3 && parents.hasNext(); depth++) {
        const parent = parents.next();
        if (parent.getId() === rootId) return true;
        parents = parent.getParents();
    }
    return false;
}

function decodeAndVerifyBase64_(base64, expectedSha256, expectedSize) {
    let bytes;
    try {
        bytes = Utilities.base64Decode(base64);
    } catch (e) {
        throw new Error('Conteúdo base64 inválido.');
    }
    if (expectedSize && Math.abs(bytes.length - Number(expectedSize)) > 8) {
        throw new Error('Tamanho declarado não confere com os bytes recebidos.');
    }
    if (bytes.length > FORMALIZATION_MAX_DOC_BYTES) {
        throw new Error('Arquivo excede o limite de 15 MB.');
    }
    const hash = sha256Hex_(bytes);
    if (expectedSha256 && String(expectedSha256).toLowerCase() !== hash) {
        const err = new Error('Hash SHA-256 não confere com os bytes recebidos.');
        err.code = 'hash_mismatch';
        throw err;
    }
    return { bytes: bytes, sha256: hash };
}

function strippedRecord_(record) {
    const copy = JSON.parse(JSON.stringify(record || {}));
    if (Array.isArray(copy.products)) {
        copy.products.forEach(function (p) { if (p.fds) delete p.fds.dataUrl; });
    }
    if (Array.isArray(copy.responses)) {
        copy.responses.forEach(function (r) { if (r.file) delete r.file.dataUrl; });
    }
    if (Array.isArray(copy.communications)) {
        copy.communications.forEach(function (c) {
            if (Array.isArray(c.attachments)) {
                c.attachments.forEach(function (a) { delete a.base64; delete a.dataUrl; });
            }
        });
    }
    return copy;
}

function readIndexRows_(sheet) {
    const values = sheet.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < values.length; i++) {
        rows.push({ rowIndex: i + 1, values: values[i] });
    }
    return rows;
}

function findByKey_(rows, colIndex, value) {
    for (let i = 0; i < rows.length; i++) {
        if (String(rows[i].values[colIndex]) === String(value)) return rows[i];
    }
    return null;
}

function jsonError_(message, code) {
    return jsonResponse({ status: 'error', code: code || 'ERROR', message: message }, 400);
}

function obterFormalizacaoSheet_(ss, name, headers) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
        sheet = ss.insertSheet(name);
        sheet.appendRow(headers);
        sheet.setFrozenRows(1);
        return sheet;
    }
    if (sheet.getLastRow() === 0) {
        sheet.appendRow(headers);
        sheet.setFrozenRows(1);
    }
    return sheet;
}

function handleFormalizationSave(body) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        return jsonResponse({ status: 'error', code: 'busy', message: 'Sistema ocupado. Tente novamente.' }, 503);
    }
    try {
        const formalization = body.formalization;
        if (!formalization || typeof formalization !== 'object') {
            return jsonError_('Formalização inválida.', 'invalid_payload');
        }
        if (!formalization.id || !formalization.number) {
            return jsonError_('Identificador e número obrigatórios.', 'invalid_payload');
        }
        const ss = obterSpreadsheetFormalizacao_();
        const sheet = obterFormalizacaoSheet_(ss, 'Dados Formalizacao', HEADERS_INDEX);
        const rows = readIndexRows_(sheet);
        const existing = findByKey_(rows, 0, formalization.id);

        const storedVersion = existing ? (parseInt(existing.values[7], 10) || 0) : 0;
        const baseVersion = parseInt(formalization.baseVersion, 10);
        const expectedBase = isNaN(baseVersion) ? storedVersion : baseVersion;
        if (existing && expectedBase !== storedVersion) {
            let serverRecord = null;
            try { serverRecord = JSON.parse(String(existing.values[6] || '{}')); } catch (e) { serverRecord = null; }
            return jsonResponse({
                status: 'error',
                code: 'conflict',
                message: 'A formalização foi alterada no servidor após a sua última leitura. Nenhum dado foi sobrescrito.',
                serverVersion: storedVersion,
                serverRecord: serverRecord,
                serverUpdatedAt: existing.values[5]
            }, 409);
        }
        const newVersion = existing ? storedVersion + 1 : 1;
        const record = strippedRecord_(formalization);
        const row = [
            String(formalization.id),
            String(formalization.number),
            sanitizeField(formalization.title),
            sanitizeField(formalization.status),
            sanitizeField(formalization.revision),
            new Date().toISOString(),
            JSON.stringify(record),
            newVersion
        ];
        if (existing) {
            sheet.getRange(existing.rowIndex, 1, 1, row.length).setValues([row]);
        } else {
            sheet.appendRow(row);
        }
        return jsonResponse({
            status: 'success',
            message: 'Formalização salva.',
            formalizationId: formalization.id,
            version: newVersion,
            savedAt: new Date().toISOString()
        });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_SAVE: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: 'save_failed', message: 'Erro ao salvar formalização: ' + sanitizeLog(err.message) }, 500);
    } finally {
        lock.releaseLock();
    }
}

function handleFormalizationList(body) {
    try {
        const ss = obterSpreadsheetFormalizacao_();
        const sheet = ss.getSheetByName('Dados Formalizacao');
        if (!sheet) {
            return jsonResponse({ status: 'success', items: [] });
        }
        const rows = readIndexRows_(sheet);
        const items = [];
        rows.forEach(function (row) {
            let record = null;
            try { record = JSON.parse(String(row.values[6] || '{}')); } catch (e) { record = null; }
            if (!record) return;
            items.push({
                id: row.values[0],
                number: row.values[1],
                title: row.values[2],
                status: row.values[3],
                revision: row.values[4],
                updatedAt: row.values[5],
                version: parseInt(row.values[7], 10) || 0,
                products: Array.isArray(record.products) ? record.products.map(function (p) { return p.name; }) : []
            });
        });
        return jsonResponse({ status: 'success', items: items });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_LIST: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: 'list_failed', message: 'Erro ao listar formalizações: ' + sanitizeLog(err.message) }, 500);
    }
}

function handleFormalizationGet(body) {
    try {
        if (!body.id) {
            return jsonError_('Identificador obrigatório.', 'invalid_payload');
        }
        const ss = obterSpreadsheetFormalizacao_();
        const sheet = ss.getSheetByName('Dados Formalizacao');
        if (!sheet) {
            return jsonResponse({ status: 'error', code: 'not_found', message: 'Formalização não encontrada.' }, 404);
        }
        const found = findByKey_(readIndexRows_(sheet), 0, body.id);
        if (!found) {
            return jsonResponse({ status: 'error', code: 'not_found', message: 'Formalização não encontrada.' }, 404);
        }
        let record = null;
        try { record = JSON.parse(String(found.values[6] || '{}')); } catch (e) { record = null; }
        return jsonResponse({
            status: 'success',
            formalization: record,
            version: parseInt(found.values[7], 10) || 0
        });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_GET: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: 'get_failed', message: 'Erro ao obter formalização.' }, 500);
    }
}

function validarDoc_(body) {
    const kind = String(body.kind || 'other');
    if (['fds', 'procedure', 'response', 'other'].indexOf(kind) < 0) {
        throw new Error('Tipo de documento inválido.');
    }
    const mimeType = String(body.mimeType || 'application/octet-stream');
    if (FORMALIZATION_ALLOWED_MIME.indexOf(mimeType) < 0) {
        throw new Error('Formato não permitido. Envie PDF ou .eml.');
    }
    if (!body.fileName) throw new Error('Nome de arquivo obrigatório.');
    if (!body.base64) throw new Error('Conteúdo do arquivo ausente.');
    const decoded = decodeAndVerifyBase64_(String(body.base64), body.sha256, body.size);
    return { kind: kind, mimeType: mimeType, decoded: decoded };
}

function handleFormalizationUploadDoc(body) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        return jsonResponse({ status: 'error', code: 'busy', message: 'Sistema ocupado. Tente novamente.' }, 503);
    }
    try {
        if (!body.formalizationId) {
            return jsonError_('Identificador da formalização obrigatório.', 'invalid_payload');
        }
        const doc = validarDoc_(body);
        const revision = String(body.revision || 'R0').substring(0, 10);
        const folder = obterPastaDoRegistro_(body.formalizationId, doc.kind === 'response' ? 'respostas' : ('revisao-' + revision.replace(/[^a-zA-Z0-9_-]/g, '_')));
        const fileName = sanitizeFileName(body.fileName);
        const blob = Utilities.newBlob(doc.decoded.bytes, doc.mimeType, fileName);
        const file = folder.createFile(blob);
        const ss = obterSpreadsheetFormalizacao_();
        const sheet = obterFormalizacaoSheet_(ss, 'Documentos', HEADERS_DOC);
        const docId = Utilities.getUuid();
        sheet.appendRow([
            docId,
            String(body.formalizationId),
            revision,
            doc.kind,
            sanitizeField(body.productName || ''),
            fileName,
            doc.mimeType,
            doc.decoded.bytes.length,
            doc.decoded.sha256,
            file.getId(),
            new Date().toISOString(),
            sanitizeField(body.link || '')
        ]);
        return jsonResponse({
            status: 'success',
            storageId: file.getId(),
            sha256: doc.decoded.sha256,
            size: doc.decoded.bytes.length,
            fileName: fileName
        });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_UPLOAD_DOC: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: err.code || 'upload_failed', message: 'Erro ao arquivar documento: ' + sanitizeLog(err.message) }, 400);
    } finally {
        lock.releaseLock();
    }
}

function handleFormalizationDocGet(body) {
    try {
        const storageId = String(body.storageId || '');
        if (!storageId) {
            return jsonError_('storageId obrigatório.', 'invalid_payload');
        }
        let file;
        try {
            file = DriveApp.getFileById(storageId);
        } catch (e) {
            return jsonResponse({ status: 'error', code: 'not_found', message: 'Documento não encontrado.' }, 404);
        }
        if (!arquivoPertenceARaiz_(file)) {
            return jsonResponse({ status: 'error', code: 'forbidden', message: 'Documento fora do arquivo central. Acesso negado.' }, 403);
        }
        const size = file.getSize();
        if (size > FORMALIZATION_MAX_DOC_BYTES) {
            return jsonResponse({ status: 'error', code: 'too_large', message: 'Documento excede o limite de download.' }, 400);
        }
        return jsonResponse({
            status: 'success',
            name: file.getName(),
            mimeType: file.getMimeType(),
            size: size,
            base64: Utilities.base64Encode(file.getBlob().getBytes())
        });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_DOC_GET: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: 'doc_get_failed', message: 'Erro ao obter documento.' }, 500);
    }
}

const EMAIL_REGEX_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeEmail_(value) {
    return String(value || '').trim().substring(0, 320);
}

function splitEmailList_(value) {
    return String(value || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s && EMAIL_REGEX_.test(s); });
}

function buildMailAttachments_(attachments, formalizationId) {
    const blobs = [];
    let totalBytes = 0;
    if (!Array.isArray(attachments)) return { blobs: blobs, totalBytes: 0 };
    attachments.forEach(function (att, index) {
        if (!att || !att.name) throw new Error('Anexo ' + (index + 1) + ' sem nome.');
        const fileName = sanitizeFileName(att.name);
        let bytes = null;
        if (att.storageId) {
            let file;
            try {
                file = DriveApp.getFileById(String(att.storageId));
            } catch (e) {
                throw new Error('Arquivo anexado não encontrado no Drive: ' + fileName);
            }
            if (!arquivoPertenceARaiz_(file)) {
                throw new Error('Anexo fora do arquivo central: ' + fileName);
            }
            bytes = file.getBlob().getBytes();
            if (att.sha256 && sha256Hex_(bytes) !== String(att.sha256).toLowerCase()) {
                throw new Error('Hash do anexo não confere com o arquivo armazenado: ' + fileName);
            }
            blobs.push(Utilities.newBlob(bytes, att.type || file.getMimeType() || 'application/pdf', fileName));
        } else if (att.base64) {
            const decoded = decodeAndVerifyBase64_(String(att.base64), att.sha256, att.size);
            bytes = decoded.bytes;
            blobs.push(Utilities.newBlob(bytes, att.type || 'application/pdf', fileName));
        } else {
            throw new Error('Anexo sem conteúdo: ' + fileName);
        }
        totalBytes += bytes.length;
    });
    if (totalBytes > FORMALIZATION_MAX_MAIL_BYTES) {
        throw new Error('Anexos somam mais de 18 MB. Preserve a composição e reduza os arquivos antes de enviar.');
    }
    return { blobs: blobs, totalBytes: totalBytes };
}

function findCommByKey_(rows, sendKey) {
    return findByKey_(rows, 8, sendKey);
}

function commRowToObject_(values) {
    return {
        communicationId: values[0],
        formalizationId: values[1],
        revision: values[2],
        to: values[3],
        cc: values[4],
        replyTo: values[5],
        subject: values[6],
        contentHash: values[7],
        sendKey: values[8],
        status: values[9],
        createdAt: values[10],
        sentAt: values[11] || '',
        detail: values[12] || ''
    };
}

function readCommunications_(ss) {
    const sheet = obterFormalizacaoSheet_(ss, 'Comunicacoes', HEADERS_COMM);
    return { sheet: sheet, rows: readIndexRows_(sheet) };
}

function handleFormalizationSend(body) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        return jsonResponse({ status: 'error', code: 'busy', message: 'Sistema ocupado. Tente novamente.' }, 503);
    }
    try {
        const recipients = body.recipients || {};
        const to = sanitizeEmail_(recipients.to);
        if (!EMAIL_REGEX_.test(to)) {
            return jsonError_('Destinatário obrigatório e válido.', 'invalid_recipient');
        }
        const ccList = splitEmailList_(recipients.cc);
        const replyTo = recipients.reply ? sanitizeEmail_(recipients.reply) : '';
        if (recipients.reply && !EMAIL_REGEX_.test(replyTo)) {
            return jsonError_('Endereço de resposta inválido.', 'invalid_reply_to');
        }
        const subject = String(body.subject || '').trim().substring(0, 300);
        const mailBody = String(body.body || '');
        if (!subject) return jsonError_('Assunto obrigatório.', 'invalid_subject');
        if (mailBody.length < 20) return jsonError_('Corpo da mensagem muito curto.', 'invalid_body');
        if (mailBody.length > 20000) return jsonError_('Corpo da mensagem excede o limite.', 'invalid_body');
        const sendKey = String(body.idempotencyKey || '').trim().substring(0, 200);
        const contentHash = String(body.contentHash || '').trim().substring(0, 128);
        if (!sendKey || !contentHash) {
            return jsonError_('Chave de idempotência e hash de conteúdo obrigatórios.', 'invalid_payload');
        }
        if (!body.formalizationId) {
            return jsonError_('Identificador da formalização obrigatório.', 'invalid_payload');
        }

        const ss = obterSpreadsheetFormalizacao_();
        const comm = readCommunications_(ss);
        const existing = findCommByKey_(comm.rows, sendKey);
        if (existing) {
            const storedHash = String(existing.values[7]);
            if (storedHash !== contentHash) {
                return jsonResponse({
                    status: 'error',
                    code: 'idempotency_conflict',
                    message: 'A chave de envio já existe com conteúdo diferente. Nenhuma mensagem foi reenviada.'
                }, 409);
            }
            const state = String(existing.values[9]);
            return jsonResponse({
                status: 'success',
                reused: true,
                communicationState: state,
                communicationId: existing.values[0],
                sentAt: existing.values[11] || '',
                message: state === 'enviado' ? 'Envio já confirmado anteriormente.' : 'Envio em estado: ' + state + '.'
            });
        }

        const communicationId = String(body.communicationId || Utilities.getUuid());
        const attachmentInfo = buildMailAttachments_(body.attachments, body.formalizationId);

        const newRow = [
            communicationId,
            String(body.formalizationId),
            String(body.revision || 'R0').substring(0, 10),
            to,
            ccList.join(', '),
            replyTo,
            subject,
            contentHash,
            sendKey,
            'processamento',
            new Date().toISOString(),
            '',
            ''
        ];
        comm.sheet.appendRow(newRow);
        const appendedRowIndex = comm.sheet.getLastRow();

        const simulated = PropertiesService.getScriptProperties().getProperty('FORMALIZATION_MAIL_MODE') === 'SIMULATED';
        try {
            if (simulated) {
                Logger.log('FORMALIZATION_MAIL_MODE=SIMULATED. E-mail NÃO enviado. communicationId=' + communicationId);
            } else {
                const options = {
                    to: to,
                    subject: subject,
                    body: mailBody,
                    name: 'Sistema-TS - Grupo SRF'
                };
                if (ccList.length) options.cc = ccList.join(',');
                if (replyTo) options.replyTo = replyTo;
                if (attachmentInfo.blobs.length) options.attachments = attachmentInfo.blobs;
                MailApp.sendEmail(options);
            }
            const sentAt = new Date().toISOString();
            comm.sheet.getRange(appendedRowIndex, 10, 1, 3).setValues([['enviado', sentAt, simulated ? 'SIMULADO (transporte de teste)' : '']]);
            return jsonResponse({
                status: 'success',
                communicationState: 'enviado',
                communicationId: communicationId,
                sentAt: sentAt,
                simulated: simulated,
                message: simulated ? 'Envio simulado (transporte de teste). Nenhuma mensagem real foi transmitida.' : 'E-mail enviado.'
            });
        } catch (sendErr) {
            const detail = sanitizeLog(sendErr.message);
            comm.sheet.getRange(appendedRowIndex, 10, 1, 3).setValues([['pendente', '', 'Falha apos possivel transmissao: ' + detail]]);
            return jsonResponse({
                status: 'error',
                code: 'send_uncertain',
                communicationState: 'pendente',
                communicationId: communicationId,
                message: 'Não foi possível confirmar o envio. Consulte esta comunicação antes de tentar novamente.'
            }, 500);
        }
    } catch (err) {
        Logger.log('Erro FORMALIZATION_SEND: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: err.code || 'send_failed', message: 'Erro ao preparar o envio: ' + sanitizeLog(err.message) }, 400);
    } finally {
        lock.releaseLock();
    }
}

function handleFormalizationSendStatus(body) {
    try {
        const ss = obterSpreadsheetFormalizacao_();
        const comm = readCommunications_(ss);
        let found = null;
        if (body.idempotencyKey) {
            found = findCommByKey_(comm.rows, String(body.idempotencyKey));
        } else if (body.communicationId) {
            found = findByKey_(comm.rows, 0, String(body.communicationId));
        }
        if (!found) {
            return jsonResponse({ status: 'error', code: 'not_found', message: 'Comunicação não encontrada.' }, 404);
        }
        const result = commRowToObject_(found.values);
        result.communicationState = result.status;
        result.status = 'success';
        return jsonResponse(result);
    } catch (err) {
        Logger.log('Erro FORMALIZATION_SEND_STATUS: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: 'status_failed', message: 'Erro ao consultar o envio.' }, 500);
    }
}

function handleFormalizationResponse(body) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        return jsonResponse({ status: 'error', code: 'busy', message: 'Sistema ocupado. Tente novamente.' }, 503);
    }
    try {
        if (!body.formalizationId) {
            return jsonError_('Identificador da formalização obrigatório.', 'invalid_payload');
        }
        const ss = obterSpreadsheetFormalizacao_();
        const comm = readCommunications_(ss);
        let revision = 'R0';
        if (body.communicationId) {
            const found = findByKey_(comm.rows, 0, String(body.communicationId));
            if (!found) {
                return jsonResponse({ status: 'error', code: 'invalid_communication', message: 'A comunicação escolhida não existe.' }, 400);
            }
            if (String(found.values[1]) !== String(body.formalizationId)) {
                return jsonResponse({ status: 'error', code: 'invalid_communication', message: 'A comunicação pertence a outra formalização.' }, 400);
            }
            revision = String(found.values[2] || 'R0');
        }
        const sender = sanitizeField(body.sender || '').substring(0, 320);
        let receivedAt = '';
        if (body.receivedAt) {
            const parsed = new Date(body.receivedAt);
            if (isNaN(parsed.getTime())) {
                return jsonError_('Data de recebimento inválida. Deixe em branco se desconhecida.', 'invalid_received_at');
            }
            receivedAt = parsed.toISOString();
        }
        const content = String(body.content || '').substring(0, 20000);
        const manual = body.manual === true;
        let storageId = '';
        let sha256 = String(body.sha256 || '').toLowerCase();
        let fileName = '';
        let size = 0;
        if (body.fileBase64) {
            const doc = validarDoc_({
                kind: 'response',
                fileName: body.fileName,
                mimeType: body.mimeType,
                size: body.size,
                sha256: body.sha256,
                base64: body.fileBase64
            });
            const docSheet = obterFormalizacaoSheet_(ss, 'Documentos', HEADERS_DOC);
            const docRows = readIndexRows_(docSheet);
            const duplicate = docRows.some(function (row) {
                return String(row.values[8]).toLowerCase() === doc.decoded.sha256 && String(row.values[3]) === 'response';
            });
            if (duplicate && body.confirmDuplicate !== true) {
                return jsonResponse({
                    status: 'error',
                    code: 'duplicate_document',
                    message: 'Este arquivo já foi registrado como resposta (hash idêntico). Confirme para registrar mesmo assim.'
                }, 409);
            }
            const folder = obterPastaDoRegistro_(body.formalizationId, 'respostas');
            fileName = sanitizeFileName(body.fileName);
            const file = folder.createFile(Utilities.newBlob(doc.decoded.bytes, doc.mimeType, fileName));
            storageId = file.getId();
            sha256 = doc.decoded.sha256;
            size = doc.decoded.bytes.length;
            docSheet.appendRow([
                Utilities.getUuid(),
                String(body.formalizationId),
                revision,
                'response',
                '',
                fileName,
                doc.mimeType,
                size,
                sha256,
                storageId,
                new Date().toISOString(),
                String(body.communicationId || '')
            ]);
        }
        if (!storageId && !content) {
            return jsonError_('Anexe o original (.eml/PDF) ou informe o conteúdo/resumo da resposta.', 'invalid_payload');
        }
        return jsonResponse({
            status: 'success',
            communicationId: body.communicationId || '',
            revision: revision,
            sender: sender,
            receivedAt: receivedAt,
            manual: manual,
            storageId: storageId,
            sha256: sha256,
            size: size,
            fileName: fileName,
            registeredAt: new Date().toISOString()
        });
    } catch (err) {
        Logger.log('Erro FORMALIZATION_RESPONSE: ' + sanitizeLog(err.message));
        return jsonResponse({ status: 'error', code: err.code || 'response_failed', message: 'Erro ao registrar a resposta: ' + sanitizeLog(err.message) }, 400);
    } finally {
        lock.releaseLock();
    }
}
