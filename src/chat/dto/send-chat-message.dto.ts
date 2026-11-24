import { IsNotEmpty, IsString } from 'class-validator';

export class SendChatMessageDto {
  @IsString()
  @IsNotEmpty({ message: 'El contenido del mensaje no puede estar vacío' })
  content: string;
}
