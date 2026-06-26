# Sushi House Banff — Project Recovery Summary

> Gerado em: 26 de junho de 2026
> Status: somente leitura — não modificar código

---

## 1. Autenticação de Admin

### Login
- Componente `LoginView` em `/admin`
- Campos: email + senha
- Logo da empresa, texto "Sign in to access the admin panel."
- Botão vermelho "Sign in"
- Token armazenado em `localStorage` como `restaurant-admin-token` (Bearer auth)

### Logout
- Link "Sign out" no rodapé da sidebar
- Limpa o token e redireciona para a tela de login

### Múltiplos usuários admin
- Tabela `admin_users` com campos: `id`, `email`, `name`, `password_hash` (bcrypt), `role` (`super_admin` / `admin`), `is_active`, `created_at`
- O nome do admin logado aparece na barra de boas-vindas

### Script de configuração inicial
- Arquivo: `setup-admin.js`
- Cria o usuário `dudakrystinecg@gmail.com` / senha `admin123` como `super_admin`
- Executar uma vez com: `node setup-admin.js`
- Um segundo admin (`atotanaka11@gmail.com`) foi adicionado pela interface de Configurações

### Sessão
- Tabela `admin_sessions`
- Middleware `requireAdminAuth` injeta `email`, `name`, `role`, `adminUserId` em `req.adminSession`

---

## 2. Páginas do Admin

### Team / Employees (Equipe)
- Tabela com: nome, badge de status (Ativo/Inativo), taxa horária, frequência de pagamento, data de início, badge de ProServe
- Filtro de busca por nome
- Botão "+ New employee" abre formulário inline
- Clique em qualquer linha expande o formulário de edição
- Strip de métricas: headcount ativo, ProServe vencido, vencendo em 30 dias, novos no mês

### Clock / Time Records (Relógio)
- 4 cards de métricas: Currently Working (card escuro com ponto verde ao vivo), Open check-ins (âmbar), Evento mais recente, Progresso do período atual
- 6 estatísticas: Funcionários no período, Registros, Total de horas, Horas prontas para folha, Turnos completos, Turnos abertos
- Painel "Add clock record": funcionário, tipo (check-in/out), data/hora, kiosk ID opcional
- Painel "Add manual hours": funcionário, data, horas regulares, horas de feriado (Family Day)
- Filtros: funcionário, intervalo de datas, status, botão "Open only", limpar, Export CSV
- Tabela de resumo por funcionário
- Tabela completa de registros de tempo

### Payroll (Folha de Pagamento)
- Regras de negócio exibidas: overtime (>8h/dia a 1.5x), holiday pay, férias (0% < 1 ano / 4% após 1 ano / 6% após 5 anos), jurisdição CA/AB 2026
- Formulário de geração: datas, data de pagamento, label de taxa, referência de pagamento, override de taxa horária, frequência
- Botão "Generate payroll"
- Lista de períodos gerados com status (approved/pending), horas, bruto, total
- Clique no período → detalhes: datas, status, frequência, data de pagamento, bruto, total, férias pagas, férias acumuladas, CPP empregador, EI empregador
- Por funcionário: bruto, total, imposto, CPP, EI, salário líquido. Botões: "View payroll details", "View payslip", "Print"
- Botões: Export Excel, Print team package, Recalculate approved payroll

### Pay & Send (Envio de Contracheques)
- Seletor de período (apenas aprovados)
- Tabela: checkbox, funcionário (nome + email + taxa), horas, bruto, salário líquido, número de cheque, status, ações
- Entrada de cheque: exibe "No. [valor] / Edit" quando confirmado, ou campo editável + "Confirm"
- **Save all**: salva cheques, define status `ready` (com cheque) ou `pending` (sem). **Nunca rebaixa status `sent`**
- Badges de status: **Pending** (texto suave), **Ready** (âmbar), **Sent** (verde)
- Botão "Send" individual por linha (visível apenas quando `status !== "sent"` e funcionário tem email)
- Botão "Send selected (N)" (desativado quando N=0)
- **Modal de confirmação**: overlay com blur, card por funcionário com nome / email / período / número de cheque. Se cheque faltando: aviso em vermelho "Cheque number missing — send anyway?". Botões Cancel e Send. Clicar no overlay também cancela
- Após envio: status → "Sent", botão "Send" desaparece
- BCC automático: email do admin logado adicionado em cópia oculta
- Export Excel disponível

