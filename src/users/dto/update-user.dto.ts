import { IsString, IsOptional, IsEmail, IsEnum, IsBoolean, IsArray } from 'class-validator';
import { Role } from '@prisma/client';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  @IsOptional()
  email?: string;

  @IsEnum(Role, { message: 'El rol especificado no es válido' })
  @IsOptional()
  role?: Role;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];

  @IsBoolean()
  @IsOptional()
  useCustomPermissions?: boolean;
}
