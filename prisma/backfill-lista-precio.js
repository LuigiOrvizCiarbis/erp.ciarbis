// One-off: crea una ListaPrecio "Consumidor Final" (esDefault:true) por tenant y asigna
// todos los clientes existentes a esa lista (sin margenes cargados — no cambia ningún precio).
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true } })
  for (const { id: tenantId } of tenants) {
    let lista = await prisma.listaPrecio.findFirst({ where: { tenantId, esDefault: true } })
    if (!lista) {
      lista = await prisma.listaPrecio.create({ data: { tenantId, nombre: 'Consumidor Final', esDefault: true } })
    }
    const r = await prisma.cliente.updateMany({ where: { tenantId, listaPrecioId: null }, data: { listaPrecioId: lista.id } })
    console.log(tenantId, '-> lista', lista.id, 'asignada a', r.count, 'clientes')
  }
}

main().finally(() => prisma.$disconnect())
