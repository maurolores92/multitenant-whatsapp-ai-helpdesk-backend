export interface SendMessageResult {
  whatsappMessageId: string;
  status: 'SENT' | 'FAILED';
  error?: string;
}

export interface IWhatsAppProvider {
  sendTextMessage(params: {
    tenantId: string;
    agentId?: string;
    to: string;
    text: string;
  }): Promise<SendMessageResult>;

  sendMediaMessage?(params: {
    tenantId: string;
    to: string;
    mediaUrl: string;
    caption?: string;
  }): Promise<SendMessageResult>;
}
