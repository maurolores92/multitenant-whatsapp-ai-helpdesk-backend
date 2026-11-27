import { IsString, IsNotEmpty, IsEmail, MinLength, IsEnum, IsOptional, IsArray } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name: string;

  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  password: string;

  @IsEnum(Role, { message: 'El rol especificado no es válido' })
  role: Role;

  @IsString()
  @IsOptional()
  tenantId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];
}
