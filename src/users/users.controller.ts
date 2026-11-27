import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Listar usuarios del tenant actual (o filtrar por tenant si es Superadmin)
   */
  @Get()
  async findAll(@CurrentUser() user: any, @Query('tenantId') tenantId?: string) {
    return this.usersService.findAll(user, tenantId);
  }

  /**
   * Catálogo de permisos y módulos disponibles para asignar por usuario
   */
  @Get('permissions-catalog')
  async getPermissionsCatalog(@CurrentUser() user: any) {
    return this.usersService.getPermissionsCatalog(user);
  }

  /**
   * Detalle de un usuario
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.findOne(id, user);
  }

  /**
   * Crear nuevo usuario
   */
  @Post()
  async create(@Body() dto: CreateUserDto, @CurrentUser() user: any) {
    return this.usersService.create(dto, user);
  }

  /**
   * Modificar datos o rol del usuario
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.update(id, dto, user);
  }

  /**
   * Cambiar contraseña de un usuario
   */
  @Patch(':id/password')
  async changePassword(
    @Param('id') id: string,
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.changePassword(id, dto, user);
  }

  /**
   * Alternar estado Activo / Inactivo
   */
  @Patch(':id/toggle-status')
  async toggleStatus(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.toggleStatus(id, user);
  }
}
