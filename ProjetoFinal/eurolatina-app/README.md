# EUROLATINA — Gestão Financeira (cloud-only)

**Versão 2.1.1** — correção na normalização de linhas retornadas pelo Turso e diagnóstico de quantidade de usuários no status de autenticação.

Sistema web da **Metalúrgica Usinagem EUROLATINA**, com Dashboard, Agenda mensal, contas a pagar e a receber, autenticação, controle de acesso por perfil e trilha de auditoria.

## Arquitetura

- **Frontend:** HTML5, CSS3 e JavaScript, servido pelo Express.
- **Backend:** Node.js 20+ e Express, publicado como Vercel Function.
- **Banco de dados:** Turso Cloud (libSQL remoto), obrigatório em produção e desenvolvimento.
- **Documentos:** conteúdo armazenado como BLOB no Turso; não são gravados em diretórios locais.
- **Hospedagem:** Vercel.

O servidor não usa SQLite local como base operacional e não possui fallback para disco temporário. O utilitário opcional `migrate:turso` usa SQLite somente para importar lançamentos de versões antigas.

## Tipos de conta

Cada lançamento possui `tipo`:

- `pagar`: obrigação com fornecedor, prestador, empregado, tributo ou outra despesa.
- `receber`: valor esperado de cliente ou outro pagador.

A Agenda permite filtrar por tipo e visualizar os dois fluxos no mesmo calendário. O Dashboard separa valores em aberto e vencidos a pagar e a receber. Contas antigas sem o campo `tipo` são migradas automaticamente como `pagar`.

A coluna legada `fornecedor` é usada internamente para armazenar o nome da contraparte: fornecedor/prestador em contas a pagar ou cliente/pagador em contas a receber.

## Conectar ao Turso no Vercel

