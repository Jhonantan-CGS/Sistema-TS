# Backend Google Apps Script — PTA NR-35 V1.8

Este diretório contém o único arquivo necessário para o backend da aplicação:

- `Code.gs`

A chave Groq **não deve ser escrita no código, enviada ao GitHub ou adicionada ao JavaScript do navegador**.

## Implantação obrigatória

1. Abra o projeto Google Apps Script vinculado à planilha da PTA.
2. Substitua todo o conteúdo do arquivo atual pelo conteúdo de `Code.gs` deste diretório.
3. Abra **Configurações do projeto**.
4. Em **Propriedades do script**, adicione:
   - Propriedade: `GROQ_API_KEY`
   - Valor: a nova chave Groq.
5. Opcionalmente, adicione:
   - Propriedade: `GROQ_MODEL`
   - Valor: o identificador do modelo liberado na sua conta Groq.
6. Acesse **Implantar > Gerenciar implantações**.
7. Edite a implantação atual pelo ícone de lápis.
8. Em **Versão**, selecione **Nova versão**.
9. Mantenha:
   - Executar como: **Eu**.
   - Quem pode acessar: **Qualquer pessoa**.
10. Clique em **Implantar**.

Ao editar a implantação existente, a URL do Web App permanece a mesma e o frontend não precisa ser alterado.

## Validação

1. Reabra a planilha.
2. No menu **GRUPO SRF Segurança 4.0**, clique em **Verificar configuração da IA**.
3. Abra a aplicação V1.8.
4. Preencha a descrição, o local e a altura.
5. Clique em **Gerar com IA protegida**.

Quando a Groq estiver indisponível, sem chave ou limitada, o frontend utiliza automaticamente o assistente técnico local e a emissão da PTA continua funcionando.

## Segurança aplicada

- Chave somente em `PropertiesService`.
- Nenhuma chave no GitHub Pages.
- Ações permitidas fixas.
- Prompts montados no servidor.
- Limites por cliente, por minuto e por dia.
- Limite de tamanho de entrada e PDF.
- Logs higienizados para remover padrões de chave.
- Fallback local automático.
- Gravação de PDF e planilha preservada.

## Responsável

Desenvolvido por **Jhonantan Cardoso Gonçalves**  
WhatsApp: https://wa.me/5548992159791
