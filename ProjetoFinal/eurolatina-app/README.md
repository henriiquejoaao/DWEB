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
- SQLite local (`sqlite3`)
- Turso / libSQL (`@libsql/client`) para persistência em hospedagem serverless
- HTML5, CSS3 e JavaScript puro (`fetch`)

## Requisitos

- Node.js 20 ou superior.
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

O banco `database.sqlite` e a pasta `uploads/` são criados automaticamente na primeira execução. Nesta versão, os novos anexos são guardados como BLOB dentro do SQLite. O servidor ainda consegue ler anexos antigos que estejam em `uploads/`. Para encerrar o servidor, use `Ctrl+C` no terminal.


## Publicar no Vercel (com banco persistente)

O projeto está preparado para ser publicado no Vercel usando **Turso (SQLite hospedado)**. No ambiente Vercel, o backend exporta a aplicação Express como Function, os arquivos estáticos ficam em `public/` e o banco não é criado no disco temporário da Function.

> **Importante:** não publique usando apenas `database.sqlite` local. O sistema de arquivos das Functions não é um banco persistente. O Vercel precisa das duas variáveis abaixo para conectar ao Turso.

### 1. Criar e conectar o banco Turso

1. Crie uma conta em [Turso](https://turso.tech/) e crie um banco de dados SQLite.
2. Copie a URL do banco (formato `libsql://...`) e gere um token de autenticação.
3. No Vercel, abra o projeto e conecte a integração **Turso Cloud** pela Marketplace/Storage, ou cadastre manualmente as variáveis em **Settings → Environment Variables**.
4. Cadastre estas variáveis para os ambientes em que fará deploy (Production e Preview; Development se desejar):

   ```env
   TURSO_DATABASE_URL=libsql://seu-banco-sua-organizacao.turso.io
   TURSO_AUTH_TOKEN=seu-token-secreto
   ```

   Não coloque o token no código, no GitHub ou em arquivos públicos. O arquivo `.env.example` é apenas um modelo, sem credenciais reais.

### 2. Publicar o projeto

1. Envie para o GitHub o conteúdo da pasta `eurolatina-app` (o `package.json` precisa ficar na raiz do repositório) ou configure essa pasta como **Root Directory** no Vercel.
2. No Vercel, importe o repositório. O projeto usa Node.js 20 ou superior e Express; não precisa de comando de build nem de diretório de saída personalizado.
3. Confirme que `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` estão disponíveis para o ambiente do deploy.
4. Clique em **Deploy** ou faça um novo **Redeploy** depois de adicionar as variáveis.
5. Ao abrir o domínio, teste `https://seu-dominio.vercel.app/api/health`. A resposta esperada é um JSON com `"status":"ok"`.

A tabela `contas` e os índices são criados automaticamente no Turso na primeira inicialização. Novas contas e novos anexos ficam persistidos nesse banco remoto. O SQLite local continua sendo usado quando o projeto é iniciado com `npm start` sem as variáveis Turso.

### 2.1. Levar os dados do SQLite local para o Turso (opcional)

Se você já cadastrou contas no computador e quer levá-las para o banco remoto, antes do deploy:

1. Coloque o `database.sqlite` atual e a pasta `uploads/` na raiz do projeto.
2. Configure as variáveis no terminal, usando os valores do seu banco:

   ```bash
   export TURSO_DATABASE_URL="libsql://seu-banco-sua-organizacao.turso.io"
   export TURSO_AUTH_TOKEN="seu-token-secreto"
   ```

3. Execute `npm run migrate:turso`.

O script copia as contas e tenta migrar também os anexos antigos da pasta `uploads/`. Faça backup do banco remoto antes de repetir a operação: os registros com o mesmo ID no destino serão substituídos. O ZIP não contém seu banco local, então essa etapa só é necessária quando você já possui dados que deseja preservar.

### 3. Limite de anexos no Vercel

Os anexos têm limite de **3 MB** porque as Vercel Functions aceitam payloads de até 4,5 MB e o sistema envia os documentos codificados em base64. Para anexos maiores, seria necessário implementar upload direto para um serviço de armazenamento de objetos, como Vercel Blob.

### 4. Erros comuns

- **A página informa que uma Function falhou:** abra **Deployments → último deploy → Functions/Runtime Logs** e confira o erro registrado.
- **A API retorna 503 informando variáveis Turso:** cadastre `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` no ambiente correto e faça Redeploy.
- **A API retorna erro de autenticação ou conexão:** confira se a URL e o token pertencem ao mesmo banco Turso e se não há espaços extras.
- **A URL principal não mostra a interface:** confirme que `public/index.html` está no projeto e que `eurolatina-app` (ou a pasta que contém `package.json`) está configurada como Root Directory.

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

São aceitos PDF, JPG, PNG, WEBP, DOC, DOCX, XLS e XLSX, com tamanho máximo de 3 MB por arquivo. Esse limite mantém os uploads compatíveis com o limite de payload das Vercel Functions.

## Observações acadêmicas e de implantação

Este pacote é uma aplicação acadêmica/local, sem autenticação, perfis de acesso, trilha de auditoria ou integração bancária/fiscal. Antes de utilizar com dados financeiros reais em ambiente de produção, implemente autenticação e autorização, backups, HTTPS, política de retenção de documentos e auditoria das alterações.

O banco SQLite usado durante o desenvolvimento não é incluído no ZIP para evitar levar registros de teste. Ele será criado automaticamente ao iniciar o sistema. Caso você já tenha um `database.sqlite` com contas válidas, mantenha-o na raiz do projeto: o servidor adiciona os novos campos sem apagar os dados existentes.
