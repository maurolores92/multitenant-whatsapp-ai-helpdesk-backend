import { Module, forwardRef } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [forwardRef(() => WhatsAppModule), forwardRef(() => AiModule)],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
