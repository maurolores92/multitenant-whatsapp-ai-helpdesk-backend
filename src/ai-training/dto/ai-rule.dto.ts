import { IsString, IsNotEmpty, IsEnum, IsOptional, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { AiRuleCategory } from '@prisma/client';

export class CreateAiRuleDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  instruction: string;

  @IsEnum(AiRuleCategory)
  @IsOptional()
  category?: AiRuleCategory = AiRuleCategory.BUSINESS;

  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  priority?: number = 1;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;
}

export class UpdateAiRuleDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  instruction?: string;

  @IsEnum(AiRuleCategory)
  @IsOptional()
  category?: AiRuleCategory;

  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  priority?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
