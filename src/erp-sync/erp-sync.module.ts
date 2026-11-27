import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ErpSyncService } from './erp-sync.service';
import { ErpSyncController } from './erp-sync.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
  ],
  controllers: [ErpSyncController],
  providers: [ErpSyncService],
  exports: [ErpSyncService],
})
export class ErpSyncModule {}