### Messages (Mensagens)
- Seleção múltipla de funcionários (apenas com email cadastrado e ativos)
- Campos: assunto e corpo da mensagem
- Toggle "BCC self" (ativado por padrão)
- Rascunho salvo automaticamente em `localStorage`
- Botão de envio com estado de carregamento
- Painel de histórico de envios

### Audit Log (Log de Auditoria)
- 3 abas: **Employees**, **Time Records**, **Payroll**
- Toggle: "Newest events first" / "Oldest first"
- Filtros: funcionário, texto da ação, intervalo de datas
- Export CSV
- Tabela: Quando, Funcionário, Ação, Admin, Detalhes
- Coluna Detalhes renderiza componente `AuditDiff` com campos alterados em layout estilizado

### Settings (Configurações)
- **My Account**: avatar com inicial, nome, email. Botão "Edit account" (atualiza nome, email, senha)
- **Admin Users**: tabela de todos os admins — nome, email, badge Ativo/Inativo, data de criação, ações: Reset pw / Deactivate / Reactivate. Botão "+ Add admin"
- **Email Configuration**: endereço de envio (`Sushi House Banff <payroll@mail.sushihousebanff.ca>`), status da `RESEND_API_KEY`, botão "Send test email"

---

## 3. Campos do Funcionário

Todos armazenados na tabela `employees` via migrações `ensureColumnExists` (apenas aditivas — nunca destrutivas).

### Campos originais (folha de pagamento)
| Campo | Descrição |
|-------|-----------|
| `name` | Nome completo |
| `pin` | PIN de acesso ao kiosk |
| `pay_type` | `hourly` ou `salaried` |
| `hourly_rate` | Taxa horária |
| `pay_frequency` | `monthly` / `biweekly` / `weekly` |
| `start_date` | Data de início |
| `vacation_pay_schedule` | `monthly_payout` ou `accrued_balance` |
| `status` | `active` / `inactive` |

### Campos adicionados
| Campo | Descrição |
|-------|-----------|
| `phone` | Telefone |
| `email` | Email do funcionário |
| `sin` | Número de Seguro Social (SIN) |
| `home_address` | Endereço residencial |
| `hire_date` | Data de contratação |
| `proserve_number` | Número de certificação ProServe |
| `proserve_expiry` | Data de vencimento do ProServe |
| `roe_last_day` | Último dia de trabalho (ROE) |
| `roe_hours` | Horas inseguráveis (ROE) |
| `roe_wage` | Salário de referência (ROE) |
| `benefits_note` | Notas de benefícios (aparece no contracheque) |

### Status do ProServe
Calculado pela função `proserveStatus(expiry)`:
- `"expired"` — já venceu
- `"expiring"` — vence em ≤60 dias
- `"ok"` — válido
- `null` — sem data cadastrada

### Seções do formulário de funcionário
1. Payroll Settings
2. Personal Information
3. ProServe Certification
4. Record of Employment (ROE)
5. Benefits & Notes

---

## 4. Contracheque / Earning Statement

Renderizado por `buildPayslipPrintHtml(payslip)` (para impressão) e componente React `PayslipPreview` (inline via `payslip-sheet`).

### Conteúdo
- Logo da empresa (`/logo.png`)
- Endereço completo: "304 Caribou Street, P.O. Box 1985, Banff, Alberta, Canada T1L 1B7"
- Subtítulo "Employee Earnings Statement"
- Nome do funcionário, período (início–fim), **total de horas** (em hrs), label da taxa, data de pagamento, referência de pagamento (número do cheque)
- Tabela de ganhos detalhada: Regular Earnings, Vacation Pay (com nota do tier), entradas de feriados/Family Day, dedução de CPP, dedução de EI, Imposto, **Salário Líquido**
- Regras de férias no rodapé
- Nota de benefícios (do registro do funcionário)
- Botões Print e Close no modo preview

### Versão PDF
- Gerada no servidor via `htmlToPdf()` (Puppeteer)
- Anexada ao email Resend como arquivo `.pdf` com nome: `payslip_[Nome]_[início]_[fim].pdf`

