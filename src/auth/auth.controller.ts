import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  Ip,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register-tenant')
  async registerTenant(
    @Body() dto: RegisterTenantDto,
    @Ip() ipAddress: string,
  ) {
    return this.authService.registerTenant(dto, ipAddress);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Ip() ipAddress: string,
  ) {
    return this.authService.login(dto, ipAddress);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@CurrentUser('id') userId: string) {
    return this.authService.getMe(userId);
  }
}
