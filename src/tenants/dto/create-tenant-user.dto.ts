import { IsString, IsNotEmpty, IsEmail, MinLength, IsEnum, IsOptional, IsArray } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateTenantUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsEnum(Role)
  role: Role;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];
}
