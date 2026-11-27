import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { LoginDto } from './dto/login.dto';
import { Role } from '@prisma/client';
import { getPrimaryTenant, resolveEffectivePermissions } from './permissions.helper';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Registro de nuevas empresas deshabilitado (modo empresa única HelpCopies SRL)
   */
  async registerTenant(_dto: RegisterTenantDto, _ipAddress?: string) {
    throw new ForbiddenException(
      'El sistema opera en modo empresa única (HelpCopies SRL). No está permitido registrar nuevas empresas.',
    );
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

    const permissions = await resolveEffectivePermissions(this.prisma, user);
    const effectiveTenant =
      user.tenant ?? (user.role === Role.SUPER_ADMIN ? await getPrimaryTenant(this.prisma) : null);
    const effectiveTenantId = user.tenantId ?? effectiveTenant?.id ?? null;

    // Registro de Auditoría
    if (effectiveTenantId) {
      await this.auditService.log({
        tenantId: effectiveTenantId,
        userId: user.id,
        action: 'LOGIN',
        entity: 'User',
        entityId: user.id,
        ipAddress,
      });
    }

    const accessToken = this.generateToken({
      id: user.id,
      email: user.email,
      tenantId: effectiveTenantId,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: effectiveTenantId,
      },
      tenant: effectiveTenant
        ? {
            id: effectiveTenant.id,
            name: effectiveTenant.name,
            slug: effectiveTenant.slug,
            whatsappStatus: effectiveTenant.whatsappStatus,
            whatsappPhone: effectiveTenant.whatsappPhone,
            aiEnabled: effectiveTenant.aiEnabled,
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

    const permissions = await resolveEffectivePermissions(this.prisma, user);
    const effectiveTenant =
      user.tenant ?? (user.role === Role.SUPER_ADMIN ? await getPrimaryTenant(this.prisma) : null);
    const effectiveTenantId = user.tenantId ?? effectiveTenant?.id ?? null;

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: effectiveTenantId,
      },
      tenant: effectiveTenant,
      permissions,
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
