# Restaurant System

Sistema de controle de ponto e payroll para restaurante, com:
- backend Node.js + Express
- frontend React
- SQLite como persistencia
- quiosque em `/`
- admin em `/admin`

O sistema ja esta preparado para:
- historico e auditoria
- payroll com Alberta / Canada / 2026
- sessao admin persistida
- frontend buildado servido pelo backend em producao

## O que ja esta pronto para deploy

- backend serve API e frontend no mesmo processo
- `NODE_ENV=production` ja muda o comportamento do servidor
- `ADMIN_PASSWORD_HASH` e obrigatorio em producao
- sessoes admin e tentativas de login ficam persistidas no SQLite
- `/` e `/admin` funcionam por proxy reverso
- build do frontend pode ser gerado com um comando unico

## Riscos e pontos de atencao atuais

- SQLite funciona bem para piloto ou operacao pequena, mas exige cuidado com backup e disco
- o deploy recomendado continua sendo uma unica instancia PM2
- ainda nao ha limpeza automatica de auditoria
- ainda nao ha observabilidade completa, monitoramento e alerta

## Pre-requisitos

Desenvolvimento:
- Node.js 20+
- npm

VPS / producao:
- Node.js 20+
- npm
- PM2
- Nginx
- Certbot
- sqlite3

## Variaveis de ambiente

Arquivo de referencia:
- [.env.example](/C:/Users/HP/Desktop/restaurant-system/.env.example)

Obrigatorias em producao:
- `NODE_ENV=production`
- `ADMIN_PASSWORD_HASH`

