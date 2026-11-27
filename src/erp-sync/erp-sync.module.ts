import * as http from 'node:http';
import * as https from 'node:https';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ErpSyncService } from './erp-sync.service';
import { ErpSyncController } from './erp-sync.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
      // Forzar IPv4 para evitar timeouts de IPv6 dentro de contenedores Docker sin salida IPv6
      httpAgent: new http.Agent({ family: 4 }),
      httpsAgent: new https.Agent({ family: 4 }),
    }),
  ],
  controllers: [ErpSyncController],
  providers: [ErpSyncService],
  exports: [ErpSyncService],
})
export class ErpSyncModule {}
