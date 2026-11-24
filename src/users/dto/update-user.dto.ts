import { IsString, IsOptional, IsEmail, IsEnum, IsBoolean } from 'class-validator';
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
}
