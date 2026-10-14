# Deployment Guide: Cox's Bazar Delivery Platform

This guide outlines the system requirements, installation, database migrations, process management, and production containerization for deploying the Cox's Bazar hyperlocal multi-service delivery platform.

---

## 1. System Requirements

### Minimum Server Specifications
- **CPU**: 2 vCPUs (Intel Xeon / AMD EPYC or ARM Graviton2+)
- **RAM**: 2 GB (4 GB recommended for concurrent WebSocket tracking & geospatial calculations)
- **Storage**: 20 GB SSD / NVMe
- **OS**: Ubuntu 22.04 LTS / Debian 12 / Alpine Linux (for Docker)
- **Runtime**: Node.js >=22.5.0 (matches `engines` in package.json)
- **Database**: PostgreSQL 14+ with PostGIS extension (or SQLite 3.38+ for standalone local edge tests)
- **Reverse Proxy**: NGINX 1.22+ with SSL termination (Let's Encrypt / Certbot)

---

## 2. Local Development Setup

### Step 1: Clone and Install Dependencies
```bash
git clone https://github.com/cxb-express/cxb-delivery-platform.git
cd cxb-delivery-platform
npm install
```

### Step 2: Environment Configuration
```bash
cp .env.example .env
# Update .env with local database credentials, SMS gateway keys, and bKash sandbox credentials
```

### Step 3: Database Initialization
```bash
# Nothing to run. The API creates its schema and applies its migrations on boot, on either
# engine, so the first `npm start` is the initialization step.

# (Optional) Seed the Cox's Bazar pilot dataset explicitly, against the engine DB_DRIVER
# selects. Idempotent: it skips a database that already has users.
npm run db:seed
```

### Step 4: Run the Development Server
```bash
npm run build
npm start
```
The backend HTTP & WebSocket server will be live at `http://localhost:4000` (API: `http://localhost:4000/api/v1`).

---

## 3. Database Migration & Schema Setup

### PostgreSQL (Production Recommended)
1. Create the database and user. Nothing else is needed — no extensions, no `migrations/` directory to apply by hand:
```sql
CREATE DATABASE cxb_delivery_db;
CREATE USER cxb_admin WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE cxb_delivery_db TO cxb_admin;
```
2. Point the API at it and start it. The schema is created and migrated on the first boot, and the
   boot log says which backend and which database it came up against:
```bash
DB_DRIVER=postgres \
DATABASE_URL='postgresql://cxb_admin:your_secure_password@localhost:5432/cxb_delivery_db' \
npm start
```
   `PG_POOL_MAX` bounds the connections held open (10 by default); writes serialise on a
transaction-scoped lock, so the pool is what concurrency reads scale with. A deployment of
several hosts, or one behind a scheduler that moves processes, needs this backend — every process
serving the same users must point at the same database, because the session row behind every
access token is looked up there on every request.
3. Confirm the read that every authenticated request makes is the cheap one:
```bash
psql "$DATABASE_URL" -c "EXPLAIN SELECT * FROM auth_sessions WHERE id = 'sess_example'"
# -> Index Scan using auth_sessions_pkey on auth_sessions
```

### SQLite (Low-Cost / Offline Standalone)
This is the default: leave `DB_DRIVER=sqlite` (or unset) and set
`SQLITE_STORAGE_PATH=./data/cxb_delivery.sqlite`. SQLite WAL mode (Write-Ahead Logging) is enabled
automatically by the driver, several processes on the host can share the file, and each waits for
another writer's lock rather than failing.

---

## 4. PM2 Process Manager Deployment

For standard virtual machine deployments (DigitalOcean droplet, Hetzner VPS, AWS EC2):

### 1. Build TypeScript Source
```bash
npm run build
```

### 2. Configure Ecosystem File (`ecosystem.config.js`)
```javascript
module.exports = {
  apps: [
    {
      name: 'cxb-delivery-backend',
      script: './dist/main.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 4000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true
    }
  ]
};
```

### 3. Start Service with PM2
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## 5. Docker Containerization

### Dockerfile
```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
EXPOSE 4000
USER node
CMD ["node", "dist/main.js"]
```

### Docker Compose (`docker-compose.yml`)
```yaml
version: '3.8'
services:
  postgres:
    image: postgis/postgis:15-3.3-alpine
    container_name: cxb_postgres
    environment:
      POSTGRES_DB: cxb_delivery_db
      POSTGRES_USER: cxb_admin
      POSTGRES_PASSWORD: secure_password_123
    ports:
      - "5432:5432"
    volumes:
      - cxb_pgdata:/var/lib/postgresql/data
    restart: unless-stopped

  backend:
    build: .
    container_name: cxb_backend
    environment:
      NODE_ENV: production
      PORT: 4000
      # The engine, and one connection string — the runtime reads no DB_HOST/DB_USER keys.
      DB_DRIVER: postgres
      DATABASE_URL: postgresql://cxb_admin:secure_password_123@postgres:5432/cxb_delivery_db
      # Behind a proxy, and the header it maintains, or every customer shares one
      # rate-limit bucket and every session row names the proxy (docs/API.md, item 14).
      TRUST_PROXY: loopback
      TRUSTED_FORWARD_HEADER: x-forwarded-for
    ports:
      - "4000:4000"
    depends_on:
      - postgres
    restart: unless-stopped

volumes:
  cxb_pgdata:
```

Run with:
```bash
docker compose up -d
```

---

## 6. NGINX Reverse Proxy & SSL Configuration

```nginx
server {
    server_name api.cxbexpress.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Apply SSL:
```bash
sudo certbot --nginx -d api.cxbexpress.com
```
