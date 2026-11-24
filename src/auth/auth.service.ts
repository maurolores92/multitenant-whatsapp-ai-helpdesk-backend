import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { LoginDto } from './dto/login.dto';
import { Role } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Registra una nueva empresa (Tenant) con su usuario administrador inicial
   */
  async registerTenant(dto: RegisterTenantDto, ipAddress?: string) {
    // 1. Validar que el slug no esté en uso
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: dto.companySlug.toLowerCase().trim() },
    });

    if (existingTenant) {
      throw new ConflictException('El identificador (slug) de la empresa ya está en uso');
    }

    // 2. Hash de contraseña seguro
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    // 3. Crear Tenant y Usuario Administrador en una transacción atómica
    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.companyName,
          slug: dto.companySlug.toLowerCase().trim(),
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          name: dto.adminName,
          email: dto.email.toLowerCase().trim(),
          password: hashedPassword,
          role: Role.ADMIN,
        },
      });

      return { tenant, user };
    });

    // 4. Registro de Auditoría
    await this.auditService.log({
      tenantId: result.tenant.id,
      userId: result.user.id,
      action: 'TENANT_REGISTERED',
      entity: 'Tenant',
      entityId: result.tenant.id,
      payload: { companyName: result.tenant.name, adminEmail: result.user.email },
      ipAddress,
    });

    // 5. Generar Token JWT
    const token = this.generateToken(result.user);

    return {
      message: 'Empresa y usuario administrador registrados exitosamente',
      accessToken: token,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
        tenantId: result.tenant.id,
      },
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
      },
    };
  }

  /**
   * Inicio de sesión de un operador o administrador
   */
  async login(dto: LoginDto, ipAddress?: string) {
    const email = dto.email.toLowerCase().trim();

    // Buscar usuario por email
    const user = await this.prisma.user.findFirst({
      where: { email },
      include: {
        tenant: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (!user.isActive || (user.tenant && !user.tenant.isActive)) {
      throw new UnauthorizedException('La cuenta o la empresa asociada se encuentra inactiva');
    }

    // Comparar contraseña
    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Cargar permisos correspondientes al rol
    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { role: user.role },
      include: {
        permission: {
          select: { code: true },
        },
      },
    });

    const permissions = rolePermissions.map((rp) => rp.permission.code);

    // Registro de Auditoría
    if (user.tenantId) {
      await this.auditService.log({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'LOGIN',
        entity: 'User',
        entityId: user.id,
        ipAddress,
      });
    }

    const accessToken = this.generateToken(user);

    return {
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
      },
      tenant: user.tenant
        ? {
            id: user.tenant.id,
            name: user.tenant.name,
            slug: user.tenant.slug,
            whatsappStatus: user.tenant.whatsappStatus,
            whatsappPhone: user.tenant.whatsappPhone,
          }
        : null,
      permissions,
    };
  }

  /**
   * Obtener perfil del usuario actualmente autenticado
   */
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            whatsappStatus: true,
            whatsappPhone: true,
            aiEnabled: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { role: user.role },
      include: {
        permission: {
          select: { code: true, name: true, category: true },
        },
      },
    });

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
      },
      tenant: user.tenant,
      permissions: rolePermissions.map((rp) => rp.permission.code),
    };
  }

  private generateToken(user: { id: string; email: string; tenantId?: string | null; role: Role }): string {
    const payload = {
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId || null,
      role: user.role,
    };

    return this.jwtService.sign(payload);
  }
}
