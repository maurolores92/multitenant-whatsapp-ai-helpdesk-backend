import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { ErpAuthType } from '@prisma/client';

export class UpdateErpConfigDto {
  @IsString()
  @IsOptional()
  baseUrl?: string;

  @IsEnum(ErpAuthType)
  @IsOptional()
  authType?: ErpAuthType;

  @IsString()
  @IsOptional()
  apiKey?: string;

  @IsString()
  @IsOptional()
  apiKeyHeader?: string;

  @IsString()
  @IsOptional()
  loginEndpoint?: string;

  @IsString()
  @IsOptional()
  username?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  customersEndpoint?: string;

  @IsString()
  @IsOptional()
  equipmentsEndpoint?: string;

  @IsString()
  @IsOptional()
  problemsEndpoint?: string;

  @IsBoolean()
  @IsOptional()
  autoSyncMonthly?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
