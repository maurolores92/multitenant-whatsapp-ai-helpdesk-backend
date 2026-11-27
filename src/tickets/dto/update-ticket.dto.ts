import {
  IsString,
  IsOptional,
  IsEnum,
  IsDateString,
} from 'class-validator';
import {
  ServiceType,
  TicketPriority,
  TicketStatus,
  TicketReason,
} from '@prisma/client';

export class UpdateTicketDto {
  @IsString()
  @IsOptional()
  customerId?: string;

  @IsString()
  @IsOptional()
  equipmentId?: string | null;

  @IsEnum(TicketStatus)
  @IsOptional()
  status?: TicketStatus;

  @IsEnum(TicketPriority)
  @IsOptional()
  priority?: TicketPriority;

  @IsEnum(ServiceType)
  @IsOptional()
  serviceType?: ServiceType;

  @IsEnum(TicketReason)
  @IsOptional()
  reason?: TicketReason;

  @IsString()
  @IsOptional()
  problemTypeId?: string | null;

  @IsString()
  @IsOptional()
  serviceOrderNumber?: string;

  @IsString()
  @IsOptional()
  assignedTechnicianId?: string | null;

  @IsString()
  @IsOptional()
  resolutionNotes?: string;

  @IsDateString()
  @IsOptional()
  scheduledDate?: string | null;
}
