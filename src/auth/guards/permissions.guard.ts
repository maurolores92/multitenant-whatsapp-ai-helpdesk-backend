import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { PermissionCode } from '../constants/permissions.constant';
import { Role } from '@prisma/client';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<PermissionCode[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Si la ruta no especifica permisos requeridos, se permite el acceso
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      throw new ForbiddenException('Usuario no autenticado para verificar permisos');
    }

    // SuperAdmin tiene acceso irrestricto a toda la plataforma
    if (user.role === Role.SUPER_ADMIN) {
      return true;
    }

    const userPermissions: string[] = user.permissions ?? [];

    const hasAllPermissions = requiredPermissions.every((perm) =>
      userPermissions.includes(perm),
    );

    if (!hasAllPermissions) {
      throw new ForbiddenException(
        `Permiso denegado. Se requiere: [${requiredPermissions.join(', ')}]`,
      );
    }

    return true;
  }
}
