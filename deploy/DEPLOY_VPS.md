# Deploy em VPS

## O que ja esta pronto

- Backend Express servindo API e frontend buildado
- `/` e `/admin` servidos pelo backend em producao
- SQLite como persistencia unica
- sessao admin persistida em SQLite
- auditoria e payroll operacionais

## Estrutura sugerida na VPS

```text
/var/www/restaurant-system/
  current/   -> codigo atual
  shared/    -> banco SQLite e arquivos persistentes
  backups/   -> backups locais opcionais
```

Exemplo de banco:

```text
/var/www/restaurant-system/shared/restaurant-system.db
```

## Pre-requisitos

- Ubuntu/Debian recente
- Node.js 20+
- npm
- PM2
- Nginx
- Certbot

Instalacao base:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx sqlite3
sudo npm install -g pm2
```

## 1. Subir codigo

```bash
sudo mkdir -p /var/www/restaurant-system/current
sudo mkdir -p /var/www/restaurant-system/shared
sudo mkdir -p /var/backups/restaurant-system
sudo mkdir -p /var/log/restaurant-system
sudo chown -R $USER:$USER /var/www/restaurant-system /var/backups/restaurant-system /var/log/restaurant-system
```

Copie o projeto para:

```text
/var/www/restaurant-system/current
```

## 2. Instalar dependencias e buildar

```bash
cd /var/www/restaurant-system/current
npm install
npm run build
chmod +x scripts/backup-sqlite.sh
```

## 3. Configurar ambiente

Crie um arquivo `.env.production` fora do repositório ou exporte as variaveis no shell do deploy.

Minimo recomendado:

```bash
export NODE_ENV=production
export PORT=3001
export FRONTEND_ORIGIN=https://restaurant-system.example.com
export DATABASE_PATH=/var/www/restaurant-system/shared/restaurant-system.db
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD_HASH='PBKDF2_HASH_AQUI'
export ADMIN_SESSION_TTL_MS=28800000
export ADMIN_LOGIN_RATE_LIMIT_MAX_ATTEMPTS=5
export ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS=900000
export AUDIT_LOG_RETENTION_DAYS=365
```

Para gerar o hash:

```bash
cd /var/www/restaurant-system/current
npm run hash:admin -- "SENHA_FORTE_AQUI"
```

## 4. PM2

Arquivo pronto:

```text
/var/www/restaurant-system/current/ecosystem.config.js
```

Start:

```bash
cd /var/www/restaurant-system/current
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

Comandos uteis:

```bash
pm2 status
pm2 logs restaurant-system
pm2 restart restaurant-system
pm2 stop restaurant-system
```

## 5. Nginx

Arquivo exemplo:

```text
/var/www/restaurant-system/current/deploy/nginx/restaurant-system.example.conf
```

Copie para:

```bash
sudo cp deploy/nginx/restaurant-system.example.conf /etc/nginx/sites-available/restaurant-system
sudo ln -s /etc/nginx/sites-available/restaurant-system /etc/nginx/sites-enabled/restaurant-system
sudo nginx -t
sudo systemctl reload nginx
```

Antes do HTTPS, a app fica via HTTP no dominio placeholder configurado.

## 6. Cloudflare Tunnel

Se voce estiver usando Cloudflare Tunnel, a topologia recomendada para este projeto e:

```text
Internet -> Cloudflare Tunnel -> Nginx (127.0.0.1:80) -> Node/Express (127.0.0.1:3001)
```

Isso evita expor a porta 3001 diretamente e mantem a mesma configuracao de proxy para `/`, `/admin` e `/api/*`.

Arquivo exemplo:

```text
/var/www/restaurant-system/current/deploy/cloudflared/config.example.yml
```

Exemplo de configuracao:

```yaml
tunnel: REPLACE_WITH_TUNNEL_ID
credentials-file: /etc/cloudflared/REPLACE_WITH_TUNNEL_ID.json

ingress:
  - hostname: restaurant-system.example.com
    service: http://127.0.0.1:80
  - service: http_status:404
```

Passos tipicos:

```bash
cloudflared tunnel login
cloudflared tunnel create restaurant-system
cloudflared tunnel route dns restaurant-system restaurant-system.example.com
sudo mkdir -p /etc/cloudflared
sudo cp deploy/cloudflared/config.example.yml /etc/cloudflared/config.yml
sudo systemctl enable cloudflared
sudo systemctl restart cloudflared
```

Validacao:
- `curl http://127.0.0.1:3001/api/health`
- `curl http://127.0.0.1`
- abrir o dominio publicado pelo Tunnel

Observacao importante:
- se usar Tunnel + Nginx, o Tunnel deve apontar para `127.0.0.1:80`
- se apontar direto para `127.0.0.1:3001`, remova o Nginx desse fluxo para evitar confusao

## 7. HTTPS com Certbot

1. Aponte o DNS do dominio para a VPS.
2. Garanta que a porta 80 esteja aberta.
3. Com o Nginx ativo, rode:

```bash
sudo certbot --nginx -d restaurant-system.example.com
```

4. Teste renovacao:

```bash
sudo certbot renew --dry-run
```

5. Recarregue o Nginx se necessario:

```bash
sudo systemctl reload nginx
```

Observacao:
- se o trafego externo vier exclusivamente por Cloudflare Tunnel, o HTTPS publico ja termina na Cloudflare
- o bloco HTTPS com Certbot continua util quando voce tambem quer acesso direto via Nginx, origem TLS local ou padrao operacional tradicional

## 8. Backup do SQLite

Script pronto:

```text
/var/www/restaurant-system/current/scripts/backup-sqlite.sh
```

Execucao manual:

```bash
DATABASE_PATH=/var/www/restaurant-system/shared/restaurant-system.db \
BACKUP_DIR=/var/backups/restaurant-system \
bash /var/www/restaurant-system/current/scripts/backup-sqlite.sh
```

Cron diario sugerido:

```bash
0 2 * * * DATABASE_PATH=/var/www/restaurant-system/shared/restaurant-system.db BACKUP_DIR=/var/backups/restaurant-system /var/www/restaurant-system/current/scripts/backup-sqlite.sh >> /var/log/restaurant-system/backup.log 2>&1
```

## 9. Checklist rapido

1. `npm install`
2. `npm run build`
3. gerar `ADMIN_PASSWORD_HASH`
4. configurar variaveis de ambiente
5. `pm2 start ecosystem.config.js --env production`
6. configurar Nginx
7. configurar Cloudflare Tunnel se for o modo escolhido
8. ativar HTTPS com Certbot se quiser TLS local no Nginx
9. configurar backup do SQLite
10. validar:
   - `curl http://127.0.0.1:3001/api/health`
   - `curl http://127.0.0.1`
   - abrir `/`
   - abrir `/admin`
   - login admin
   - gerar payroll draft
   - exportar auditoria

## Limitacoes operacionais atuais

- SQLite continua sendo arquivo local, entao backup e permissao de disco sao criticos
- nao ha replicacao nativa do banco
- nao ha cluster multi-instancia; o deploy recomendado continua sendo 1 processo PM2
- ainda nao ha observabilidade completa, alertas ou rotacao automatica de logs
