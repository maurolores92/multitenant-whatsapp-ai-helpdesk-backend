import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RegisterTenantDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la empresa es obligatorio' })
  companyName: string;

  @IsString()
  @IsNotEmpty({ message: 'El slug/identificador de la empresa es obligatorio' })
  companySlug: string;

  @IsString()
  @IsNotEmpty({ message: 'El nombre del administrador es obligatorio' })
  adminName: string;

  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  @IsNotEmpty({ message: 'El email del administrador es obligatorio' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  password: string;
}
