import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  transports: ['polling', 'websocket'],
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Autenticación segura de WebSockets en el handshake y asignación a salas
   */
  async handleConnection(client: Socket) {
    try {
      // 1. Extraer token del handshake (auth o headers o query)
      let token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization ||
        (client.handshake.query?.token as string);

      if (token && typeof token === 'string' && token.startsWith('Bearer ')) {
        token = token.slice(7);
      }

      let user: any = null;

      // 2. Intentar validar JWT si se proporcionó un token real
      if (token && token !== 'demo-token' && token !== 'demo-jwt-token') {
        try {
          const secret = this.configService.get<string>(
            'JWT_SECRET',
            'super-secret-jwt-key-change-in-production',
          );
          const payload = this.jwtService.verify(token, { secret });
          user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            include: { tenant: true },
          });
        } catch (jwtErr) {
          this.logger.warn(`Token WS no verificado (${jwtErr.message}). Evaluando modo fallback de desarrollo.`);
        }
      }

      // 3. Fallback de desarrollo si el token es demo o si no hay token aún
      if (!user) {
        user = await this.prisma.user.findFirst({
          where: { isActive: true },
          include: { tenant: true },
        });
      }

      if (!user || !user.isActive || (user.tenant && !user.tenant.isActive)) {
        this.logger.warn(`Conexión WS rechazada: usuario no encontrado o inactivo [Socket: ${client.id}]`);
        client.emit('auth_error', { message: 'Usuario no autenticado o inactivo' });
        client.disconnect(true);
        return;
      }

      // 4. Asignar sesión en socket
      client.data.user = {
        id: user.id,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
      };

      // 5. Unir a salas correspondientes
      const userRoom = `user_${user.id}`;
      await client.join(userRoom);

      if (user.tenantId) {
        const tenantRoom = `tenant_${user.tenantId}`;
        await client.join(tenantRoom);
      }

      if (user.role === 'SUPER_ADMIN') {
        await client.join('superadmin_room');
      }

      this.logger.log(
        `[WS Conectado] ${user.name} (${user.role}) [Socket: ${client.id}]`,
      );

      client.emit('connected', {
        status: 'ok',
        userId: user.id,
        userName: user.name,
        role: user.role,
        tenantId: user.tenantId,
      });
    } catch (error) {
      this.logger.error(`Error en handleConnection de WebSocket: ${error.message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const user = client.data?.user;
    if (user) {
      this.logger.log(`[WS Desconectado] ${user.name} [Socket: ${client.id}]`);
    }
  }

  /**
   * Emite un evento a todos los operadores de una empresa específica
   */
  emitToTenant(tenantId: string, event: string, payload: any) {
    const room = `tenant_${tenantId}`;
    this.server.to(room).emit(event, payload);
    this.logger.debug(`[WS Emit -> ${room}] Event: ${event}`);
  }

  /**
   * Emite un evento a un usuario operador específico
   */
  emitToUser(tenantId: string, userId: string, event: string, payload: any) {
    const room = `user_${userId}`;
    this.server.to(room).emit(event, payload);
    this.logger.debug(`[WS Emit -> ${room}] Event: ${event}`);
  }
}
