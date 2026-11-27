import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';
import { getPrimaryTenant, resolveEffectivePermissions } from '../permissions.helper';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET', 'super-secret-jwt-key-change-in-production'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
        },
      },
    });

    if (!user || !user.isActive || (user.tenant && !user.tenant.isActive)) {
      throw new UnauthorizedException('Usuario o empresa inactiva/no autorizada');
    }

    const permissions = await resolveEffectivePermissions(this.prisma, user);
    const effectiveTenant =
      user.tenant ?? (user.role === Role.SUPER_ADMIN ? await getPrimaryTenant(this.prisma) : null);

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId ?? effectiveTenant?.id ?? null,
      tenant: effectiveTenant,
      permissions,
    };
  }
}
