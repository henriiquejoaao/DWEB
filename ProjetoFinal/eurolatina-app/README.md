# EUROLATINA — Sistema de Contas a Pagar

Aplicação web local para controle das contas a pagar da **Metalúrgica Usinagem EUROLATINA**. O painel organiza as obrigações por vencimento e mantém os dados em SQLite.

## Organização das telas

A aplicação possui duas telas acessadas pela navegação no cabeçalho:

- **Dashboard:** visão consolidada com indicadores financeiros, agenda de vencimentos, despesas por categoria e últimos lançamentos. Os indicadores consideram todas as contas cadastradas.
- **Agenda:** calendário mensal com navegação entre meses, identificação visual de contas vencidas, a vencer e liquidadas, resumo dos valores do mês e painel de detalhes do dia selecionado. A partir dos cards do dia é possível cadastrar, editar, liquidar/reabrir, excluir e anexar documentos.

Os filtros da tela **Agenda** não alteram os totais consolidados exibidos no **Dashboard**. A agenda mostra os vencimentos do mês selecionado e permite consultar o detalhe de cada dia.

## Funcionalidades

- Cadastro de contas com fornecedor, vencimento, valor, categoria, número de documento e observações.
- Edição dos dados de uma conta.
- Liquidação de pagamento, com registro automático da data de liquidação.
- Reabertura de uma conta liquidada, voltando o status para pendente.
- Exclusão da conta e do documento relacionado.
- Anexar, visualizar/baixar, substituir e remover documentos.
- Agenda mensal com navegação mês a mês, seleção de dias e resumo de contas pendentes/liquidadas.
- Totais em reais, indicadores financeiros, pesquisa e filtros por status, categoria e período.
- Migração automática da tabela antiga `contas`, sem apagar os registros que já existirem.

## Tecnologias

- Node.js
- Express
- SQLite (`sqlite3`)
- HTML5, CSS3 e JavaScript puro (`fetch`)

## Requisitos

- Node.js 18 ou superior (recomendado Node.js 20 ou 22).
- npm.

## Como executar no Linux / Pop!_OS

1. Extraia o arquivo ZIP.
2. Entre na pasta do projeto:

   ```bash
   cd eurolatina-app
   ```

3. Instale as dependências:

   ```bash
   npm install
   ```

4. Execute os testes automatizados (opcional):

   ```bash
   npm test
   ```

5. Inicie o servidor:

   ```bash
   npm start
   ```

6. Abra no navegador:

   ```text
   http://localhost:3000
   ```

O banco `database.sqlite` e a pasta `uploads/` são criados automaticamente na primeira execução. Os arquivos anexados ficam em `uploads/`. Para encerrar o servidor, use `Ctrl+C` no terminal.

## Configurações opcionais

É possível alterar a porta e o local do banco por variáveis de ambiente:

```bash
PORT=3333 DB_FILE=/caminho/para/eurolatina.sqlite npm start
```

## API REST

| Método | Rota | Finalidade |
|---|---|---|
| GET | `/api/health` | Verificar se a API está ativa |
| GET | `/api/contas` | Listar contas; aceita filtros `busca`, `status`, `categoria`, `de` e `ate` |
| POST | `/api/contas` | Cadastrar conta |
| PUT | `/api/contas/:id` | Editar conta e/ou alterar status |
| DELETE | `/api/contas/:id` | Excluir conta e arquivo vinculado |
| POST | `/api/contas/:id/anexo` | Anexar ou substituir documento |
| GET | `/api/contas/:id/anexo` | Visualizar/baixar documento |
| DELETE | `/api/contas/:id/anexo` | Remover documento |

### Exemplo de cadastro

```json
{
  "fornecedor": "Aços e Metais Sorocaba Ltda.",
  "data_vencimento": "2026-12-10",
  "valor": 1850.5,
  "categoria": "Matéria-prima",
  "numero_documento": "NF 000123",
  "descricao": "Compra de barras de aço para produção."
}
```

### Anexos

São aceitos PDF, JPG, PNG, WEBP, DOC, DOCX, XLS e XLSX, com tamanho máximo de 8 MB por arquivo.

## Observações acadêmicas e de implantação

Este pacote é uma aplicação acadêmica/local, sem autenticação, perfis de acesso, trilha de auditoria ou integração bancária/fiscal. Antes de utilizar com dados financeiros reais em ambiente de produção, implemente autenticação e autorização, backups, HTTPS, política de retenção de documentos e auditoria das alterações.

O banco SQLite usado durante o desenvolvimento não é incluído no ZIP para evitar levar registros de teste. Ele será criado automaticamente ao iniciar o sistema. Caso você já tenha um `database.sqlite` com contas válidas, mantenha-o na raiz do projeto: o servidor adiciona os novos campos sem apagar os dados existentes.
