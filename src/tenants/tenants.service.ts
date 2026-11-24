import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
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

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Obtiene la lista completa de compañías (Exclusivo Superadmin)
   */
  async findAll() {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
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
          },
        },
      },
    });
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
            createdAt: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Compañía no encontrada');
    }

    return tenant;
  }

  /**
   * Crea una nueva compañía y su usuario Administrador inicial
   */
  async create(dto: CreateTenantDto, currentUserId?: string) {
    const slug = dto.slug.toLowerCase().trim();
    const adminEmail = dto.adminEmail.toLowerCase().trim();

    // 1. Validar slug único
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug },
    });
    if (existingTenant) {
      throw new ConflictException(`El slug '${slug}' ya está en uso`);
    }

    // 2. Validar email único de administrador
    const existingUser = await this.prisma.user.findUnique({
      where: { email: adminEmail },
    });
    if (existingUser) {
      throw new ConflictException(`El correo '${adminEmail}' ya está registrado en el sistema`);
    }

    // 3. Hash seguro de la contraseña
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.adminPassword, salt);

    // 4. Crear Tenant y Usuario Administrador en una sola transacción
    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.name,
          slug,
          whatsappPhone: dto.whatsappPhone || null,
          whatsappPhoneNumberId: dto.whatsappPhoneNumberId || null,
          whatsappAccessToken: dto.whatsappAccessToken || null,
        },
      });

      const adminUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          name: dto.adminName,
          email: adminEmail,
          password: hashedPassword,
          role: Role.ADMIN,
        },
      });

      return { tenant, adminUser };
    });

    // 5. Registro de Auditoría
    await this.auditService.log({
      tenantId: result.tenant.id,
      userId: currentUserId,
      action: 'TENANT_CREATED',
      entity: 'Tenant',
      entityId: result.tenant.id,
      payload: {
        tenantName: result.tenant.name,
        adminEmail: result.adminUser.email,
      },
    });

    this.logger.log(`✔ Compañía creada: ${result.tenant.name} con Admin ${result.adminUser.email}`);

    return result;
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
        createdAt: true,
      },
    });

    await this.auditService.log({
      tenantId,
      userId: currentUserId,
      action: 'USER_CREATED',
      entity: 'User',
      entityId: newUser.id,
      payload: { userName: newUser.name, userEmail: newUser.email, role: newUser.role },
    });

    this.logger.log(`✔ Usuario ${newUser.name} (${newUser.role}) agregado a la compañía ${tenant.name}`);

    return newUser;
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
        createdAt: true,
      },
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
      },
    });

    this.logger.log(`✔ Usuario ${updatedUser.name} (${updatedUser.email}) actualizado en compañía ID ${tenantId}`);

    return updatedUser;
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
