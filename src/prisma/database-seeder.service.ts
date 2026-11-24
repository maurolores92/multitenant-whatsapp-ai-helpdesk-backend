import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from './prisma.service';
import { Role } from '@prisma/client';
import {
  PERMISSION_DEFINITIONS,
  ROLE_DEFAULT_PERMISSIONS,
} from '../auth/constants/permissions.constant';

@Injectable()
export class DatabaseSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseSeederService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Se ejecuta automáticamente al arrancar el backend de NestJS
   */
  async onApplicationBootstrap() {
    this.logger.log('--- Verificando estado de la Base de Datos y Seeder Inicial ---');
    try {
      await this.seedPermissionsAndRoles();
      await this.seedDefaultTenantAndUsers();
      await this.seedSampleCustomerAndEquipments();
      this.logger.log('✔ Base de datos inicializada y verificada correctamente.');
    } catch (error) {
      this.logger.error(
        `Error al ejecutar el seeder automático en el arranque: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * 1. Permisos Canónicos y Roles (RBAC)
   */
  async seedPermissionsAndRoles() {
    for (const perm of PERMISSION_DEFINITIONS) {
      await this.prisma.permission.upsert({
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

    const allPermissions = await this.prisma.permission.findMany();
    const permMap = new Map(allPermissions.map((p) => [p.code, p.id]));

    for (const roleKey of Object.keys(ROLE_DEFAULT_PERMISSIONS) as Role[]) {
      const rolePermCodes = ROLE_DEFAULT_PERMISSIONS[roleKey];

      for (const code of rolePermCodes) {
        const permissionId = permMap.get(code);
        if (permissionId) {
          await this.prisma.rolePermission.upsert({
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
    this.logger.log('✔ Permisos y Matriz de Roles (RBAC) verificados.');
  }

  /**
   * 2. Empresa Inicial (Tenant) y Usuarios con Roles
   */
  async seedDefaultTenantAndUsers() {
    // Contraseña por defecto para desarrollo: 'password123'
    const salt = await bcrypt.genSalt(10);
    const defaultHashedPassword = await bcrypt.hash('password123', salt);

    // 1. Crear Usuario Superadmin (Global, sin pertenecer a una sola empresa)
    const superAdminEmail = 'superadmin@admin.com';
    let superAdmin = await this.prisma.user.findUnique({
      where: { email: superAdminEmail },
    });

    if (!superAdmin) {
      superAdmin = await this.prisma.user.create({
        data: {
          name: 'Super Administrador',
          email: superAdminEmail,
          password: defaultHashedPassword,
          role: Role.SUPER_ADMIN,
          tenantId: null,
        },
      });
      this.logger.log(`✔ Usuario Superadmin creado: ${superAdmin.email} (Rol: SUPER_ADMIN)`);
    }

    // 2. Crear Empresa Inicial (HelpCopies SRL)
    const defaultSlug = 'helpcopies';
    let tenant = await this.prisma.tenant.findUnique({
      where: { slug: defaultSlug },
    });

    if (!tenant) {
      // Si existía la empresa previa de prueba 'tecnoservicios', migrarla o crear HelpCopies SRL
      const oldTenant = await this.prisma.tenant.findUnique({
        where: { slug: 'tecnoservicios' },
      });

      if (oldTenant) {
        tenant = await this.prisma.tenant.update({
          where: { id: oldTenant.id },
          data: {
            name: 'HelpCopies SRL',
            slug: defaultSlug,
            whatsappPhone: '+54 9 11 5555-0199',
          },
        });
        this.logger.log(`✔ Empresa actualizada a: ${tenant.name} (${tenant.slug})`);
      } else {
        tenant = await this.prisma.tenant.create({
          data: {
            name: 'HelpCopies SRL',
            slug: defaultSlug,
            whatsappPhone: '+54 9 11 5555-0199',
            aiEnabled: true,
          },
        });
        this.logger.log(`✔ Empresa creada: ${tenant.name}`);
      }
    }

    // 3. Crear Usuario Admin de Compañía (HelpCopies SRL)
    const companyAdminEmail = 'admin@helpcopies.com';
    let companyAdmin = await this.prisma.user.findUnique({
      where: { email: companyAdminEmail },
    });

    if (!companyAdmin) {
      // Si existía admin@tecnoservicios.com, actualizar su correo
      const oldAdmin = await this.prisma.user.findUnique({
        where: { email: 'admin@tecnoservicios.com' },
      });

      if (oldAdmin) {
        companyAdmin = await this.prisma.user.update({
          where: { id: oldAdmin.id },
          data: {
            tenantId: tenant.id,
            name: 'Administrador HelpCopies',
            email: companyAdminEmail,
          },
        });
        this.logger.log(`✔ Usuario Admin actualizado a: ${companyAdmin.email}`);
      } else {
        companyAdmin = await this.prisma.user.create({
          data: {
            tenantId: tenant.id,
            name: 'Administrador HelpCopies',
            email: companyAdminEmail,
            password: defaultHashedPassword,
            role: Role.ADMIN,
          },
        });
        this.logger.log(`✔ Usuario Admin de Compañía creado: ${companyAdmin.email}`);
      }
    }

    // 4. Limpieza estricta: Eliminar usuarios que no hayan sido autorizados (carlos, lucia, etc.)
    await this.prisma.user.deleteMany({
      where: {
        email: {
          notIn: [superAdminEmail, companyAdminEmail],
        },
      },
    });
    this.logger.log('✔ Limpieza estricta: Solo existen Superadmin y Admin de HelpCopies SRL.');
  }

  /**
   * 3. Cliente de Prueba y Equipos Técnicos
   */
  async seedSampleCustomerAndEquipments() {
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: 'tecnoservicios' },
    });

    if (!tenant) return;

    const samplePhone = '+5491144442233';

    let customer = await this.prisma.customer.findUnique({
      where: {
        tenantId_phone: {
          tenantId: tenant.id,
          phone: samplePhone,
        },
      },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          tenantId: tenant.id,
          name: 'Roberto Gómez',
          companyName: 'Sanatorio San Lucas S.R.L.',
          phone: samplePhone,
          email: 'roberto.gomez@sanlucas.com',
          address: 'Av. Libertador 4200, Piso 3',
        },
      });
      this.logger.log(`✔ Cliente de muestra creado: ${customer.companyName}`);

      // Equipos del cliente
      await this.prisma.equipment.createMany({
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
      this.logger.log('✔ Equipos técnicos registrados para el cliente de prueba.');
    }
  }
}
