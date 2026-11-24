import { IsString, IsNotEmpty, IsEmail, MinLength, IsOptional } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsOptional()
  @IsString()
  whatsappPhone?: string;

  @IsOptional()
  @IsString()
  whatsappPhoneNumberId?: string;

  @IsOptional()
  @IsString()
  whatsappAccessToken?: string;

  @IsString()
  @IsNotEmpty()
  adminName: string;

  @IsEmail()
  adminEmail: string;

  @IsString()
  @MinLength(6)
  adminPassword: string;
}