---

## 5. Pay & Send — Fluxo Completo

### Ciclo de vida do status
```
(sem cheque)     →  Pending
(cheque salvo)   →  Ready
(email enviado)  →  Sent
```

### Comportamento do Save all
- Move Pending → Ready (se cheque presente)
- Move Ready → Pending (se cheque removido)
- **Nunca muda o status de linhas "Sent"** (proteção adicionada no PATCH payload)

### Envio individual
1. Clique em "Send" → modal de confirmação
2. Modal mostra: nome, email, período, número do cheque (ou aviso em vermelho se ausente)
3. Confirmar → `POST /api/admin/payrolls/:id/items/:itemId/send`
4. Backend: gera PDF, envia via Resend, BCC para admin logado, marca como "sent" no DB

### Envio em lote
1. Selecionar linhas com checkbox
2. Clique em "Send selected (N)" → mesmo modal listando todos os selecionados
3. Confirmar → envia em sequência

### Colunas do DB em `payroll_items`
- `payment_reference` — número do cheque
- `send_status` — `pending` / `ready` / `sent`
- `sent_at` — timestamp do envio

---

## 6. UI / Design System

### Paleta de cores
| Variável | Valor | Uso |
|----------|-------|-----|
| `--c-red` | `#CC2020` | Cor primária, botões, data |
| `--c-wood` | `#C8A870` | Gradiente sidebar, detalhes |
| `--c-bg` | `#EEECEA` | Background geral |
| `--c-text-primary` | `#1A0808` | Texto principal |
| `--c-text-muted` | `#8A8078` | Texto secundário |
| `--c-jade` | `#2E7D52` | Sucesso, badge Sent |
| `--c-amber` | `#C07020` | Aviso, badge Ready |

### Glass morphism
```css
background: rgba(255, 255, 255, 0.60);
backdrop-filter: blur(20px);
border-radius: 16px;
```

### Sidebar
```css
background: linear-gradient(160deg, #1A0808 0%, #3A0C0C 35%, #6A1010 65%, #C8A870 100%);
```

### Ícones da sidebar (lucide-react v1.21.0, tamanho 20, strokeWidth 1.8)
| Página | Ícone |
|--------|-------|
| Team | `UsersRound` |
| Clock | `Clock` |
| Payroll | `StickyNote` |
| Pay & Send | `SendHorizontal` |
| Messages | `Mail` |
| Audit Log | `History` |
| Settings | `Settings2` |

### Barra de boas-vindas (Welcome bar)
- "Welcome, [Primeiro Nome]" · data em vermelho (dia da semana, dia, mês, ano) · label do período de pagamento · ponto verde "Live" · hora em formato 24h
- Atualiza a cada 60 segundos

### Blobs de fundo
- 5 divs fixos com `border-radius: 50%; filter: blur(65px)`
- Tons de vermelho e dourado (wood)
- `z-index: 0; pointer-events: none`

### Fonte
- Nunito (Google Fonts CDN em `index.html`)
- Aplicada via `body, .ds-shell { font-family: 'Nunito', ... }`

### Hash persistence (persistência de navegação)
- `useEffect` no mount lê `window.location.hash` e define `activeSection`
- Segundo `useEffect` escreve o hash a cada mudança de seção
- Seções válidas: `employees`, `time-records`, `payroll`, `audit-logs`, `payroll-review`, `messages`, `settings`
- Funciona após refresh de página ✅

### Timezone
- Constante `TZ = "America/Edmonton"`
- Usada em todos os `toLocaleDateString` / `toLocaleTimeString`

---

## 7. Kiosk

- Servido como app React estático em `localhost:3001/`
- Exibe: clima (Banff, Canada), relógio (formato 12h), data, logo, silhueta de montanha
- Fluxo: seleção de funcionário → entrada de PIN → ação (check-in/check-out)
- 3 funcionários ativos: HOSHINO KONYA, KAZUHITO KONYA, KEITH ARRANGUEZ
- **Botão "Admin"** no canto inferior direito → navega para `/admin#employees`
- **Link "← Kiosk"** na sidebar do admin → navega para `/` (kiosk)
- Código do kiosk (`App.js` / `App.css`) não deve ser modificado

