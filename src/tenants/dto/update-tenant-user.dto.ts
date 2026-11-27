import { IsString, IsOptional, IsEmail, MinLength, IsEnum, IsBoolean, IsArray } from 'class-validator';
import { Role } from '@prisma/client';

export class UpdateTenantUserDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @MinLength(6)
  @IsOptional()
  password?: string;

  @IsEnum(Role)
  @IsOptional()
  role?: Role;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];
}
