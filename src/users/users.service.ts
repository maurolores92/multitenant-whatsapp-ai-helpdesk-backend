import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Role } from '@prisma/client';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Obtiene la lista de usuarios de la compañía actual (o todas si es Superadmin)
   */
  async findAll(currentUser: any, queryTenantId?: string) {
    if (currentUser.role !== Role.SUPER_ADMIN && currentUser.role !== Role.ADMIN) {
      throw new ForbiddenException('Solo administradores pueden consultar el listado de usuarios');
    }

    const where: any = {};

    if (currentUser.role === Role.ADMIN) {
      if (!currentUser.tenantId) {
        throw new ForbiddenException('El usuario administrador no tiene una compañía asociada');
      }
      where.tenantId = currentUser.tenantId;
    } else if (currentUser.role === Role.SUPER_ADMIN && queryTenantId) {
      where.tenantId = queryTenantId;
    }

    return this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        tenantId: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });
  }

  /**
   * Obtiene el detalle de un usuario específico
   */
  async findOne(id: string, currentUser: any) {
    if (currentUser.role !== Role.SUPER_ADMIN && currentUser.role !== Role.ADMIN) {
      throw new ForbiddenException('Solo administradores pueden consultar el detalle de un usuario');
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        tenantId: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (currentUser.role === Role.ADMIN && user.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('No tienes permisos para consultar este usuario');
    }

    return user;
  }

  /**
   * Crea un nuevo usuario en la empresa
   */
  async create(dto: CreateUserDto, currentUser: any) {
    if (currentUser.role !== Role.SUPER_ADMIN && currentUser.role !== Role.ADMIN) {
      throw new ForbiddenException('Solo administradores pueden dar de alta nuevos usuarios');
    }

    const targetTenantId =
      currentUser.role === Role.SUPER_ADMIN ? dto.tenantId || currentUser.tenantId : currentUser.tenantId;

    if (!targetTenantId) {
      throw new BadRequestException('Se requiere una compañía válida para dar de alta al usuario');
    }

    // Un admin de tenant no puede asignar rol SUPER_ADMIN
    if (currentUser.role !== Role.SUPER_ADMIN && dto.role === Role.SUPER_ADMIN) {
      throw new ForbiddenException('Solo el Superadministrador puede asignar el rol SUPER_ADMIN');
    }

    const email = dto.email.toLowerCase().trim();

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException(`El correo electrónico '${email}' ya está registrado en el sistema`);
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    const newUser = await this.prisma.user.create({
      data: {
        tenantId: targetTenantId,
        name: dto.name.trim(),
        email,
        password: hashedPassword,
        role: dto.role,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        tenantId: true,
      },
    });

    await this.auditService.log({
      tenantId: targetTenantId,
      userId: currentUser.id,
      action: 'USER_CREATED',
      entity: 'User',
      entityId: newUser.id,
      payload: {
        userName: newUser.name,
        userEmail: newUser.email,
        role: newUser.role,
      },
    });

    this.logger.log(`✔ Usuario creado: ${newUser.name} (${newUser.email}) con rol ${newUser.role}`);

    return newUser;
  }

  /**
   * Modifica los datos básicos o rol de un usuario existente
   */
  async update(id: string, dto: UpdateUserDto, currentUser: any) {
    if (currentUser.role !== Role.SUPER_ADMIN && currentUser.role !== Role.ADMIN) {
      throw new ForbiddenException('Solo administradores pueden modificar usuarios');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (currentUser.role === Role.ADMIN && existingUser.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('No tienes permisos para modificar usuarios de otra compañía');
    }

    // No permitir asignar SUPER_ADMIN si no es Superadmin
    if (dto.role === Role.SUPER_ADMIN && currentUser.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('No tienes permisos para asignar el rol SUPER_ADMIN');
    }

    const dataToUpdate: any = {};

    if (dto.name?.trim()) {
      dataToUpdate.name = dto.name.trim();
    }

    if (dto.email?.trim()) {
      const email = dto.email.toLowerCase().trim();
      if (email !== existingUser.email) {
        const emailExists = await this.prisma.user.findUnique({
          where: { email },
        });
        if (emailExists) {
          throw new ConflictException(`El correo '${email}' ya pertenece a otro usuario`);
        }
        dataToUpdate.email = email;
      }
    }

    if (dto.role) {
      dataToUpdate.role = dto.role;
    }

    if (typeof dto.isActive === 'boolean') {
      if (currentUser.id === id && !dto.isActive) {
        throw new BadRequestException('No puedes inactivar tu propia cuenta de usuario');
      }
      dataToUpdate.isActive = dto.isActive;
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: dataToUpdate,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        tenantId: true,
      },
    });

    if (existingUser.tenantId) {
      await this.auditService.log({
        tenantId: existingUser.tenantId,
        userId: currentUser.id,
        action: 'USER_UPDATED',
        entity: 'User',
        entityId: updatedUser.id,
        payload: {
          updatedFields: Object.keys(dataToUpdate),
          userName: updatedUser.name,
          userEmail: updatedUser.email,
          role: updatedUser.role,
          isActive: updatedUser.isActive,
        },
      });
    }

    this.logger.log(`✔ Usuario actualizado: ${updatedUser.name} (${updatedUser.email})`);

    return updatedUser;
  }

  /**
   * Modifica la contraseña de un usuario
   */
  async changePassword(id: string, dto: ChangePasswordDto, currentUser: any) {
    if (currentUser.role !== Role.SUPER_ADMIN && currentUser.role !== Role.ADMIN) {
      throw new ForbiddenException('Solo administradores pueden cambiar contraseñas de usuarios');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (currentUser.role === Role.ADMIN && existingUser.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('No tienes permisos para modificar este usuario');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.newPassword, salt);

    await this.prisma.user.update({
      where: { id },
      data: { password: hashedPassword },
    });

    if (existingUser.tenantId) {
      await this.auditService.log({
        tenantId: existingUser.tenantId,
        userId: currentUser.id,
        action: 'USER_PASSWORD_CHANGED',
        entity: 'User',
        entityId: existingUser.id,
        payload: {
          targetUserEmail: existingUser.email,
          targetUserName: existingUser.name,
        },
      });
    }

    this.logger.log(`✔ Contraseña actualizada para el usuario ${existingUser.name} (${existingUser.email})`);

    return { message: 'Contraseña actualizada exitosamente' };
  }

  /**
   * Alterna el estado activo / inactivo de un usuario
   */
  async toggleStatus(id: string, currentUser: any) {
    if (currentUser.role !== Role.SUPER_ADMIN && currentUser.role !== Role.ADMIN) {
      throw new ForbiddenException('Solo administradores pueden alternar el estado de usuarios');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (currentUser.role === Role.ADMIN && existingUser.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('No tienes permisos para modificar este usuario');
    }

    if (currentUser.id === id) {
      throw new BadRequestException('No puedes inactivar tu propia cuenta');
    }

    const newStatus = !existingUser.isActive;

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { isActive: newStatus },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        tenantId: true,
      },
    });

    if (existingUser.tenantId) {
      await this.auditService.log({
        tenantId: existingUser.tenantId,
        userId: currentUser.id,
        action: newStatus ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
        entity: 'User',
        entityId: updatedUser.id,
        payload: {
          userName: updatedUser.name,
          userEmail: updatedUser.email,
          newStatus,
        },
      });
    }

    return updatedUser;
  }
}
