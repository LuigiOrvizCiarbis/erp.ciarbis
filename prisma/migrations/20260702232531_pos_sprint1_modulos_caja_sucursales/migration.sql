-- CreateEnum
CREATE TYPE "PlanTipo" AS ENUM ('TRIAL', 'STARTER', 'PROFESIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "RolUsuario" AS ENUM ('ADMIN', 'VENDEDOR', 'DEPOSITO', 'CONTADOR', 'PRODUCCION', 'LOGISTICA');

-- CreateEnum
CREATE TYPE "TipoCliente" AS ENUM ('MINORISTA', 'MAYORISTA', 'EMPRESA', 'GOBIERNO');

-- CreateEnum
CREATE TYPE "EstadoOV" AS ENUM ('BORRADOR', 'PENDIENTE', 'APROBADA', 'ENVIADA', 'ENTREGADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "EstadoOC" AS ENUM ('BORRADOR', 'ENVIADA', 'CONFIRMADA', 'PARCIAL', 'RECIBIDA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "MedioPago" AS ENUM ('EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'QR', 'OTRO');

-- CreateEnum
CREATE TYPE "TipoComprobante" AS ENUM ('X', 'FC_A', 'FC_B', 'FC_C', 'FC_M', 'NC_A', 'NC_B', 'ND_A', 'ND_B');

-- CreateEnum
CREATE TYPE "EstadoTicket" AS ENUM ('EMITIDO', 'ANULADO');

-- CreateEnum
CREATE TYPE "EstadoCaja" AS ENUM ('ABIERTA', 'CERRADA');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('ENTRADA_COMPRA', 'ENTRADA_PRODUCCION', 'ENTRADA_DEVOLUCION', 'ENTRADA_AJUSTE', 'ENTRADA_INICIAL', 'SALIDA_VENTA', 'SALIDA_PRODUCCION', 'SALIDA_AJUSTE', 'SALIDA_MERMA', 'TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SALIDA');

-- CreateEnum
CREATE TYPE "EstadoOT" AS ENUM ('PLANIFICADA', 'EN_PROCESO', 'PAUSADA', 'COMPLETADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "EstadoRuta" AS ENUM ('PLANIFICADA', 'EN_CURSO', 'COMPLETADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "EstadoEntrega" AS ENUM ('PENDIENTE', 'EN_CAMINO', 'ENTREGADA', 'FALLIDA', 'REPROGRAMADA');

-- CreateEnum
CREATE TYPE "PlataformaEcom" AS ENUM ('TIENDANUBE', 'SHOPIFY', 'WOOCOMMERCE', 'MERCADOLIBRE', 'MERCADOPAGO', 'STRIPE', 'WHATSAPP_BUSINESS');

-- CreateEnum
CREATE TYPE "EstadoPedidoExt" AS ENUM ('NUEVO', 'PROCESADO', 'SIN_STOCK', 'ERROR', 'CANCELADO');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "cuit" TEXT,
    "email" TEXT NOT NULL,
    "tel" TEXT,
    "direccion" TEXT,
    "logo" TEXT,
    "moneda" TEXT NOT NULL DEFAULT 'ARS',
    "timezone" TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    "condIVA" TEXT,
    "ptoVta" TEXT NOT NULL DEFAULT '0001',
    "iibb" TEXT,
    "facAutoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "facTipoDefault" TEXT NOT NULL DEFAULT 'X',
    "rubro" TEXT,
    "modulosActivos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" "PlanTipo" NOT NULL DEFAULT 'STARTER',
    "planVence" TIMESTAMP(3),
    "trialVence" TIMESTAMP(3),
    "stripeId" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passHash" TEXT NOT NULL,
    "rol" "RolUsuario" NOT NULL DEFAULT 'VENDEDOR',
    "avatar" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "sucursalId" TEXT,
    "ultimoAcceso" TIMESTAMP(3),
    "resetToken" TEXT,
    "resetTokenExp" TIMESTAMP(3),
    "mfaSecret" TEXT,
    "mfaActivo" BOOLEAN NOT NULL DEFAULT false,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sesiones" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sesiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sucursales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "codigo" TEXT,
    "direccion" TEXT,
    "tel" TEXT,
    "email" TEXT,
    "esPrincipal" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sucursales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "color" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categorias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoriaId" TEXT,
    "sku" TEXT NOT NULL,
    "codigoBarras" TEXT,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "um" TEXT NOT NULL DEFAULT 'unidad',
    "precioCosto" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "precioVenta" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "impuesto" DECIMAL(5,2) NOT NULL DEFAULT 21,
    "stock" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "stockMin" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "stockMax" DECIMAL(15,3),
    "usaLotes" BOOLEAN NOT NULL DEFAULT false,
    "usaSerie" BOOLEAN NOT NULL DEFAULT false,
    "publicadoWeb" BOOLEAN NOT NULL DEFAULT false,
    "imagenes" TEXT[],
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productos_sucursales" (
    "id" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "sucursalId" TEXT NOT NULL,
    "stock" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "stockMin" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "ubicacion" TEXT,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productos_sucursales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lotes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "nroLote" TEXT NOT NULL,
    "cantidad" DECIMAL(15,3) NOT NULL,
    "cantDisponible" DECIMAL(15,3) NOT NULL,
    "fechaElab" TIMESTAMP(3),
    "fechaVenc" TIMESTAMP(3),
    "proveedor" TEXT,
    "observaciones" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clientes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "razonSocial" TEXT,
    "cuit" TEXT,
    "dni" TEXT,
    "condIVA" TEXT NOT NULL DEFAULT 'Consumidor Final',
    "tipo" "TipoCliente" NOT NULL DEFAULT 'MINORISTA',
    "email" TEXT,
    "tel" TEXT,
    "whatsapp" TEXT,
    "direccion" TEXT,
    "ciudad" TEXT,
    "provincia" TEXT,
    "pais" TEXT NOT NULL DEFAULT 'Argentina',
    "limiteCred" DECIMAL(15,2),
    "saldo" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "emailFac" TEXT,
    "condPago" TEXT NOT NULL DEFAULT 'Contado',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proveedores" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "razonSocial" TEXT,
    "cuit" TEXT,
    "condIVA" TEXT NOT NULL DEFAULT 'Responsable Inscripto',
    "email" TEXT,
    "tel" TEXT,
    "direccion" TEXT,
    "condPago" TEXT NOT NULL DEFAULT '30 días',
    "saldo" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proveedores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordenes_venta" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nro" INTEGER NOT NULL,
    "clienteId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "sucursalId" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaEntrega" TIMESTAMP(3),
    "observaciones" TEXT,
    "subtotal" DECIMAL(15,2) NOT NULL,
    "descuento" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "impuestos" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(15,2) NOT NULL,
    "estado" "EstadoOV" NOT NULL DEFAULT 'PENDIENTE',
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ordenes_venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineas_orden_venta" (
    "id" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(15,3) NOT NULL,
    "precioUnit" DECIMAL(15,2) NOT NULL,
    "descuento" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "impuesto" DECIMAL(5,2) NOT NULL DEFAULT 21,
    "subtotal" DECIMAL(15,2) NOT NULL,

    CONSTRAINT "lineas_orden_venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordenes_compra" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nro" INTEGER NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaEntrega" TIMESTAMP(3),
    "observaciones" TEXT,
    "subtotal" DECIMAL(15,2) NOT NULL,
    "impuestos" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(15,2) NOT NULL,
    "estado" "EstadoOC" NOT NULL DEFAULT 'BORRADOR',
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ordenes_compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineas_orden_compra" (
    "id" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(15,3) NOT NULL,
    "cantRecibida" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "precioUnit" DECIMAL(15,2) NOT NULL,
    "impuesto" DECIMAL(5,2) NOT NULL DEFAULT 21,
    "subtotal" DECIMAL(15,2) NOT NULL,

    CONSTRAINT "lineas_orden_compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recepciones_mercaderia" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observaciones" TEXT,

    CONSTRAINT "recepciones_mercaderia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recepcion_items" (
    "id" TEXT NOT NULL,
    "recepcionId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "cantidad" DECIMAL(15,3) NOT NULL,
    "loteId" TEXT,

    CONSTRAINT "recepcion_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nro" INTEGER NOT NULL,
    "ordenId" TEXT,
    "clienteId" TEXT,
    "usuarioId" TEXT NOT NULL,
    "sucursalId" TEXT,
    "cajaSesionId" TEXT,
    "medioPago" "MedioPago",
    "tipo" "TipoComprobante" NOT NULL DEFAULT 'X',
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(15,2) NOT NULL,
    "impuestos" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(15,2) NOT NULL,
    "facturaEmitida" BOOLEAN NOT NULL DEFAULT false,
    "facturaFecha" TIMESTAMP(3),
    "facturaCAE" TEXT,
    "facturaCAEVto" TIMESTAMP(3),
    "facturaTipo" TEXT,
    "facturaPtoVta" TEXT,
    "facturaNro" TEXT,
    "facturaQR" TEXT,
    "enviadoEmail" BOOLEAN NOT NULL DEFAULT false,
    "enviadoWA" BOOLEAN NOT NULL DEFAULT false,
    "emailEnviadoA" TEXT,
    "waEnviadoA" TEXT,
    "estado" "EstadoTicket" NOT NULL DEFAULT 'EMITIDO',
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineas_ticket" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "productoId" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(15,3) NOT NULL,
    "precioUnit" DECIMAL(15,2) NOT NULL,
    "impuesto" DECIMAL(5,2) NOT NULL DEFAULT 21,
    "subtotal" DECIMAL(15,2) NOT NULL,

    CONSTRAINT "lineas_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caja_sesiones" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sucursalId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "montoApertura" DECIMAL(15,2) NOT NULL,
    "montoCierreDeclarado" DECIMAL(15,2),
    "totalesPorMedioPago" JSONB,
    "estado" "EstadoCaja" NOT NULL DEFAULT 'ABIERTA',
    "abiertaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerradaEn" TIMESTAMP(3),

    CONSTRAINT "caja_sesiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimientos_stock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "cantidad" DECIMAL(15,3) NOT NULL,
    "stockPost" DECIMAL(15,3) NOT NULL,
    "ordenVentaId" TEXT,
    "ordenCompraId" TEXT,
    "ticketId" TEXT,
    "ordenTrabajoId" TEXT,
    "referencia" TEXT,
    "loteId" TEXT,
    "sucursalId" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimientos_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "nombre" TEXT,
    "version" TEXT NOT NULL DEFAULT '1',
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_items" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "cantidad" DECIMAL(15,4) NOT NULL,
    "um" TEXT NOT NULL DEFAULT 'unidad',
    "merma" DECIMAL(5,2) NOT NULL DEFAULT 0,

    CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordenes_trabajo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nro" INTEGER NOT NULL,
    "bomId" TEXT NOT NULL,
    "cantPlanif" DECIMAL(15,3) NOT NULL,
    "cantProd" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "fechaInicio" TIMESTAMP(3),
    "fechaFin" TIMESTAMP(3),
    "fechaFinEst" TIMESTAMP(3),
    "estado" "EstadoOT" NOT NULL DEFAULT 'PLANIFICADA',
    "observaciones" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ordenes_trabajo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineas_orden_trabajo" (
    "id" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "cantPlanif" DECIMAL(15,3) NOT NULL,
    "cantConsumida" DECIMAL(15,3) NOT NULL DEFAULT 0,

    CONSTRAINT "lineas_orden_trabajo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repartidores" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tel" TEXT,
    "vehiculo" TEXT,
    "patente" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repartidores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rutas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nro" INTEGER NOT NULL,
    "repartidorId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" "EstadoRuta" NOT NULL DEFAULT 'PLANIFICADA',
    "observaciones" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rutas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entregas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rutaId" TEXT,
    "ordenVentaId" TEXT,
    "direccion" TEXT NOT NULL,
    "clienteNombre" TEXT NOT NULL,
    "clienteTel" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "estado" "EstadoEntrega" NOT NULL DEFAULT 'PENDIENTE',
    "firmadoPor" TEXT,
    "fotoUrl" TEXT,
    "fechaEntrega" TIMESTAMP(3),
    "observaciones" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entregas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integraciones" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plataforma" "PlataformaEcom" NOT NULL,
    "nombre" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "shopUrl" TEXT,
    "webhookSecret" TEXT,
    "syncStock" BOOLEAN NOT NULL DEFAULT true,
    "syncPrecios" BOOLEAN NOT NULL DEFAULT true,
    "freqSync" INTEGER NOT NULL DEFAULT 5,
    "ultimoSync" TIMESTAMP(3),
    "syncStatus" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integraciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedidos_externos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "integracionId" TEXT NOT NULL,
    "idExterno" TEXT NOT NULL,
    "plataforma" "PlataformaEcom" NOT NULL,
    "nroExterno" TEXT,
    "clienteNombre" TEXT NOT NULL,
    "clienteEmail" TEXT,
    "clienteTel" TEXT,
    "clienteDireccion" TEXT,
    "total" DECIMAL(15,2) NOT NULL,
    "estado" "EstadoPedidoExt" NOT NULL DEFAULT 'NUEVO',
    "ordenVentaId" TEXT,
    "rawData" JSONB,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pedidos_externos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuraciones_empresa" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuraciones_empresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "accion" TEXT NOT NULL,
    "entidad" TEXT,
    "entidadId" TEXT,
    "detalle" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_sucursalId_idx" ON "users"("sucursalId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "sesiones_token_key" ON "sesiones"("token");

-- CreateIndex
CREATE INDEX "sesiones_userId_idx" ON "sesiones"("userId");

-- CreateIndex
CREATE INDEX "sesiones_token_idx" ON "sesiones"("token");

-- CreateIndex
CREATE INDEX "sucursales_tenantId_idx" ON "sucursales"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sucursales_tenantId_codigo_key" ON "sucursales"("tenantId", "codigo");

-- CreateIndex
CREATE INDEX "categorias_tenantId_idx" ON "categorias"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_tenantId_nombre_key" ON "categorias"("tenantId", "nombre");

-- CreateIndex
CREATE INDEX "productos_tenantId_idx" ON "productos"("tenantId");

-- CreateIndex
CREATE INDEX "productos_tenantId_activo_idx" ON "productos"("tenantId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "productos_tenantId_sku_key" ON "productos"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "productos_tenantId_codigoBarras_key" ON "productos"("tenantId", "codigoBarras");

-- CreateIndex
CREATE UNIQUE INDEX "productos_sucursales_productoId_sucursalId_key" ON "productos_sucursales"("productoId", "sucursalId");

-- CreateIndex
CREATE INDEX "lotes_tenantId_idx" ON "lotes"("tenantId");

-- CreateIndex
CREATE INDEX "lotes_productoId_idx" ON "lotes"("productoId");

-- CreateIndex
CREATE INDEX "lotes_fechaVenc_idx" ON "lotes"("fechaVenc");

-- CreateIndex
CREATE UNIQUE INDEX "lotes_tenantId_productoId_nroLote_key" ON "lotes"("tenantId", "productoId", "nroLote");

-- CreateIndex
CREATE INDEX "clientes_tenantId_idx" ON "clientes"("tenantId");

-- CreateIndex
CREATE INDEX "clientes_tenantId_cuit_idx" ON "clientes"("tenantId", "cuit");

-- CreateIndex
CREATE INDEX "proveedores_tenantId_idx" ON "proveedores"("tenantId");

-- CreateIndex
CREATE INDEX "ordenes_venta_tenantId_idx" ON "ordenes_venta"("tenantId");

-- CreateIndex
CREATE INDEX "ordenes_venta_tenantId_estado_idx" ON "ordenes_venta"("tenantId", "estado");

-- CreateIndex
CREATE INDEX "ordenes_venta_clienteId_idx" ON "ordenes_venta"("clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_venta_tenantId_nro_key" ON "ordenes_venta"("tenantId", "nro");

-- CreateIndex
CREATE INDEX "lineas_orden_venta_ordenId_idx" ON "lineas_orden_venta"("ordenId");

-- CreateIndex
CREATE INDEX "ordenes_compra_tenantId_idx" ON "ordenes_compra"("tenantId");

-- CreateIndex
CREATE INDEX "ordenes_compra_tenantId_estado_idx" ON "ordenes_compra"("tenantId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_compra_tenantId_nro_key" ON "ordenes_compra"("tenantId", "nro");

-- CreateIndex
CREATE INDEX "lineas_orden_compra_ordenId_idx" ON "lineas_orden_compra"("ordenId");

-- CreateIndex
CREATE INDEX "recepciones_mercaderia_tenantId_idx" ON "recepciones_mercaderia"("tenantId");

-- CreateIndex
CREATE INDEX "recepciones_mercaderia_ordenId_idx" ON "recepciones_mercaderia"("ordenId");

-- CreateIndex
CREATE INDEX "tickets_tenantId_idx" ON "tickets"("tenantId");

-- CreateIndex
CREATE INDEX "tickets_tenantId_tipo_idx" ON "tickets"("tenantId", "tipo");

-- CreateIndex
CREATE INDEX "tickets_tenantId_facturaEmitida_idx" ON "tickets"("tenantId", "facturaEmitida");

-- CreateIndex
CREATE INDEX "tickets_clienteId_idx" ON "tickets"("clienteId");

-- CreateIndex
CREATE INDEX "tickets_sucursalId_idx" ON "tickets"("sucursalId");

-- CreateIndex
CREATE INDEX "tickets_cajaSesionId_idx" ON "tickets"("cajaSesionId");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_tenantId_nro_key" ON "tickets"("tenantId", "nro");

-- CreateIndex
CREATE INDEX "lineas_ticket_ticketId_idx" ON "lineas_ticket"("ticketId");

-- CreateIndex
CREATE INDEX "caja_sesiones_tenantId_idx" ON "caja_sesiones"("tenantId");

-- CreateIndex
CREATE INDEX "caja_sesiones_tenantId_sucursalId_estado_idx" ON "caja_sesiones"("tenantId", "sucursalId", "estado");

-- CreateIndex
CREATE INDEX "caja_sesiones_usuarioId_idx" ON "caja_sesiones"("usuarioId");

-- CreateIndex
CREATE INDEX "movimientos_stock_tenantId_idx" ON "movimientos_stock"("tenantId");

-- CreateIndex
CREATE INDEX "movimientos_stock_productoId_idx" ON "movimientos_stock"("productoId");

-- CreateIndex
CREATE INDEX "movimientos_stock_tenantId_fecha_idx" ON "movimientos_stock"("tenantId", "fecha");

-- CreateIndex
CREATE INDEX "boms_tenantId_idx" ON "boms"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "boms_tenantId_productoId_version_key" ON "boms"("tenantId", "productoId", "version");

-- CreateIndex
CREATE INDEX "bom_items_bomId_idx" ON "bom_items"("bomId");

-- CreateIndex
CREATE INDEX "ordenes_trabajo_tenantId_idx" ON "ordenes_trabajo"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_trabajo_tenantId_nro_key" ON "ordenes_trabajo"("tenantId", "nro");

-- CreateIndex
CREATE INDEX "lineas_orden_trabajo_ordenId_idx" ON "lineas_orden_trabajo"("ordenId");

-- CreateIndex
CREATE INDEX "repartidores_tenantId_idx" ON "repartidores"("tenantId");

-- CreateIndex
CREATE INDEX "rutas_tenantId_idx" ON "rutas"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "rutas_tenantId_nro_key" ON "rutas"("tenantId", "nro");

-- CreateIndex
CREATE INDEX "entregas_tenantId_idx" ON "entregas"("tenantId");

-- CreateIndex
CREATE INDEX "entregas_rutaId_idx" ON "entregas"("rutaId");

-- CreateIndex
CREATE INDEX "integraciones_tenantId_idx" ON "integraciones"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "integraciones_tenantId_plataforma_key" ON "integraciones"("tenantId", "plataforma");

-- CreateIndex
CREATE INDEX "pedidos_externos_tenantId_idx" ON "pedidos_externos"("tenantId");

-- CreateIndex
CREATE INDEX "pedidos_externos_tenantId_estado_idx" ON "pedidos_externos"("tenantId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_externos_tenantId_idExterno_plataforma_key" ON "pedidos_externos"("tenantId", "idExterno", "plataforma");

-- CreateIndex
CREATE UNIQUE INDEX "configuraciones_empresa_tenantId_clave_key" ON "configuraciones_empresa"("tenantId", "clave");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_accion_idx" ON "audit_logs"("tenantId", "accion");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entidad_entidadId_idx" ON "audit_logs"("tenantId", "entidad", "entidadId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sucursales" ADD CONSTRAINT "sucursales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "categorias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos_sucursales" ADD CONSTRAINT "productos_sucursales_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos_sucursales" ADD CONSTRAINT "productos_sucursales_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proveedores" ADD CONSTRAINT "proveedores_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineas_orden_venta" ADD CONSTRAINT "lineas_orden_venta_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_venta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineas_orden_venta" ADD CONSTRAINT "lineas_orden_venta_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineas_orden_compra" ADD CONSTRAINT "lineas_orden_compra_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_compra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineas_orden_compra" ADD CONSTRAINT "lineas_orden_compra_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recepciones_mercaderia" ADD CONSTRAINT "recepciones_mercaderia_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recepcion_items" ADD CONSTRAINT "recepcion_items_recepcionId_fkey" FOREIGN KEY ("recepcionId") REFERENCES "recepciones_mercaderia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_venta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cajaSesionId_fkey" FOREIGN KEY ("cajaSesionId") REFERENCES "caja_sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineas_ticket" ADD CONSTRAINT "lineas_ticket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "caja_sesiones" ADD CONSTRAINT "caja_sesiones_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "boms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_trabajo" ADD CONSTRAINT "ordenes_trabajo_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineas_orden_trabajo" ADD CONSTRAINT "lineas_orden_trabajo_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_trabajo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineas_orden_trabajo" ADD CONSTRAINT "lineas_orden_trabajo_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rutas" ADD CONSTRAINT "rutas_repartidorId_fkey" FOREIGN KEY ("repartidorId") REFERENCES "repartidores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_rutaId_fkey" FOREIGN KEY ("rutaId") REFERENCES "rutas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integraciones" ADD CONSTRAINT "integraciones_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedidos_externos" ADD CONSTRAINT "pedidos_externos_integracionId_fkey" FOREIGN KEY ("integracionId") REFERENCES "integraciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuraciones_empresa" ADD CONSTRAINT "configuraciones_empresa_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
