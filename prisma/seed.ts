import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  PERMISSION_DEFINITIONS,
  ROLE_DEFAULT_PERMISSIONS,
} from '../src/auth/constants/permissions.constant';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Iniciando Seeder Completo ---');

  // 1. Crear o actualizar permisos
  for (const perm of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: {
        name: perm.name,
        description: perm.description,
        category: perm.category,
      },
      create: {
        code: perm.code,
        name: perm.name,
        description: perm.description,
        category: perm.category,
      },
    });
  }
  console.log(`✔ ${PERMISSION_DEFINITIONS.length} Permisos base registrados/actualizados.`);

  // 2. Asociar permisos por defecto a cada Rol
  const allPermissions = await prisma.permission.findMany();
  const permMap = new Map(allPermissions.map((p) => [p.code, p.id]));

  for (const roleKey of Object.keys(ROLE_DEFAULT_PERMISSIONS) as Role[]) {
    const rolePermCodes = ROLE_DEFAULT_PERMISSIONS[roleKey];

    for (const code of rolePermCodes) {
      const permissionId = permMap.get(code);
      if (permissionId) {
        await prisma.rolePermission.upsert({
          where: {
            role_permissionId: {
              role: roleKey,
              permissionId,
            },
          },
          update: {},
          create: {
            role: roleKey,
            permissionId,
          },
        });
      }
    }
  }
  console.log('✔ Matriz de Permisos por Rol inicializada con éxito.');

  // 3. Crear Empresa por defecto: HelpCopies SRL
  let tenant = await prisma.tenant.findUnique({
    where: { slug: 'helpcopies' },
  });

  if (!tenant) {
    const oldTenant = await prisma.tenant.findUnique({
      where: { slug: 'tecnoservicios' },
    });
    if (oldTenant) {
      tenant = await prisma.tenant.update({
        where: { id: oldTenant.id },
        data: {
          name: 'HelpCopies SRL',
          slug: 'helpcopies',
          whatsappPhone: '+54 9 11 5555-0199',
        },
      });
    } else {
      tenant = await prisma.tenant.create({
        data: {
          name: 'HelpCopies SRL',
          slug: 'helpcopies',
          whatsappPhone: '+54 9 11 5555-0199',
          aiEnabled: true,
        },
      });
    }
    console.log(`✔ Empresa creada/actualizada: ${tenant.name}`);
  }

  // 4. Crear únicamente Superadmin y Admin de HelpCopies SRL
  const salt = await bcrypt.genSalt(10);
  const defaultPassword = await bcrypt.hash('password123', salt);

  // Superadmin
  await prisma.user.upsert({
    where: { email: 'superadmin@admin.com' },
    update: { name: 'Super Administrador', role: Role.SUPER_ADMIN },
    create: {
      name: 'Super Administrador',
      email: 'superadmin@admin.com',
      password: defaultPassword,
      role: Role.SUPER_ADMIN,
      tenantId: null,
    },
  });

  // Admin de HelpCopies SRL
  await prisma.user.upsert({
    where: { email: 'admin@helpcopies.com' },
    update: {
      tenantId: tenant.id,
      name: 'Administrador HelpCopies',
      role: Role.ADMIN,
    },
    create: {
      tenantId: tenant.id,
      name: 'Administrador HelpCopies',
      email: 'admin@helpcopies.com',
      password: defaultPassword,
      role: Role.ADMIN,
    },
  });

  // Limpieza estricta: Eliminar usuarios que no sean superadmin o admin de HelpCopies SRL
  await prisma.user.deleteMany({
    where: {
      email: {
        notIn: ['superadmin@admin.com', 'admin@helpcopies.com'],
      },
    },
  });
  console.log('✔ Usuarios inicializados: Únicamente superadmin@admin.com y admin@helpcopies.com.');

  // 5. Cliente de Prueba y Equipos Técnicos
  const samplePhone = '+5491144442233';
  let customer = await prisma.customer.findUnique({
    where: {
      tenantId_phone: {
        tenantId: tenant.id,
        phone: samplePhone,
      },
    },
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        name: 'Roberto Gómez',
        companyName: 'Sanatorio San Lucas S.R.L.',
        phone: samplePhone,
        email: 'roberto.gomez@sanlucas.com',
        address: 'Av. Libertador 4200, Piso 3',
      },
    });

    await prisma.equipment.createMany({
      data: [
        {
          tenantId: tenant.id,
          customerId: customer.id,
          name: 'Ecoflex 3000',
          brand: 'Sonix Med',
          model: 'ECO-3000',
          serialNumber: 'ECO-9923',
          notes: 'Equipo de diagnóstico ultrasónico de alta resolución. Último service en septiembre.',
        },
        {
          tenantId: tenant.id,
          customerId: customer.id,
          name: 'Monitor Multiparamétrico MP-50',
          brand: 'Philips',
          model: 'MP-50',
          serialNumber: 'PH-8812',
          notes: 'Monitoreo de signos vitales. En servicio activo.',
        },
      ],
    });
    console.log('✔ Cliente y equipos de muestra registrados exitosamente.');
  }

  console.log('--- Seeder Finalizado con Éxito ---');
}

main()
  .catch((e) => {
    console.error('Error durante el seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
