import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PERMISSIONS,
  PERMISSION_DEFINITIONS,
  PermissionCode,
  ROLE_DEFAULT_PERMISSIONS,
} from './constants/permissions.constant';

const VALID_PERMISSION_CODES = new Set<string>(Object.values(PERMISSIONS));

/**
 * Resuelve los códigos de permisos efectivos de un usuario.
 * - SUPER_ADMIN siempre posee todos los permisos.
 * - Si useCustomPermissions=true, usa los permisos asignados al usuario en UserPermission.
 * - Caso contrario, hereda los permisos predeterminados del rol en RolePermission.
 */
export async function resolveEffectivePermissions(
  prisma: PrismaService,
  user: { id: string; role: Role; useCustomPermissions?: boolean },
): Promise<string[]> {
  if (user.role === Role.SUPER_ADMIN) {
    return Object.values(PERMISSIONS);
  }

  if (user.useCustomPermissions) {
    const userPerms = await prisma.userPermission.findMany({
      where: { userId: user.id },
      include: {
        permission: {
          select: { code: true },
        },
      },
    });
    return userPerms.map((up) => up.permission.code);
  }

  const rolePermissions = await prisma.rolePermission.findMany({
    where: { role: user.role },
    include: {
      permission: {
        select: { code: true },
      },
    },
  });

  if (rolePermissions.length > 0) {
    return rolePermissions.map((rp) => rp.permission.code);
  }

  return [...(ROLE_DEFAULT_PERMISSIONS[user.role] ?? [])];
}

/**
 * Sincroniza la lista de permisos explícitos de un usuario en base de datos
 * y activa useCustomPermissions=true.
 */
export async function syncUserPermissions(
  prisma: PrismaService,
  userId: string,
  permissionCodes: string[],
): Promise<string[]> {
  const sanitized = Array.from(
    new Set(permissionCodes.filter((code): code is PermissionCode => VALID_PERMISSION_CODES.has(code))),
  );

  // Asegurar que los permisos canónicos existan en la tabla Permission
  for (const def of PERMISSION_DEFINITIONS) {
    if (sanitized.includes(def.code)) {
      await prisma.permission.upsert({
        where: { code: def.code },
        update: {},
        create: {
          code: def.code,
          name: def.name,
          description: def.description,
          category: def.category,
        },
      });
    }
  }

  const dbPermissions =
    sanitized.length > 0
      ? await prisma.permission.findMany({
          where: { code: { in: sanitized } },
          select: { id: true, code: true },
        })
      : [];

  await prisma.$transaction(async (tx) => {
    await tx.userPermission.deleteMany({ where: { userId } });

    if (dbPermissions.length > 0) {
      await tx.userPermission.createMany({
        data: dbPermissions.map((perm) => ({
          userId,
          permissionId: perm.id,
        })),
        skipDuplicates: true,
      });
    }

    await tx.user.update({
      where: { id: userId },
      data: { useCustomPermissions: true },
    });
  });

  return dbPermissions.map((p) => p.code);
}

/**
 * Obtiene la empresa principal protegida del sistema (HelpCopies SRL).
 */
export async function getPrimaryTenant(prisma: PrismaService) {
  return (
    (await prisma.tenant.findFirst({
      where: { OR: [{ isSystem: true }, { slug: 'helpcopies' }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        isSystem: true,
        whatsappStatus: true,
        whatsappPhone: true,
        aiEnabled: true,
      },
    })) ??
    (await prisma.tenant.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        isSystem: true,
        whatsappStatus: true,
        whatsappPhone: true,
        aiEnabled: true,
      },
    }))
  );
}
