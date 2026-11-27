import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateTenantUserDto } from './dto/create-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';
import { UpdateWhatsAppConfigDto } from './dto/update-whatsapp-config.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@Controller('tenants')
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  /**
   * Listado de todas las compañías (Exclusivo Superadmin)
   */
  @Get()
  async findAll(@CurrentUser() user: any) {
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Solo el Superadministrador puede consultar todas las compañías');
    }
    return this.tenantsService.findAll();
  }

  /**
   * Detalle de una compañía específica
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    if (user.role !== Role.SUPER_ADMIN && user.tenantId !== id) {
      throw new ForbiddenException('No estás autorizado para consultar esta compañía');
    }
    return this.tenantsService.findOne(id);
  }

  /**
   * Creación manual de compañías deshabilitada (modo empresa única HelpCopies SRL)
   */
  @Post()
  async create(@Body() dto: CreateTenantDto, @CurrentUser() user: any) {
    return this.tenantsService.create(dto, user.id);
  }

  /**
   * Protección explícita contra eliminación de la empresa principal
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('No autorizado');
    }
    return this.tenantsService.remove(id);
  }

  /**
   * Crear un nuevo usuario dentro de una compañía
   */
  @Post(':id/users')
  async createUser(
    @Param('id') id: string,
    @Body() dto: CreateTenantUserDto,
    @CurrentUser() user: any,
  ) {
    // Permitido a SUPER_ADMIN o al ADMIN de esa compañía
    if (user.role !== Role.SUPER_ADMIN && (user.role !== Role.ADMIN || user.tenantId !== id)) {
      throw new ForbiddenException('No tienes permisos para crear usuarios en esta compañía');
    }
    return this.tenantsService.createUser(id, dto, user.id);
  }

  /**
   * Modificar datos de un usuario de una compañía
   */
  @Patch(':id/users/:userId')
  async updateUser(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateTenantUserDto,
    @CurrentUser() user: any,
  ) {
    if (user.role !== Role.SUPER_ADMIN && (user.role !== Role.ADMIN || user.tenantId !== id)) {
      throw new ForbiddenException('No tienes permisos para modificar usuarios en esta compañía');
    }
    return this.tenantsService.updateUser(id, userId, dto, user.id);
  }

  /**
   * Activar / Inactivar un usuario de una compañía
   */
  @Patch(':id/users/:userId/toggle-status')
  async toggleUserStatus(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: any,
  ) {
    if (user.role !== Role.SUPER_ADMIN && (user.role !== Role.ADMIN || user.tenantId !== id)) {
      throw new ForbiddenException('No tienes permisos para cambiar el estado de este usuario');
    }
    return this.tenantsService.toggleUserStatus(id, userId, user.id);
  }

  /**
   * Configurar credenciales de Meta WhatsApp Business Cloud API para la compañía
   */
  @Patch(':id/whatsapp-config')
  async updateWhatsAppConfig(
    @Param('id') id: string,
    @Body() dto: UpdateWhatsAppConfigDto,
    @CurrentUser() user: any,
  ) {
    if (user.role !== Role.SUPER_ADMIN && (user.role !== Role.ADMIN || user.tenantId !== id)) {
      throw new ForbiddenException(
        'No tienes permisos para modificar la configuración de WhatsApp de esta compañía',
      );
    }
    return this.tenantsService.updateWhatsAppConfig(id, dto, user.id);
  }
}
