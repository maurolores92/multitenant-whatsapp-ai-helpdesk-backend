import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { PERMISSIONS } from '../auth/constants/permissions.constant';
import { ConversationStatus } from '@prisma/client';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * Obtener todas las conversaciones de la empresa con filtros opcionales por estado
   */
  @RequirePermissions(PERMISSIONS.READ_CHATS)
  @Get('conversations')
  async getConversations(
    @CurrentTenant() tenantId: string,
    @Query('status') status?: ConversationStatus,
  ) {
    return this.chatService.getConversations(tenantId, status);
  }

  /**
   * Obtener el historial de mensajes de un chat específico
   */
  @RequirePermissions(PERMISSIONS.READ_CHATS)
  @Get('conversations/:id/messages')
  async getConversationMessages(
    @CurrentTenant() tenantId: string,
    @Param('id') conversationId: string,
    @Query('limit') limit?: number,
  ) {
    return this.chatService.getConversationMessages(
      tenantId,
      conversationId,
      limit ? Number(limit) : 100,
    );
  }

  /**
   * Enviar mensaje oficial por WhatsApp como operador humano
   * (Queda asentado qué usuario envió el mensaje)
   */
  @RequirePermissions(PERMISSIONS.SEND_CHAT_MESSAGE)
  @Post('conversations/:id/messages')
  async sendAgentMessage(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
    @Body() dto: SendChatMessageDto,
  ) {
    return this.chatService.sendAgentMessage({
      tenantId,
      conversationId,
      userId,
      text: dto.content,
    });
  }

  /**
   * Reasignar la conversación a otro técnico o agente
   */
  @RequirePermissions(PERMISSIONS.ASSIGN_CONVERSATION)
  @Patch('conversations/:id/assign')
  async assignConversation(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @Param('id') conversationId: string,
    @Body('targetUserId') targetUserId: string,
  ) {
    return this.chatService.assignConversation(
      tenantId,
      conversationId,
      targetUserId,
      actorUserId,
    );
  }

  /**
   * Marcar la conversación como resuelta
   */
  @RequirePermissions(PERMISSIONS.RESOLVE_CONVERSATION)
  @Patch('conversations/:id/resolve')
  async resolveConversation(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @Param('id') conversationId: string,
  ) {
    return this.chatService.resolveConversation(
      tenantId,
      conversationId,
      actorUserId,
    );
  }

  /**
   * Tomar la conversación por el operador autenticado (silencia el bot)
   */
  @RequirePermissions(PERMISSIONS.SEND_CHAT_MESSAGE)
  @Patch('conversations/:id/take-over')
  async takeOverConversation(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    return this.chatService.takeOverConversation(tenantId, conversationId, userId);
  }

  /**
   * Devolver la conversación a la IA (reactiva el bot)
   */
  @RequirePermissions(PERMISSIONS.SEND_CHAT_MESSAGE)
  @Patch('conversations/:id/release-to-bot')
  async releaseConversationToBot(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') conversationId: string,
  ) {
    return this.chatService.releaseConversationToBot(tenantId, conversationId, userId);
  }
}