O projeto precisa receber estas duas variáveis no ambiente **Production** do Vercel (e também Preview/Development, caso usados):

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Conecte o banco Turso ao projeto usando o [Turso Cloud Marketplace](https://vercel.com/marketplace/tursocloud/database). Depois confira os nomes em **Settings → Environment Variables** e faça um novo deploy. Os valores devem vir da integração ou do painel Turso; nunca os coloque no código, no Git ou em mensagens.

O endpoint `GET /api/auth/status` informa `totalUsuarios` (somente a contagem, sem dados pessoais), além de indicar `setupRequired`. Isso facilita identificar se o servidor está lendo o cadastro de usuários esperado. O endpoint `GET /api/health` diferencia credenciais presentes (`configurado`) de conexão realmente estabelecida (`conectado`). Falhas transitórias de rede durante a inicialização recebem até três retentativas (quatro tentativas no total); se todas falharem, uma requisição posterior poderá tentar inicializar novamente, sem deixar o erro preso na instância serverless:

```json
{
  "status": "ok",
  "aplicacao": "EUROLATINA - Gestão Financeira",
  "banco": "Turso Cloud",
  "configurado": true,
  "conectado": true,
  "persistencia": "remota"
}
```

Se responder HTTP 503, verifique `configurado`, `etapa` e `codigo`, e consulte **Deployments → Runtime Logs** no Vercel. `configurado: true` com `conectado: false` significa que as duas variáveis estão presentes, mas o servidor não conseguiu concluir a conexão/inicialização remota.

## Primeiro administrador

Antes do primeiro acesso, defina a variável `INITIAL_ADMIN_SETUP_TOKEN` no ambiente Production do Vercel. Gere um valor forte, por exemplo com:

```bash
openssl rand -hex 32
```

Faça um novo deploy. Na tela inicial do sistema, informe esse token, o nome, e-mail e uma senha de pelo menos 12 caracteres para criar o primeiro administrador. O cadastro inicial só é permitido quando ainda não existe nenhum usuário.

Depois de criar o primeiro administrador, remova `INITIAL_ADMIN_SETUP_TOKEN` das variáveis do Vercel e faça outro deploy. O primeiro administrador poderá cadastrar os demais usuários na tela **Administração**.

## Perfis e segurança

- **Administrador (`admin`):** acesso total, gerenciamento de usuários, perfis e consulta da auditoria.
- **Financeiro (`financeiro`):** consulta e manutenção de contas, pagamentos/recebimentos e documentos.
- **Consulta (`consulta`):** leitura dos lançamentos; não pode criar, alterar, excluir nem acessar documentos.

As permissões são verificadas no backend em todas as rotas. A aplicação usa senha derivada com scrypt, sessões com token aleatório armazenado como hash no banco, cookie `HttpOnly`/`SameSite=Strict` (e `Secure` em produção), expiração de 8 horas e bloqueio temporário após tentativas repetidas de login.

A trilha de auditoria registra logins bem-sucedidos e falhos, criação/alteração/exclusão de contas, pagamentos, recebimentos, alterações de usuários, operações de documentos e tentativas de acesso negadas. O upload, download e remoção de documentos exigem perfil `admin` ou `financeiro`; downloads e tentativas sem permissão são registrados. Não há rota pública para os arquivos.

**Não foi incluída funcionalidade de backup ou recuperação**, conforme definido para este escopo.

## Instalação e execução local

A execução local também usa o Turso remoto; assim, o ambiente local e o publicado consultam a mesma base quando configurados com as mesmas credenciais.

```bash
npm install
cp .env.example .env.local
```

Preencha `.env.local` com `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` e, no primeiro provisionamento, `INITIAL_ADMIN_SETUP_TOKEN`.

Confira a conexão e inicie:

```bash
npm run check:cloud
npm test
npm start
```

Acesse `http://localhost:3000`. O arquivo `.env.local` é ignorado pelo Git e não deve ser compartilhado.

## Importar dados de uma versão SQLite anterior (opcional)

Se houver um `database.sqlite` antigo, o utilitário de migração pode importar as contas para o Turso. Ele não faz parte do funcionamento normal do sistema. O utilitário:

1. Lê o arquivo SQLite antigo em modo somente leitura.
2. Copia lançamentos, tipos (quando presentes) e anexos localizados em `uploads/`.
3. Define contas antigas sem tipo como `pagar`.

Coloque o banco antigo e, se aplicável, a pasta `uploads/` na raiz do projeto, configure `.env.local` e execute:

```bash
npm run migrate:turso
```

Revise os dados no Turso antes de usar a base importada em produção. O script usa a dependência `sqlite3` apenas durante a importação.

## Testes

```bash
npm test
```

Os testes de interface e de configuração cloud-only não precisam de credenciais remotas. O teste de integração HTTP com autenticação usa uma base Turso separada de testes; configure `TURSO_TEST_DATABASE_URL` e `TURSO_TEST_AUTH_TOKEN` no ambiente para executá-lo. Não use a base de produção para testes automatizados.

## Rotas principais da API

| Método | Rota | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/health` | Público | Estado da conexão com Turso |
| GET | `/api/auth/status` | Público | Verifica se o provisionamento inicial é necessário |
| POST | `/api/auth/setup` | Token inicial | Cria o primeiro administrador |
| POST | `/api/auth/login` | Público | Autentica o usuário |
| POST | `/api/auth/logout` | Sessão | Encerra a sessão |
| GET | `/api/contas?tipo=pagar` | Usuário autenticado | Lista contas (filtro `tipo`: `pagar`, `receber` ou `todos`) |
| POST | `/api/contas` | Admin/Financeiro | Cria conta |
| PUT | `/api/contas/:id` | Admin/Financeiro | Edita conta e registra pagamento/recebimento |
| DELETE | `/api/contas/:id` | Admin/Financeiro | Exclui conta |
| POST/GET/DELETE | `/api/contas/:id/anexo` | Admin/Financeiro | Envia, acessa ou remove documentos |
| GET/POST/PATCH | `/api/admin/users` | Admin | Gerencia usuários e perfis |
| GET | `/api/admin/audit` | Admin | Consulta a trilha de auditoria |

## Observações

O sistema não integra diretamente com bancos, emissão fiscal ou gateways de pagamento. Pagamentos e recebimentos são marcados manualmente por usuários autorizados. Antes do uso operacional com dados reais, a empresa deve validar os requisitos jurídicos, contábeis e de segurança da sua política interna.


## Versão 2.1.2 — correção de interatividade e ícones

- Todos os cliques da interface agora usam delegação de eventos (`data-action`) em vez de atributos `onclick`/`onsubmit`.
- Compatibilidade com `script-src-attr 'none'` do Helmet: a política CSP continua bloqueando JavaScript inline em atributos HTML.
- Formulário de contas conectado via `addEventListener('submit', ...)`.
- Ícone de “A receber em aberto” substituído por `fa-hand-holding-dollar`, ícone Free da família Solid do Font Awesome 6.
- Nenhuma alteração no schema de dados, nos usuários, nas sessões ou no banco Turso é necessária.
