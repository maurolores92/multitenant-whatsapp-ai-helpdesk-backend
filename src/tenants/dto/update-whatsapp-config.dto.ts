import { IsString, IsOptional } from 'class-validator';

export class UpdateWhatsAppConfigDto {
  @IsOptional()
  @IsString()
  whatsappPhoneNumberId?: string;

  @IsOptional()
  @IsString()
  whatsappWabaId?: string;

  @IsOptional()
  @IsString()
  whatsappAccessToken?: string;

  @IsOptional()
  @IsString()
  whatsappPhone?: string;
}