---

## 8. Avisos Conhecidos e Melhorias Futuras

### Warnings ESLint pré-existentes (não são novos)
Todos em `AdminView.js`:
- Linha 134: `formatTimeRecordType` definida mas nunca usada
- Linha 543: `FormSection` definida mas nunca usada
- Linhas 1608–1611: `expandedEmployeeDetails`, `setExpandedEmployeeDetails`, `showClockForm`, `setShowClockForm`, `showManualForm`, `setShowManualForm`, `employeeSearchQuery`, `setEmployeeSearchQuery` — atribuídas mas nunca usadas (resquícios de refatoração)
- Linha 1832: `react-hooks/exhaustive-deps` — `openOnly` faltando nas deps do `useCallback`

### Itens opcionais de polish (não são bugs)
- O preview do contracheque é renderizado inline abaixo dos detalhes de folha de pagamento, não como modal flutuante — funcional mas requer rolagem
- O componente `AuditDiff` mostra "+N more fields" mas não há expansão para ver todos os campos alterados
- `confirmedCheques` no estado local não é sincronizado após `Save all` — um cheque digitado mas não clicado em "Confirm" não mostra "No. X Edit" até recarregar a página
- Tabela `admin_sessions` cresce indefinidamente (sem limpeza ou expiração automática)

---

## Arquivos Principais

| Arquivo | Função |
|---------|--------|
| `server.js` | Backend Express, todas as rotas `/api/admin/*`, middleware de auth, endpoint de envio de email |
| `db.js` | Schema SQLite, todas as funções de DB, migrações `ensureColumnExists` |
| `kiosk/src/AdminView.js` | SPA React do admin completo (~4700+ linhas) |
| `kiosk/src/AdminView.css` | CSS do design system completo (~2130+ linhas) |
| `kiosk/public/index.html` | Fonte Nunito, favicon, título da página |
| `kiosk/src/App.js` | App React do kiosk (não modificar) |
| `kiosk/src/App.css` | Estilos do kiosk (não modificar) |
| `services/emailService.js` | Cliente Resend, geração de PDF, `sendPayrollEmail`, `sendStaffMessage` |
| `setup-admin.js` | Script de seed do admin (executar uma vez) |
| `.env` | `RESEND_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (não commitado) |
| `package.json` | Dependências do backend |
| `kiosk/package.json` | Dependências do frontend React |

---

## Como Iniciar Localmente

```bash
# 1. Instalar dependências (raiz)
npm install

# 2. Criar usuário admin (apenas na primeira vez)
node setup-admin.js

# 3. Iniciar o servidor
node server.js
# → http://localhost:3001/        (kiosk)
# → http://localhost:3001/admin   (painel admin)
```

---

## Como Fazer o Build

Após qualquer alteração em `AdminView.js` ou `AdminView.css`:

```bash
cd kiosk
npm run build
# Depois, hard-reload no navegador: Ctrl+Shift+R
```

---

## O Que NÃO Deve Ser Alterado Sem Cuidado

| Área | Risco |
|------|-------|
| Lógica de cálculo de folha em `db.js` (`calculatePayroll`, fórmulas de overtime/vacation/CPP/EI) | Corrompe os valores gerados na folha de pagamento |
| Schema da tabela `payroll_items` (colunas existentes) | Pode quebrar geração de folha ou exportação |
| `kiosk/src/App.js` e `App.css` | Fluxo de check-in dos funcionários; apenas o botão "Admin" foi adicionado intencionalmente |
| `markPayrollItemSent` em `db.js` | Chamado após o envio do email; alterações podem dessincronizar o estado de envio |
| `buildPayslipHtml` em `emailService.js` | Usado para geração de PDF; mudanças de layout quebram o contracheque impresso |
| Fluxo de autenticação Bearer (`requireAdminAuth`) | Todas as rotas de API do admin dependem disso |
| Constante `TZ = "America/Edmonton"` | Todos os displays de data/hora e cálculos de período usam esse timezone |
| Constantes `COMPANY_NAME` / `COMPANY_ADDRESS` | Aparecem nos contracheques enviados aos funcionários |
