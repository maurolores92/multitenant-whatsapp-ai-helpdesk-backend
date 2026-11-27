import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ErpSyncService } from './erp-sync.service';
import { ErpSyncController } from './erp-sync.controller';

const coolifyProxyDomains = new Set(
  (process.env.ERP_PROXY_DOMAINS || 'api.helpcopies.com')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Resuelve dominios alojados en el mismo servidor Coolify a través de `coolify-proxy`
 * dentro de la red interna Docker (evitando Hairpin NAT) y hace fallback a DNS IPv4 normal.
 */
const erpDnsLookup: LookupFunction = (hostname, options, callback) => {
  const opts = { ...options, family: 4 } as dns.LookupOptions;

  if (!coolifyProxyDomains.has(hostname.toLowerCase())) {
    return dns.lookup(hostname, opts, callback as any);
  }

  dns.lookup('coolify-proxy', opts, (proxyErr, address, family) => {
    if (!proxyErr) {
      return (callback as any)(null, address, family);
    }
    return dns.lookup(hostname, opts, callback as any);
  });
};

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
      // Forzar IPv4 y enrutar dominios internos vía coolify-proxy cuando corremos en Coolify
      httpAgent: new http.Agent({ family: 4, lookup: erpDnsLookup }),
      httpsAgent: new https.Agent({ family: 4, lookup: erpDnsLookup }),
    }),
  ],
  controllers: [ErpSyncController],
  providers: [ErpSyncService],
  exports: [ErpSyncService],
})
export class ErpSyncModule {}
