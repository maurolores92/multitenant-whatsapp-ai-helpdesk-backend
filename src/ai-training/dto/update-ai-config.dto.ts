import { IsString, IsOptional, IsNumber, IsBoolean, Min, Max } from 'class-validator';

export class UpdateAiConfigDto {
  @IsString()
  @IsOptional()
  geminiApiKey?: string;

  @IsString()
  @IsOptional()
  geminiModel?: string;

  @IsNumber()
  @Min(0.0)
  @Max(1.0)
  @IsOptional()
  aiTemperature?: number;

  @IsString()
  @IsOptional()
  aiSystemPrompt?: string;

  @IsBoolean()
  @IsOptional()
  aiEnabled?: boolean;
}
