// Siembra un Rol de sistema por tenant por cada valor del enum RolUsuario, para que el
// sprint de RBAC (roles configurables) no cambie el comportamiento de ningún usuario que
// no toque la feature. Idempotente: usa upsert por [tenantId, nombre].
import { prisma } from '../src/lib/prisma.js'
import { PERMS_SISTEMA, ROL_LABELS, permisosDesdeModulos } from '../src/lib/permisos.js'

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true } })
  let creados = 0
  for (const t of tenants) {
    for (const [rolEnum, modulos] of Object.entries(PERMS_SISTEMA)) {
      const nombre = ROL_LABELS[rolEnum] || rolEnum
      await prisma.rol.upsert({
        where: { tenantId_nombre: { tenantId: t.id, nombre } },
        update: { permisos: permisosDesdeModulos(modulos), esSistema: true },
        create: {
          tenantId: t.id,
          nombre,
          esSistema: true,
          permisos: permisosDesdeModulos(modulos),
        },
      })
      creados++
    }
  }
  console.log(`Roles de sistema sembrados: ${creados} (${tenants.length} tenants x ${Object.keys(PERMS_SISTEMA).length} roles)`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
