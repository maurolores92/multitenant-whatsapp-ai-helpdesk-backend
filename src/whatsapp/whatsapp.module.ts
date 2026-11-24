import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MetaCloudApiService } from './providers/meta-cloud-api.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
    forwardRef(() => ChatModule),
  ],
  controllers: [WhatsAppWebhookController],
  providers: [MetaCloudApiService],
  exports: [MetaCloudApiService],
})
export class WhatsAppModule {}
