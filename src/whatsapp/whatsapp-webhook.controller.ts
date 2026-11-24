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

@Controller('whatsapp/webhook')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
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

          // 1. Identificar la empresa (Tenant) correspondiente al número receptor
          let tenant = await this.prisma.tenant.findUnique({
            where: { whatsappPhoneNumberId: phoneNumberId },
          });

          // Si es un entorno de pruebas o desarrollo, usar el primer tenant activo si no está asignado
          if (!tenant) {
            tenant = await this.prisma.tenant.findFirst({
              where: { isActive: true },
            });
          }

          if (!tenant) {
            this.logger.warn(
              `Webhook recibido para Phone Number ID ${phoneNumberId}, pero no hay empresa vinculada.`,
            );
            continue;
          }

          // 2. Procesar mensajes de texto entrantes
          const messages = value.messages ?? [];
          const contacts = value.contacts ?? [];

          for (const msg of messages) {
            if (msg.type !== 'text') {
              this.logger.log(`Mensaje de tipo no soportado por ahora (${msg.type}) de ${msg.from}`);
              continue;
            }

            const fromPhone = msg.from;
            const text = msg.text?.body;
            const whatsappMessageId = msg.id;
            const customerName = contacts.find((c: any) => c.wa_id === fromPhone)?.profile?.name;

            if (text && fromPhone) {
              await this.chatService.handleIncomingCustomerMessage({
                tenantId: tenant.id,
                fromPhone,
                customerName,
                text,
                whatsappMessageId,
              });
            }
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
