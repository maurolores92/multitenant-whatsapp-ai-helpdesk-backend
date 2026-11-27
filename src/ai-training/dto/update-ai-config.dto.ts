import { IsString, IsOptional, IsNumber, IsBoolean, IsInt, Min, Max } from 'class-validator';

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

  @IsInt()
  @Min(1)
  @Max(168)
  @IsOptional()
  aiContextHours?: number;

  @IsInt()
  @Min(0)
  @Max(300)
  @IsOptional()
  aiResponseDelaySeconds?: number;
}
