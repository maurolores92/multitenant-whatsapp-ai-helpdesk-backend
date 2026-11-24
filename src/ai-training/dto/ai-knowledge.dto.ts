import { IsString, IsNotEmpty, IsOptional, IsArray, IsBoolean } from 'class-validator';

export class CreateAiKnowledgeDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsNotEmpty()
  answer: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[] = [];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;
}

export class UpdateAiKnowledgeDto {
  @IsString()
  @IsOptional()
  question?: string;

  @IsString()
  @IsOptional()
  answer?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
