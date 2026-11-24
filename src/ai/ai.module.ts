import { Module, forwardRef } from '@nestjs/common';
import { AiSupportService } from './ai-support.service';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [forwardRef(() => WhatsAppModule)],
  providers: [AiSupportService],
  exports: [AiSupportService],
})
export class AiModule {}
