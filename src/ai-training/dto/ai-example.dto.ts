import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

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

export class SimulateAiDto {
  @IsString()
  @IsNotEmpty()
  message: string;
}
