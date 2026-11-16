# EUROLATINA — Contas a Pagar (cloud-only)

Sistema web de Contas a Pagar da **Metalúrgica Usinagem EUROLATINA**, com duas telas: Dashboard financeiro e Agenda mensal.

## Arquitetura de produção

A aplicação foi configurada para usar **exclusivamente o Turso Cloud (libSQL remoto)** como banco de dados, tanto quando publicada no Vercel quanto quando executada localmente para desenvolvimento.

- **Frontend:** HTML5, CSS3 e JavaScript, servido pelo Express.
- **Backend:** Node.js + Express, implantado como Vercel Function.
- **Banco de dados:** Turso Cloud.
- **Documentos anexados:** conteúdo binário armazenado no próprio banco Turso.
- **Hospedagem:** Vercel.

Não existe fallback para `database.sqlite`, nem gravação de anexos em `uploads/`. O computador do usuário não precisa ficar ligado para que o sistema publicado funcione. O pacote não contém credenciais nem cria automaticamente uma conta/banco na sua organização Turso: é necessário conectar um recurso Turso ao projeto Vercel uma única vez.

## Importante: corrigir a mensagem de configuração

A mensagem `Configure TURSO_DATABASE_URL e TURSO_AUTH_TOKEN...` indica que o projeto Vercel ainda não está recebendo as credenciais do banco remoto. O código não pode gerar essas credenciais por conta própria.

### 1. Criar e conectar o banco Turso ao Vercel

