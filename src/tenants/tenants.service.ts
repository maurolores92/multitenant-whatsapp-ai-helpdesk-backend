import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateTenantUserDto } from './dto/create-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';
import { UpdateWhatsAppConfigDto } from './dto/update-whatsapp-config.dto';
import { Role, WhatsAppStatus } from '@prisma/client';
import { resolveEffectivePermissions, syncUserPermissions } from '../auth/permissions.helper';
import { ensureDefaultTechnicalAgent } from '../agents/agents.helper';

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Obtiene la lista de la empresa única del sistema
   */
  async findAll() {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: {
          select: {
            users: true,
            customers: true,
            tickets: true,
            conversations: true,
          },
        },
        users: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,
            useCustomPermissions: true,
          },
        },
      },
    });

    return Promise.all(
      tenants.map(async (tenant) => ({
        ...tenant,
        users: await Promise.all(
          tenant.users.map(async (u) => ({
            ...u,
            permissions: await resolveEffectivePermissions(this.prisma, u),
          })),
        ),
      })),
    );
  }

  /**
   * Obtiene el detalle de una compañía por ID
   */
  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            customers: true,
            tickets: true,
            conversations: true,
          },
        },
        users: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,
            useCustomPermissions: true,
            createdAt: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    return {
      ...tenant,
      users: await Promise.all(
        tenant.users.map(async (u) => ({
          ...u,
          permissions: await resolveEffectivePermissions(this.prisma, u),
        })),
      ),
    };
  }

  /**
   * Bloquea la creación manual de nuevas compañías en modo mono-empresa
   */
  async create(_dto: CreateTenantDto, _currentUserId?: string) {
    throw new ForbiddenException(
      'El sistema opera en modo empresa única (HelpCopies SRL). No se pueden crear empresas manualmente.',
    );
  }

  /**
   * Protege la empresa sembrada del sistema contra eliminación
   */
  async remove(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, isSystem: true },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    if (tenant.isSystem || tenant.slug === 'helpcopies') {
      throw new ForbiddenException(
        `La empresa principal '${tenant.name}' está protegida por el sistema y nunca puede eliminarse.`,
      );
    }

    throw new ForbiddenException('La eliminación de empresas está deshabilitada en este entorno.');
  }

  /**
   * Agrega un nuevo usuario a una compañía específica
   */
  async createUser(tenantId: string, dto: CreateTenantUserDto, currentUserId?: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    const email = dto.email.toLowerCase().trim();

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException(`El correo '${email}' ya está registrado`);
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    const newUser = await this.prisma.user.create({
      data: {
        tenantId,
        name: dto.name,
        email,
        password: hashedPassword,
        role: dto.role,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        useCustomPermissions: true,
        createdAt: true,
      },
    });

    if (Array.isArray(dto.permissions) && newUser.role !== Role.SUPER_ADMIN) {
      await syncUserPermissions(this.prisma, newUser.id, dto.permissions);
    }

    const effectivePermissions = await resolveEffectivePermissions(this.prisma, {
      ...newUser,
      useCustomPermissions:
        Array.isArray(dto.permissions) && newUser.role !== Role.SUPER_ADMIN
          ? true
          : newUser.useCustomPermissions,
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'USER_CREATED',
      entity: 'User',
      entityId: newUser.id,
      payload: {
        userName: newUser.name,
        userEmail: newUser.email,
        role: newUser.role,
        permissions: effectivePermissions,
      },
    });

    this.logger.log(`✔ Usuario ${newUser.name} (${newUser.role}) agregado a la compañía ${tenant.name}`);

    return {
      ...newUser,
      permissions: effectivePermissions,
    };
  }

  /**
   * Actualiza la configuración oficial de WhatsApp Cloud API para la compañía
   */
  async updateWhatsAppConfig(tenantId: string, dto: UpdateWhatsAppConfigDto, currentUserId?: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    const isConnected = Boolean(dto.whatsappPhoneNumberId?.trim() && dto.whatsappAccessToken?.trim());

    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        whatsappPhoneNumberId: dto.whatsappPhoneNumberId?.trim() || null,
        whatsappWabaId: dto.whatsappWabaId?.trim() || null,
        whatsappAccessToken: dto.whatsappAccessToken?.trim() || null,
        whatsappPhone: dto.whatsappPhone?.trim() || null,
        whatsappStatus: isConnected ? WhatsAppStatus.CONNECTED : WhatsAppStatus.DISCONNECTED,
      },
    });

    const defaultAgent = await ensureDefaultTechnicalAgent(this.prisma, tenantId);
    if (defaultAgent) {
      await this.prisma.whatsAppAgent.update({
        where: { id: defaultAgent.id },
        data: {
          whatsappPhoneNumberId: updated.whatsappPhoneNumberId,
          whatsappWabaId: updated.whatsappWabaId,
          whatsappAccessToken: updated.whatsappAccessToken,
          whatsappPhone: updated.whatsappPhone,
          whatsappStatus: updated.whatsappStatus,
        },
      });
    }

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'WHATSAPP_CONFIG_UPDATED',
      entity: 'Tenant',
      entityId: tenantId,
      payload: {
        whatsappPhone: updated.whatsappPhone,
        whatsappPhoneNumberId: updated.whatsappPhoneNumberId,
        whatsappWabaId: updated.whatsappWabaId,
        hasAccessToken: Boolean(updated.whatsappAccessToken),
        status: updated.whatsappStatus,
      },
    });

    this.logger.log(
      `✔ Configuración de WhatsApp actualizada para '${tenant.name}' (Estado: ${updated.whatsappStatus})`,
    );

    return updated;
  }

  /**
   * Actualiza los datos de un usuario de una compañía (Nombre, Email, Rol, Contraseña opcional)
   */
  async updateUser(
    tenantId: string,
    userId: string,
    dto: UpdateTenantUserDto,
    currentUserId?: string,
  ) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado en esta compañía');
    }

    const dataToUpdate: any = {};

    if (dto.name?.trim()) {
      dataToUpdate.name = dto.name.trim();
    }

    if (dto.email?.trim()) {
      const email = dto.email.toLowerCase().trim();
      if (email !== user.email) {
        const existing = await this.prisma.user.findUnique({
          where: { email },
        });
        if (existing) {
          throw new ConflictException(`El correo '${email}' ya pertenece a otro usuario`);
        }
        dataToUpdate.email = email;
      }
    }

    if (dto.role) {
      dataToUpdate.role = dto.role;
    }

    if (dto.password && dto.password.length >= 6) {
      const salt = await bcrypt.genSalt(10);
      dataToUpdate.password = await bcrypt.hash(dto.password, salt);
    }

    if (typeof dto.isActive === 'boolean') {
      if (currentUserId === userId && !dto.isActive) {
        throw new BadRequestException('No puedes inactivar tu propia cuenta');
      }
      dataToUpdate.isActive = dto.isActive;
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        useCustomPermissions: true,
        createdAt: true,
      },
    });

    let useCustom = updatedUser.useCustomPermissions;
    if (Array.isArray(dto.permissions) && updatedUser.role !== Role.SUPER_ADMIN) {
      await syncUserPermissions(this.prisma, updatedUser.id, dto.permissions);
      useCustom = true;
    }

    const effectivePermissions = await resolveEffectivePermissions(this.prisma, {
      ...updatedUser,
      useCustomPermissions: useCustom,
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'USER_UPDATED',
      entity: 'User',
      entityId: updatedUser.id,
      payload: {
        updatedFields: Object.keys(dataToUpdate),
        userName: updatedUser.name,
        userEmail: updatedUser.email,
        role: updatedUser.role,
        isActive: updatedUser.isActive,
        permissions: effectivePermissions,
      },
    });

    this.logger.log(`✔ Usuario ${updatedUser.name} (${updatedUser.email}) actualizado en compañía ID ${tenantId}`);

    return {
      ...updatedUser,
      useCustomPermissions: useCustom,
      permissions: effectivePermissions,
    };
  }

  /**
   * Alterna el estado activo/inactivo de un usuario
   */
  async toggleUserStatus(tenantId: string, userId: string, currentUserId?: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado en esta compañía');
    }

    if (currentUserId === userId) {
      throw new BadRequestException('No puedes inactivar tu propia cuenta');
    }

    const newStatus = !user.isActive;

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: newStatus },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: newStatus ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entity: 'User',
      entityId: updatedUser.id,
      payload: {
        userName: updatedUser.name,
        userEmail: updatedUser.email,
        newStatus,
      },
    });

    this.logger.log(
      `✔ Estado de usuario ${updatedUser.name} cambiado a ${newStatus ? 'ACTIVO' : 'INACTIVO'}`,
    );

    return updatedUser;
  }
}
