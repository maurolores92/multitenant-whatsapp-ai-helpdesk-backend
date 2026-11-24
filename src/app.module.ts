import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { ChatModule } from './chat/chat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AiModule } from './ai/ai.module';
import { TicketsModule } from './tickets/tickets.module';
import { TenantsModule } from './tenants/tenants.module';
import { AiTrainingModule } from './ai-training/ai-training.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    AuthModule,
    NotificationsModule,
    WhatsAppModule,
    ChatModule,
    AiModule,
    TicketsModule,
    TenantsModule,
    AiTrainingModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

