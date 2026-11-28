import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Res,
  HttpStatus,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { ensureDefaultTechnicalAgent } from '../agents/agents.helper';
import { MetaCloudApiService } from './providers/meta-cloud-api.service';

@Controller('whatsapp/webhook')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly metaCloudApiService: MetaCloudApiService,
  ) {}

  /**
   * Endpoint de Verificación oficial requerido por Meta Graph API
   * GET /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=xxx&hub.challenge=yyy
   */
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const expectedToken = this.configService.get<string>(
      'META_WEBHOOK_VERIFY_TOKEN',
      'meta_webhook_verify_token_whatsapp_crm',
    );

    if (mode === 'subscribe' && token === expectedToken) {
      this.logger.log('✔ Handshake de verificación de Meta Webhook exitoso.');
      return res.status(HttpStatus.OK).send(challenge);
    }

    this.logger.warn(`Intento de verificación de webhook no autorizado. Token recibido: ${token}`);
    throw new ForbiddenException('Verificación de webhook fallida: token no coincide');
  }

  /**
   * Endpoint receptor de mensajes y eventos de Meta WhatsApp Business Cloud API
   * POST /api/whatsapp/webhook
   */
  @Post()
  async handleWebhookEvent(@Body() body: any, @Res() res: Response) {
    try {
      if (body?.object !== 'whatsapp_business_account') {
        return res.status(HttpStatus.OK).send('EVENT_RECEIVED');
      }

      const entries = body.entry ?? [];

      for (const entry of entries) {
        const changes = entry.changes ?? [];

        for (const change of changes) {
          const value = change.value;
          if (!value || value.messaging_product !== 'whatsapp') continue;

          const phoneNumberId = value.metadata?.phone_number_id;
          if (!phoneNumberId) continue;

          // 1. Identificar el Agente/Teléfono específico y su empresa (HelpCopies SRL)
          let agent = await this.prisma.whatsAppAgent.findUnique({
            where: { whatsappPhoneNumberId: phoneNumberId },
            include: { tenant: true },
          });

          let tenant = agent?.tenant ?? null;

          // Fallback por compatibilidad si aún estaba guardado solo en Tenant o modo pruebas
          if (!tenant) {
            tenant =
              (await this.prisma.tenant.findUnique({
                where: { whatsappPhoneNumberId: phoneNumberId },
              })) ??
              (await this.prisma.tenant.findFirst({
                where: { isActive: true },
                orderBy: { createdAt: 'asc' },
              }));

            if (tenant) {
              const ensured = await ensureDefaultTechnicalAgent(this.prisma, tenant.id);
              if (ensured) {
                agent = { ...ensured, tenant };
              }
            }
          }

          if (!tenant || !tenant.isActive) {
            this.logger.warn(
              `Webhook recibido para Phone Number ID ${phoneNumberId}, pero no hay empresa activa vinculada.`,
            );
            continue;
          }

          if (agent && !agent.isActive) {
            this.logger.warn(
              `Webhook recibido para el agente inactivo '${agent.name}' (${phoneNumberId}). Mensaje ignorado.`,
            );
            continue;
          }

          // 2. Procesar mensajes entrantes (texto e imágenes)
          const messages = value.messages ?? [];
          const contacts = value.contacts ?? [];

          for (const msg of messages) {
            const fromPhone = msg.from;
            const whatsappMessageId = msg.id;
            const customerName = contacts.find((c: any) => c.wa_id === fromPhone)?.profile?.name;

            if (!fromPhone) continue;

            if (msg.type === 'text') {
              const text = msg.text?.body;
              if (text) {
                await this.chatService.handleIncomingCustomerMessage({
                  tenantId: tenant.id,
                  agentId: agent?.id,
                  fromPhone,
                  customerName,
                  text,
                  whatsappMessageId,
                });
              }
              continue;
            }

            if (msg.type === 'image') {
              const mediaId = msg.image?.id;
              const caption = msg.image?.caption?.trim();
              const downloaded = mediaId
                ? await this.metaCloudApiService.downloadMedia({
                    tenantId: tenant.id,
                    agentId: agent?.id,
                    mediaId,
                    fallbackMimeType: msg.image?.mime_type || 'image/jpeg',
                  })
                : null;

              await this.chatService.handleIncomingCustomerMessage({
                tenantId: tenant.id,
                agentId: agent?.id,
                fromPhone,
                customerName,
                text: caption || '[Imagen enviada por el cliente]',
                whatsappMessageId,
                mediaUrl: downloaded?.dataUrl,
                mediaType: downloaded?.mimeType || msg.image?.mime_type || 'image/jpeg',
              });
              continue;
            }

            this.logger.log(`Mensaje de tipo no soportado por ahora (${msg.type}) de ${msg.from}`);
          }
        }
      }

      // Meta requiere respuesta 200 OK inmediata
      return res.status(HttpStatus.OK).send('EVENT_RECEIVED');
    } catch (error) {
      this.logger.error(`Error procesando webhook de Meta: ${error.message}`, error.stack);
      // Siempre retornamos 200 a Meta para evitar retries infinitos
      return res.status(HttpStatus.OK).send('EVENT_RECEIVED');
    }
  }
}
