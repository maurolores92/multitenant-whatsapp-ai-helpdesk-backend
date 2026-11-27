import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AgentArea } from '@prisma/client';

export class CreateAgentDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre del agente es obligatorio' })
  name: string;

  @IsString()
  @IsOptional()
  code?: string;

  @IsEnum(AgentArea)
  @IsOptional()
  area?: AgentArea;

  @IsString()
  @IsOptional()
  whatsappPhone?: string;

  @IsString()
  @IsOptional()
  whatsappPhoneNumberId?: string;

  @IsString()
  @IsOptional()
  whatsappWabaId?: string;

  @IsString()
  @IsOptional()
  whatsappAccessToken?: string;

  @IsBoolean()
  @IsOptional()
  aiEnabled?: boolean;

  @IsString()
  @IsOptional()
  aiSystemPrompt?: string;
}

export class UpdateAgentDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsEnum(AgentArea)
  @IsOptional()
  area?: AgentArea;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
