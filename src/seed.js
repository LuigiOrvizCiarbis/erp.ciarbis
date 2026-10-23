// ─────────────────────────────────────────────
//  BIMS ERP — Seed de base de datos
//  Crea el tenant demo + usuario admin + datos de ejemplo
//  Ejecutar: npm run db:seed
// ─────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { defaultModulosForRubro } from './lib/modulos.js'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Iniciando seed de BIMS ERP...')

  // ── 1. TENANT DEMO ──────────────────────────────────────
  const rubroDemo = 'supermercado'
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo' },
    update: { rubro: rubroDemo, modulosActivos: defaultModulosForRubro(rubroDemo) },
    create: {
      nombre: 'Empresa Demo SA',
      slug: 'demo',
      cuit: '30-71234567-8',
      email: 'admin@demo.com',
      tel: '+54 223 123-4567',
      moneda: 'ARS',
      condIVA: 'Responsable Inscripto',
      ptoVta: '0001',
      plan: 'PROFESIONAL',
      facAutoEnabled: false,
      rubro: rubroDemo,
      modulosActivos: defaultModulosForRubro(rubroDemo),
    }
  })
  console.log(`✓ Tenant: ${tenant.nombre} (${tenant.slug}) — rubro: ${tenant.rubro}, módulos: ${tenant.modulosActivos.join(', ')}`)

  // ── 2. SUCURSAL PRINCIPAL ────────────────────────────────
  const sucursal = await prisma.sucursal.upsert({
    where: { tenantId_codigo: { tenantId: tenant.id, codigo: 'CENTRAL' } },
    update: {},
    create: {
      tenantId: tenant.id,
      nombre: 'Casa Central',
      codigo: 'CENTRAL',
      direccion: 'Av. San Martín 1250, Mar del Plata',
      esPrincipal: true,
    }
  })
  console.log(`✓ Sucursal: ${sucursal.nombre}`)

  // ── 3. USUARIOS ─────────────────────────────────────────
  const usuarios = [
    { nombre: 'Admin Demo',     email: 'admin@demo.com',     pass: 'demo1234', rol: 'ADMIN',     avatar: 'AD' },
    { nombre: 'Carlos Vendedor',email: 'vendedor@demo.com',  pass: 'demo1234', rol: 'VENDEDOR',  avatar: 'CV' },
    { nombre: 'Ana Depósito',   email: 'deposito@demo.com',  pass: 'demo1234', rol: 'DEPOSITO',  avatar: 'AD' },
    { nombre: 'Luis Contador',  email: 'contador@demo.com',  pass: 'demo1234', rol: 'CONTADOR',  avatar: 'LC' },
  ]

  for (const u of usuarios) {
    const passHash = await bcrypt.hash(u.pass, 12)
    // Vendedor y Depósito quedan asignados a la sucursal (cajero de mostrador);
    // Admin y Contador sin sucursal fija = ven todas.
    const sucursalId = ['VENDEDOR', 'DEPOSITO'].includes(u.rol) ? sucursal.id : null
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: u.email } },
      update: { passHash, sucursalId },
      create: {
        tenantId: tenant.id,
        nombre: u.nombre,
        email: u.email,
        passHash,
        rol: u.rol,
        avatar: u.avatar,
        sucursalId,
      }
    })
    console.log(`✓ Usuario: ${u.nombre} (${u.rol})`)
  }

  // ── 4. CATEGORÍAS ────────────────────────────────────────
  const categorias = [
    { nombre: 'Electrónica',  color: '#378ADD' },
    { nombre: 'Ferretería',   color: '#D97706' },
    { nombre: 'Pinturas',     color: '#7C3AED' },
    { nombre: 'Alimentos',    color: '#16A34A' },
    { nombre: 'Indumentaria', color: '#EC4899' },
    { nombre: 'Automotor',    color: '#DC2626' },
  ]

  const catMap = {}
  for (const c of categorias) {
    const cat = await prisma.categoria.upsert({
      where: { tenantId_nombre: { tenantId: tenant.id, nombre: c.nombre } },
      update: {},
      create: { tenantId: tenant.id, ...c }
    })
    catMap[c.nombre] = cat.id
  }
  console.log(`✓ ${categorias.length} categorías`)

  // ── 5. PRODUCTOS ─────────────────────────────────────────
  const productos = [
    { sku: 'CAB-001', nombre: 'Cable UTP Cat6 x 305m',     cat: 'Electrónica',  stock: 142, stockMin: 50,  precioCosto: 8400,  precioVenta: 12000, codigoBarras: '7791234500017' },
    { sku: 'PIN-020', nombre: 'Pintura látex blanca 4L',   cat: 'Pinturas',     stock: 8,   stockMin: 20,  precioCosto: 3200,  precioVenta: 4800  },
    { sku: 'ACE-043', nombre: 'Aceite motor 5W30 x 4L',    cat: 'Automotor',    stock: 267, stockMin: 100, precioCosto: 5100,  precioVenta: 7200,  codigoBarras: '7791234500048' },
    { sku: 'TOR-102', nombre: 'Tornillo 4mm cabeza hex x100', cat: 'Ferretería', stock: 8,  stockMin: 50,  precioCosto: 1200,  precioVenta: 1800  },
    { sku: 'REM-201', nombre: 'Remera algodón talle M',    cat: 'Indumentaria', stock: 43,  stockMin: 15,  precioCosto: 1800,  precioVenta: 3200  },
    { sku: 'HAR-301', nombre: 'Harina 0000 x 25kg',        cat: 'Alimentos',    stock: 189, stockMin: 80,  precioCosto: 4750,  precioVenta: 6500,  codigoBarras: '7791234500307' },
  ]

  for (const p of productos) {
    const producto = await prisma.producto.upsert({
      where: { tenantId_sku: { tenantId: tenant.id, sku: p.sku } },
      update: { stock: p.stock, codigoBarras: p.codigoBarras },
      create: {
        tenantId: tenant.id,
        categoriaId: catMap[p.cat],
        sku: p.sku,
        codigoBarras: p.codigoBarras,
        nombre: p.nombre,
        stock: p.stock,
        stockMin: p.stockMin,
        precioCosto: p.precioCosto,
        precioVenta: p.precioVenta,
      }
    })

    // Stock inicial también reflejado en la sucursal principal (para probar el descuento por sucursal en PoS)
    await prisma.productoSucursal.upsert({
      where: { productoId_sucursalId: { productoId: producto.id, sucursalId: sucursal.id } },
      update: { stock: p.stock },
      create: { productoId: producto.id, sucursalId: sucursal.id, stock: p.stock, stockMin: p.stockMin },
    })
  }
  console.log(`✓ ${productos.length} productos`)

  // ── 6. CLIENTES ──────────────────────────────────────────
  const clientes = [
    { nombre: 'Ferretería Molina SRL', cuit: '30-71234567-8', condIVA: 'Responsable Inscripto', tipo: 'MAYORISTA', email: 'compras@molina.com',  tel: '+54 223 456-7890' },
    { nombre: 'Textil Greco SA',       cuit: '30-68901234-5', condIVA: 'Responsable Inscripto', tipo: 'EMPRESA',   email: 'admin@textilgreco.com', tel: '+54 223 321-0987' },
    { nombre: 'Juan Carlos López',     cuit: '20-12345678-9', condIVA: 'Consumidor Final',      tipo: 'MINORISTA', email: 'juan@gmail.com',        tel: '+54 223 111-2233' },
  ]

  for (const c of clientes) {
    // Check if exists (no unique compound for name, use find first)
    const exists = await prisma.cliente.findFirst({
      where: { tenantId: tenant.id, cuit: c.cuit }
    })
    if (!exists) {
      await prisma.cliente.create({
        data: { tenantId: tenant.id, ...c }
      })
    }
  }
  console.log(`✓ ${clientes.length} clientes`)

  // ── 7. PROVEEDORES ───────────────────────────────────────
  const proveedores = [
    { nombre: 'Pinturas Inti SA',   cuit: '30-45678901-2', condPago: '30 días', email: 'ventas@pinturasinti.com' },
    { nombre: 'Ferromax SA',        cuit: '30-23456789-1', condPago: '15 días', email: 'comercial@ferromax.com'  },
    { nombre: 'ElectroDist. SRL',   cuit: '30-67890123-4', condPago: '60 días', email: 'pedidos@electrodist.com' },
  ]

  for (const p of proveedores) {
    const exists = await prisma.proveedor.findFirst({
      where: { tenantId: tenant.id, cuit: p.cuit }
    })
    if (!exists) {
      await prisma.proveedor.create({
        data: { tenantId: tenant.id, ...p }
      })
    }
  }
  console.log(`✓ ${proveedores.length} proveedores`)

  console.log('\n🎉 Seed completado exitosamente.')
  console.log('──────────────────────────────────────')
  console.log('Accesos de prueba:')
  console.log('  admin@demo.com    / demo1234  (Admin)')
  console.log('  vendedor@demo.com / demo1234  (Vendedor)')
  console.log('  deposito@demo.com / demo1234  (Depósito)')
  console.log('  contador@demo.com / demo1234  (Contador)')
  console.log('──────────────────────────────────────')
}

main()
  .catch((e) => { console.error('❌ Error en seed:', e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
