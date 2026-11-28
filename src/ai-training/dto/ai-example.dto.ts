import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsArray, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAiExampleDto {
  @IsString()
  @IsNotEmpty()
  customerInput: string;

  @IsString()
  @IsNotEmpty()
  idealResponse: string;

  @IsString()
  @IsOptional()
  topic?: string;

  @IsBoolean()
  @IsOptional()
  isApproved?: boolean = true;
}

export class SimulateMessageItemDto {
  @IsIn(['user', 'bot'])
  sender: 'user' | 'bot';

  @IsString()
  @IsNotEmpty()
  text: string;

  @IsString()
  @IsOptional()
  timestamp?: string;

  @IsString()
  @IsOptional()
  imageDataUrl?: string;
}

export class SimulateAiDto {
  @IsString()
  @IsOptional()
  message?: string;

  @IsString()
  @IsOptional()
  imageBase64?: string;

  @IsString()
  @IsOptional()
  imageMimeType?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SimulateMessageItemDto)
  @IsOptional()
  history?: SimulateMessageItemDto[];
}
