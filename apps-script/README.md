# Backend Google Apps Script — PTA NR-35 V1.8

Este diretório contém o backend seguro da aplicação:

- `Code.gs`

A chave Groq **não deve ser escrita no código, enviada ao GitHub ou adicionada ao JavaScript do navegador**.

## Implantação automática

O repositório possui o workflow:

- `.github/workflows/deploy-apps-script.yml`

Ele executa, nesta ordem:

1. valida os secrets `CLASPRC_JSON` e `CLASP_JSON`;
2. autentica o `clasp` em ambiente isolado;
3. baixa o projeto remoto atual;
4. preserva o `appsscript.json` e demais configurações remotas;
5. cria um backup antes de qualquer alteração;
6. confirma que o ID da implantação pertence ao projeto autorizado;
7. bloqueia código com chave Groq exposta;
8. valida a sintaxe do `Code.gs`;
9. substitui somente o `Code.gs` pelo código versionado;
10. executa `clasp push --force`;
11. atualiza a implantação existente sem mudar sua URL;
12. testa o endpoint e confirma o serviço e a versão 1.8;
13. salva backup, diff e relatório como artefato temporário do GitHub Actions.

Por padrão, o workflow abre em modo **dry-run**, que apenas audita e não altera o Apps Script.

## Credenciais necessárias

Em **Settings → Secrets and variables → Actions**, devem existir:

- `CLASPRC_JSON`: conteúdo do arquivo `~/.clasprc.json` criado pelo `clasp login`;
- `CLASP_JSON`: conteúdo do arquivo `.clasp.json` que contém o `scriptId` do projeto correto.

Esses arquivos são bloqueados pelo `.gitignore` e nunca devem ser adicionados ao repositório.

## Chave Groq

No Google Apps Script, em **Configurações do projeto → Propriedades do script**, cadastre:

- `GROQ_API_KEY`: nova chave Groq;
- `GROQ_MODEL`: opcional; caso ausente, o backend utiliza `llama-3.3-70b-versatile`.

## Execução

1. Abra **Actions → Deploy Apps Script safely**.
2. Clique em **Run workflow**.
3. Primeiro execute com `dry_run: true`.
4. Após a auditoria aprovada, execute com `dry_run: false`.

O ID padrão corresponde à implantação já usada pelo frontend. O workflow confere se esse ID realmente pertence ao projeto autorizado antes de permitir qualquer escrita.

## Contingência

Enquanto a credencial ou a chave Groq não estiver configurada, o frontend continua utilizando automaticamente o assistente local e não bloqueia a emissão da PTA.

## Responsável

Desenvolvido por **Jhonantan Cardoso Gonçalves**  
WhatsApp: https://wa.me/5548992159791
