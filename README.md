# BIMS ERP — Backend API

Stack: **Node.js + Fastify + Prisma + PostgreSQL**

---

## Setup local (5 pasos)

### 1. Clonar e instalar dependencias
```bash
git clone <repo>
cd bims-erp-backend
npm install
```

### 2. Configurar variables de entorno
```bash
cp .env.example .env
# Editar .env con tu DATABASE_URL y JWT_SECRET
```

Para generar el JWT_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Levantar PostgreSQL local (con Docker)
```bash
docker run --name bimserp-db \
  -e POSTGRES_DB=bimserp \
  -e POSTGRES_USER=bimserp \
  -e POSTGRES_PASSWORD=bimserp123 \
  -p 5432:5432 \
  -d postgres:16

# DATABASE_URL en .env:
# postgresql://bimserp:bimserp123@localhost:5432/bimserp?schema=public
```

### 4. Crear tablas y cargar datos de prueba
```bash
npm run db:migrate    # Crea todas las tablas
npm run db:seed       # Carga tenant demo + usuarios + productos
```

### 5. Iniciar el servidor
```bash
npm run dev           # Modo desarrollo con hot reload
# → API disponible en http://localhost:3001
```

---

## Deploy en Railway (producción)

### Paso 1 — Crear proyecto en Railway
1. Ir a [railway.app](https://railway.app) → New Project
2. Add PostgreSQL service → copiar la `DATABASE_URL`
3. Add Node.js service → conectar con el repositorio de GitHub

### Paso 2 — Variables de entorno en Railway
```
DATABASE_URL      = (la que Railway genera automáticamente)
JWT_SECRET        = (string random de 64 bytes)
NODE_ENV          = production
FRONTEND_URL      = https://erp.ciarbis.com
```

### Paso 3 — Configurar el comando de inicio
En Railway → Settings → Deploy:
```
Build Command:   npm install && npx prisma migrate deploy
Start Command:   npm start
```

### Paso 4 — Primera migración y seed
```bash
# Desde tu máquina local, apuntando a la DB de Railway:
DATABASE_URL="<url de railway>" npm run db:seed
```

---

## Estructura del proyecto

```
bims-erp-backend/
├── prisma/
│   ├── schema.prisma        ← Schema completo (30 modelos, 13 enums)
│   └── migrations/          ← Generadas por Prisma automáticamente
├── src/
│   ├── index.js             ← Entry point Fastify
│   ├── seed.js              ← Datos de prueba
│   ├── lib/
│   │   └── prisma.js        ← Prisma client singleton
│   ├── plugins/
│   │   ├── auth.js          ← JWT + bcrypt middleware
│   │   └── tenant.js        ← Middleware multi-tenant
│   └── routes/
│       ├── auth.js          ← POST /login, POST /logout, POST /refresh
│       ├── productos.js     ← CRUD productos + stock
│       ├── clientes.js      ← CRUD clientes
│       ├── proveedores.js   ← CRUD proveedores
│       ├── ventas.js        ← CRUD órdenes de venta
│       ├── compras.js       ← CRUD órdenes de compra
│       ├── tickets.js       ← Comprobantes X + emisión de facturas
│       ├── movimientos.js   ← Log de stock (solo lectura)
│       └── reportes.js      ← KPIs y reportes fiscales
├── .env.example
├── .gitignore
└── package.json
```

---

## Endpoints principales

### Auth
```
POST /api/auth/login          body: { email, password }
POST /api/auth/logout
POST /api/auth/refresh
POST /api/auth/reset-password
```

### Inventario
```
GET    /api/productos          ?search=&categoria=&page=
POST   /api/productos
GET    /api/productos/:id
PUT    /api/productos/:id
GET    /api/productos/:id/movimientos
POST   /api/movimientos        (ajuste manual de stock)
```

### Ventas
```
GET    /api/clientes
POST   /api/clientes
GET    /api/ventas             ?estado=&from=&to=
POST   /api/ventas             (crea OV + genera ticket X automáticamente)
PUT    /api/ventas/:id/estado
```

### Facturación
```
GET    /api/tickets            ?tipo=X|FC&from=&to=
POST   /api/tickets/:id/facturar   (emite factura → ARCA/AFIP)
POST   /api/tickets/:id/enviar     body: { via: "email"|"whatsapp" }
GET    /api/reportes/fiscal        ?from=&to=  (discriminado X/FC)
```

### Compras
```
GET    /api/proveedores
POST   /api/proveedores
GET    /api/compras
POST   /api/compras
POST   /api/compras/:id/recibir   (recepción parcial/total → ajusta stock)
```

---

## Seguridad

- Contraseñas: **bcrypt** con salt rounds = 12
- Tokens: **JWT** con expiración de 7 días + refresh token
- Multi-tenant: cada request valida `tenantId` del token
- Rate limiting: 100 req/min global, 5 req/min en `/login`
- CORS: solo desde `FRONTEND_URL`
- Audit log: todas las acciones críticas quedan registradas en `audit_logs`

---

## Modelo fiscal (Argentina)

El campo discriminante en `tickets`:
- `tipo = X` → comprobante interno, sin CAE, sin validez fiscal
- `tipo = FC_A / FC_B / FC_C` → factura electrónica con CAE de ARCA
- `facturaEmitida = false/true` → estado de facturación
- Reportes filtran por estos campos para dar los totales discriminados

---

## Siguientes pasos

- [ ] Implementar `src/index.js` (servidor Fastify)
- [ ] Implementar `src/plugins/auth.js` (JWT middleware)
- [ ] Implementar `src/plugins/tenant.js` (tenant resolver)
- [ ] Implementar rutas CRUD por módulo
- [ ] Integración ARCA/AFIP (homologación primero)
- [ ] Reemplazar `DB.get/set` del frontend por `fetch()` a esta API