1. Entre no [Vercel](https://vercel.com/) e abra o projeto da EUROLATINA.
2. Abra a área **Storage** ou **Marketplace / Integrations** do projeto.
3. Escolha **Turso** / **Turso Cloud** e crie ou conecte um banco de dados.
4. Durante a conexão, mantenha os nomes padrão das variáveis, sem prefixo personalizado. A integração deve disponibilizar exatamente:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
5. Abra **Settings → Environment Variables** e confira se as duas variáveis estão disponíveis para **Production**. Marque Preview e Development também se pretende usar esses ambientes.
6. Não cole o token no código, no GitHub, em mensagens ou no arquivo `.env.example`.

Atalho oficial: [Turso Cloud no Vercel Marketplace](https://vercel.com/marketplace/tursocloud/database).

> Se você já adicionou manualmente as variáveis, confira se os nomes estão escritos exatamente como acima e se os valores são do mesmo banco Turso. Não use valores de exemplo.

### 2. Fazer um novo deploy

Depois de conectar o Turso ou alterar as variáveis:

1. Abra **Deployments** no Vercel.
2. Faça **Redeploy** da versão mais recente, ou envie um novo commit pelo GitHub.
3. Aguarde o deploy terminar e abra o domínio de produção.

Alterações nas variáveis de ambiente só entram em vigor em novos deploys; um deploy antigo não passa a usar as novas variáveis automaticamente.

### 3. Confirmar a conexão

Abra no navegador:

```text
https://SEU-DOMINIO.vercel.app/api/health
```

Quando estiver conectado, a resposta deve conter:

```json
{
  "status": "ok",
  "aplicacao": "EUROLATINA - Contas a Pagar",
  "banco": "Turso Cloud",
  "persistencia": "remota"
}
```

Se retornar HTTP 503, o JSON informa se as variáveis estão ausentes ou se houve falha de conexão/autenticação. Consulte também **Deployments → Runtime Logs** no Vercel.

## Publicação no Vercel

1. Extraia o ZIP e envie o conteúdo da pasta `eurolatina-app` para a raiz do repositório GitHub. O arquivo `package.json` e `server.js` devem ficar na raiz do repositório.
2. Se preferir manter a pasta `eurolatina-app` dentro do repositório, configure-a como **Root Directory** nas configurações do projeto Vercel.
3. Importe/conecte o repositório no Vercel. A plataforma detecta a aplicação Express pelo `server.js` exportado; não é necessário definir uma pasta de saída estática.
4. Conecte o Turso conforme a seção anterior e faça o deploy.

## Desenvolvimento local usando o mesmo banco remoto

O modo local também utiliza Turso. Assim, os dados visualizados no computador e no site publicado são os mesmos, desde que apontem para a mesma base remota.

1. Instale Node.js 20 ou superior.
2. Instale as dependências:

   ```bash
   npm install
   ```

3. Copie `.env.example` para `.env.local` e preencha com as credenciais do Turso obtidas no painel/integração:

   ```bash
   cp .env.example .env.local
   ```

4. Verifique a conexão sem revelar o token:

   ```bash
   npm run check:cloud
   ```

5. Inicie a aplicação:

   ```bash
   npm start
   ```

6. Acesse `http://localhost:3000`.

O arquivo `.env.local` é ignorado pelo Git. Nunca compartilhe esse arquivo. Para puxar as variáveis do projeto Vercel para o computador, também é possível usar o Vercel CLI após vincular o diretório ao projeto: `vercel link` e `vercel env pull .env.local`.

## Migração de dados antigos (opcional)

A aplicação em execução não lê SQLite local. Se você possui um `database.sqlite` de uma versão antiga e deseja preservar suas contas, use o script de migração uma única vez:

1. Faça uma cópia de segurança do banco SQLite e da pasta `uploads/` antigos.
2. Coloque `database.sqlite` e a pasta `uploads/` antiga na raiz desta pasta do projeto.
3. Preencha `.env.local` com as credenciais do banco Turso de destino.
4. Execute:

   ```bash
   npm install
   npm run migrate:turso
   ```

5. Confira os registros no Turso e no site publicado antes de remover os arquivos legados.

O SQLite e a dependência `sqlite3` são usados **somente pelo utilitário de migração**. O servidor `server.js` não importa `sqlite3`, não cria banco local e não usa arquivos locais para armazenar dados.

## Testes

```bash
npm test
```

Os testes de interface e de configuração cloud-only rodam sem credenciais remotas. O teste de integração CRUD pode ser habilitado com uma base Turso exclusiva para testes, definindo `TURSO_TEST_DATABASE_URL` e `TURSO_TEST_AUTH_TOKEN` no ambiente. Não use o banco de produção para testes automatizados.

## Funcionalidades

- Dashboard consolidado com indicadores de contas a pagar.
- Agenda financeira mensal com navegação entre meses e seleção de dias.
- Cadastro, edição, exclusão e liquidação/reabertura de contas.
- Registro da data de criação e liquidação.
- Filtros e pesquisa por fornecedor, status, categoria e período.
- Anexos PDF, JPG, PNG, WEBP, DOC, DOCX, XLS e XLSX, até 3 MB.
- Migração automática de campos antigos na tabela remota `contas`.

## Rotas da API

| Método | Rota | Finalidade |
|---|---|---|
| GET | `/api/health` | Estado da conexão com o Turso Cloud |
| GET | `/api/contas` | Listar contas; aceita `busca`, `status`, `categoria`, `de` e `ate` |
| POST | `/api/contas` | Cadastrar conta |
| PUT | `/api/contas/:id` | Editar conta e/ou alterar status |
| DELETE | `/api/contas/:id` | Excluir conta e seu anexo |
| POST | `/api/contas/:id/anexo` | Anexar ou substituir documento no Turso |
| GET | `/api/contas/:id/anexo` | Visualizar/baixar documento do Turso |
| DELETE | `/api/contas/:id/anexo` | Remover documento do Turso |

## Observações de segurança

Este pacote acadêmico ainda não implementa autenticação, perfis/permissões, trilha de auditoria ou integração bancária/fiscal. Antes de armazenar dados financeiros reais em produção, adicione login e autorização, política de backup/recuperação, auditoria e controles de acesso aos documentos.