Principais variaveis:
- `PORT`
- `FRONTEND_ORIGIN`
- `DATABASE_PATH`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_TTL_MS`
- `ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS`
- `ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS`
- `AUDIT_LOG_RETENTION_DAYS`

Observacoes:
- em desenvolvimento, existe fallback para `admin / admin123`
- em producao, o servidor falha no boot se `ADMIN_PASSWORD_HASH` nao estiver configurado
- nao coloque credenciais reais no repositório

## Desenvolvimento

Backend:

```powershell
cd C:\Users\HP\Desktop\restaurant-system
npm start
```

Frontend:

```powershell
cd C:\Users\HP\Desktop\restaurant-system\kiosk
npm start
```

## Rodar localmente em production

1. Gere o build:

```powershell
cd C:\Users\HP\Desktop\restaurant-system
npm run build
```

2. Gere o hash admin:

```powershell
cd C:\Users\HP\Desktop\restaurant-system
npm run hash:admin -- "SENHA_FORTE_AQUI"
```

3. Suba em modo production:

```powershell
cd C:\Users\HP\Desktop\restaurant-system
$env:NODE_ENV='production'
$env:PORT='3001'
$env:FRONTEND_ORIGIN='https://restaurant-system.example.com'
$env:DATABASE_PATH='C:\caminho\restaurant-system.db'
$env:ADMIN_USERNAME='admin'
$env:ADMIN_PASSWORD_HASH='HASH_GERADO_AQUI'
npm start
```

## Build e start

Build do frontend:

```bash
npm run build
```

Gerar hash admin:

```bash
npm run hash:admin -- "SENHA_FORTE_AQUI"
```

Start simples:

```bash
npm start
```

Start via PM2:

```bash
npm run pm2:start
```

## PM2

Arquivo pronto:
- [ecosystem.config.js](/C:/Users/HP/Desktop/restaurant-system/ecosystem.config.js)

Ele inclui:
- nome do processo: `restaurant-system`
- restart automatico
- `cwd` correto
- logs em `/var/log/restaurant-system`
- ambiente `production`

Uso basico:

```bash
pm2 start ecosystem.config.js --env production
pm2 status
pm2 logs restaurant-system
pm2 restart restaurant-system
pm2 save
pm2 startup
```

Importante:
- configure `ADMIN_PASSWORD_HASH` e outras variaveis no shell ou no ambiente do serviço antes do `pm2 start`
- mantenha apenas 1 instancia por causa do SQLite

## Nginx

Arquivo exemplo:
- [restaurant-system.example.conf](/C:/Users/HP/Desktop/restaurant-system/deploy/nginx/restaurant-system.example.conf)

Ele faz:
- proxy reverso para `127.0.0.1:3001`
- suporte a `/`, `/admin` e `/api/*`
- headers basicos
- base pronta para HTTPS

Fluxo:

```bash
sudo cp deploy/nginx/restaurant-system.example.conf /etc/nginx/sites-available/restaurant-system
sudo ln -s /etc/nginx/sites-available/restaurant-system /etc/nginx/sites-enabled/restaurant-system
sudo nginx -t
sudo systemctl reload nginx
```

## Cloudflare Tunnel

Se voce usar Cloudflare Tunnel, a topologia recomendada para este projeto e:

```text
Cloudflare Tunnel -> Nginx (127.0.0.1:80) -> Node/Express (127.0.0.1:3001)
```

Arquivo exemplo:
- [config.example.yml](/C:/Users/HP/Desktop/restaurant-system/deploy/cloudflared/config.example.yml)

Recomendacao:
- aponte o Tunnel para `http://127.0.0.1:80`
- deixe o Nginx falar com o Node em `http://127.0.0.1:3001`
- assim `/`, `/admin` e `/api/*` passam pelo mesmo fluxo

Observacao:
- se voce apontar o Tunnel direto para `127.0.0.1:3001`, nao use Nginx nesse mesmo fluxo

## HTTPS com Certbot

Nao executei chamadas reais. O passo a passo operacional esta documentado em:
- [DEPLOY_VPS.md](/C:/Users/HP/Desktop/restaurant-system/deploy/DEPLOY_VPS.md)

Resumo:

```bash
sudo certbot --nginx -d restaurant-system.example.com
sudo certbot renew --dry-run
```

## Backup do SQLite

Script pronto para Linux/VPS:
- [backup-sqlite.sh](/C:/Users/HP/Desktop/restaurant-system/scripts/backup-sqlite.sh)

Uso:

```bash
DATABASE_PATH=/var/www/restaurant-system/shared/restaurant-system.db \
BACKUP_DIR=/var/backups/restaurant-system \
bash scripts/backup-sqlite.sh
```

O script:
- cria backup com timestamp
- usa `.backup` do `sqlite3` quando disponivel
- faz fallback para `cp`
- remove backups antigos conforme `BACKUP_RETENTION_DAYS`

## Deploy em VPS

Guia completo:
- [DEPLOY_VPS.md](/C:/Users/HP/Desktop/restaurant-system/deploy/DEPLOY_VPS.md)

Resumo:
1. instalar Node, PM2, Nginx, Certbot e sqlite3
2. copiar projeto para `/var/www/restaurant-system/current`
3. criar banco em `/var/www/restaurant-system/shared`
4. rodar `npm install`
5. rodar `npm run build`
6. gerar `ADMIN_PASSWORD_HASH`
7. subir com PM2
8. configurar Nginx
9. configurar Cloudflare Tunnel se esse for o acesso externo escolhido
10. ativar HTTPS
11. configurar backup por cron

## Credenciais admin

Desenvolvimento:
- usuario padrao: `admin`
- senha padrao: `admin123`

Producao:
- defina `ADMIN_USERNAME`
- gere e configure `ADMIN_PASSWORD_HASH`
- nunca commite a senha ou o hash real

## Checklist pos-deploy

1. `curl http://127.0.0.1:3001/api/health`
2. abrir `https://SEU_DOMINIO/`
3. abrir `https://SEU_DOMINIO/admin`
4. validar login admin
5. testar check-in/check-out do quiosque
6. gerar payroll draft
7. exportar auditoria CSV
8. validar acesso pelo dominio do Tunnel
9. rodar backup manual do SQLite
10. validar `pm2 status`
11. validar `sudo nginx -t`

## Arquivos operacionais criados

- [ecosystem.config.js](/C:/Users/HP/Desktop/restaurant-system/ecosystem.config.js)
- [restaurant-system.example.conf](/C:/Users/HP/Desktop/restaurant-system/deploy/nginx/restaurant-system.example.conf)
- [config.example.yml](/C:/Users/HP/Desktop/restaurant-system/deploy/cloudflared/config.example.yml)
- [DEPLOY_VPS.md](/C:/Users/HP/Desktop/restaurant-system/deploy/DEPLOY_VPS.md)
- [generate-admin-password-hash.js](/C:/Users/HP/Desktop/restaurant-system/scripts/generate-admin-password-hash.js)
- [backup-sqlite.sh](/C:/Users/HP/Desktop/restaurant-system/scripts/backup-sqlite.sh)

## Limitacoes atuais

- SQLite continua sendo single-host e single-writer por design
- nao ha cluster multi-node
- nao ha storage remoto de backup embutido
- nao ha rotacao automatica de logs do PM2/Nginx neste repositório
- ainda falta observabilidade de producao mais forte
