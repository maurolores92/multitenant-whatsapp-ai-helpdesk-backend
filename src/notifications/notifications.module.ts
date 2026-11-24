import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [EventsGateway, NotificationsService],
  exports: [EventsGateway, NotificationsService],
})
export class NotificationsModule {}
