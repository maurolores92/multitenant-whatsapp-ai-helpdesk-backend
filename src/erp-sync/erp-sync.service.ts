import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ErpAuthType, Prisma } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../notifications/events.gateway';
import { UpdateErpConfigDto } from './dto/update-erp-config.dto';
import {
  joinErpUrl,
  mapErpCustomer,
  mapErpEquipment,
  mapErpProblem,
  normalizeClientCodeKey,
  unwrapErpCollection,
} from './erp-mapper.helper';

@Injectable()
export class ErpSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErpSyncService.name);
  private monthlySchedulerTimer: NodeJS.Timeout | null = null;
  private startupCheckTimer: NodeJS.Timeout | null = null;
  private readonly runningTenants = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  onModuleInit() {
    // Prueba inicial no bloqueante de conexión contra HelpCopies ERP para mostrar estado en consola
    void this.checkConnectionsOnStartup();

    // Verificación inicial al iniciar (si este mes aún no corrió el ETL) y luego cada 12 horas
    this.startupCheckTimer = setTimeout(() => {
      void this.runMonthlyAutoSyncIfDue();
    }, 60 * 1000);

    this.monthlySchedulerTimer = setInterval(() => {
      void this.runMonthlyAutoSyncIfDue();
    }, 12 * 60 * 60 * 1000);
  }

  private async checkConnectionsOnStartup() {
    try {
      const integrations = await this.prisma.erpIntegration.findMany({
        where: { isActive: true, baseUrl: { not: null } },
        include: { tenant: { select: { name: true } } },
      });

      if (integrations.length === 0) {
        this.logger.warn(
          '[HelpCopies ERP] No hay integraciones ERP activas configuradas; no se probará conexión automática al inicio.',
        );
        return;
      }

      for (const integration of integrations) {
        this.logger.log(
          `[HelpCopies ERP] Verificando conexión inicial para "${integration.tenant.name}" (${integration.baseUrl})...`,
        );
        try {
          await this.testConnection(integration.tenantId);
        } catch {
          // El detalle del fallo ya queda registrado en consola por testConnection
        }
      }
    } catch (error: any) {
      this.logger.error(
        `[HelpCopies ERP] ✖ Error al verificar integraciones ERP en el arranque: ${this.extractErpErrorMessage(error)}`,
      );
    }
  }

  onModuleDestroy() {
    if (this.startupCheckTimer) {
      clearTimeout(this.startupCheckTimer);
    }
    if (this.monthlySchedulerTimer) {
      clearInterval(this.monthlySchedulerTimer);
    }
  }

  private async runMonthlyAutoSyncIfDue() {
    const now = new Date();

    const integrations = await this.prisma.erpIntegration.findMany({
      where: { isActive: true, autoSyncMonthly: true, baseUrl: { not: null } },
    });

    for (const integration of integrations) {
      const syncedSameMonth =
        integration.lastSyncAt &&
        integration.lastSyncAt.getFullYear() === now.getFullYear() &&
        integration.lastSyncAt.getMonth() === now.getMonth();

      if (!syncedSameMonth && !this.runningTenants.has(integration.tenantId)) {
        this.logger.log(`[ETL Mensual] Ejecutando sincronización mensual (1 vez al mes) para tenant ${integration.tenantId}`);
        await this.syncTenantFromErp(integration.tenantId).catch((err) => {
          this.logger.error(`[ETL Mensual] Falló tenant ${integration.tenantId}: ${err.message}`);
        });
      }
    }
  }

  async getConfig(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Empresa no encontrada');

    const [integration, customersCount, equipmentsCount, problemsCount] = await Promise.all([
      this.prisma.erpIntegration.findUnique({ where: { tenantId } }),
      this.prisma.customer.count({ where: { tenantId } }),
      this.prisma.equipment.count({ where: { tenantId } }),
      this.prisma.problemType.count({ where: { tenantId, isActive: true } }),
    ]);

    return {
      config: integration
        ? {
          ...integration,
          hasApiKey: Boolean(integration.apiKey),
          apiKey: integration.apiKey ? '********' : '',
          hasPassword: Boolean(integration.password),
          password: integration.password ? '********' : '',
        }
        : {
          tenantId,
          baseUrl: 'https://api.helpcopies.com/api',
          authType: ErpAuthType.BEARER_TOKEN,
          apiKey: '',
          hasApiKey: false,
          apiKeyHeader: 'x-api-key',
          loginEndpoint: '/auth/login',
          username: '',
          password: '',
          hasPassword: false,
          customersEndpoint: '/clients',
          equipmentsEndpoint: '/machines',
          problemsEndpoint: '/problems',
          autoSyncMonthly: true,
          isActive: false,
          lastSyncAt: null,
          lastSyncStatus: null,
          lastSyncSummary: null,
        },
      stats: {
        customersCount,
        equipmentsCount,
        problemsCount,
      },
    };
  }

  async updateConfig(tenantId: string, dto: UpdateErpConfigDto, actorUserId: string) {
    const existing = await this.prisma.erpIntegration.findUnique({ where: { tenantId } });

    const data: Prisma.ErpIntegrationUncheckedUpdateInput = {
      ...(dto.baseUrl !== undefined ? { baseUrl: dto.baseUrl.trim() || null } : {}),
      ...(dto.authType !== undefined ? { authType: dto.authType } : {}),
      ...(dto.apiKey !== undefined && dto.apiKey !== '********' ? { apiKey: dto.apiKey.trim() || null } : {}),
      ...(dto.apiKeyHeader !== undefined ? { apiKeyHeader: dto.apiKeyHeader.trim() || 'x-api-key' } : {}),
      ...(dto.loginEndpoint !== undefined ? { loginEndpoint: dto.loginEndpoint.trim() || '/auth/login' } : {}),
      ...(dto.username !== undefined ? { username: dto.username.trim() || null } : {}),
      ...(dto.password !== undefined && dto.password !== '********' ? { password: dto.password.trim() || null } : {}),
      ...(dto.customersEndpoint !== undefined
        ? { customersEndpoint: dto.customersEndpoint.trim() || '/clients' }
        : {}),
      ...(dto.equipmentsEndpoint !== undefined
        ? { equipmentsEndpoint: dto.equipmentsEndpoint.trim() || '/machines' }
        : {}),
      ...(dto.problemsEndpoint !== undefined
        ? { problemsEndpoint: dto.problemsEndpoint.trim() || '/problems' }
        : {}),
      ...(dto.autoSyncMonthly !== undefined ? { autoSyncMonthly: dto.autoSyncMonthly } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    const saved = existing
      ? await this.prisma.erpIntegration.update({ where: { tenantId }, data })
      : await this.prisma.erpIntegration.create({
        data: {
          tenantId,
          baseUrl: dto.baseUrl?.trim() || 'https://api.helpcopies.com/api',
          authType: dto.authType || ErpAuthType.BEARER_TOKEN,
          apiKey: dto.apiKey && dto.apiKey !== '********' ? dto.apiKey.trim() : null,
          apiKeyHeader: dto.apiKeyHeader?.trim() || 'x-api-key',
          loginEndpoint: dto.loginEndpoint?.trim() || '/auth/login',
          username: dto.username?.trim() || null,
          password: dto.password && dto.password !== '********' ? dto.password.trim() : null,
          customersEndpoint: dto.customersEndpoint?.trim() || '/clients',
          equipmentsEndpoint: dto.equipmentsEndpoint?.trim() || '/machines',
          problemsEndpoint: dto.problemsEndpoint?.trim() || '/problems',
          autoSyncMonthly: dto.autoSyncMonthly ?? true,
          isActive: dto.isActive ?? false,
        },
      });

    await this.auditService.log({
      tenantId,
      userId: actorUserId,
      action: 'ERP_CONFIG_UPDATED',
      entity: 'ErpIntegration',
      entityId: saved.id,
      payload: {
        baseUrl: saved.baseUrl,
        authType: saved.authType,
        customersEndpoint: saved.customersEndpoint,
        equipmentsEndpoint: saved.equipmentsEndpoint,
        problemsEndpoint: saved.problemsEndpoint,
        autoSyncMonthly: saved.autoSyncMonthly,
        isActive: saved.isActive,
      },
    });

    this.logger.log(
      `[HelpCopies ERP] Configuración guardada para tenant ${tenantId} (URL: ${saved.baseUrl || 'N/A'}, Activa: ${saved.isActive})`,
    );

    return this.getConfig(tenantId);
  }

  private extractErpErrorMessage(error: any): string {
    const status = error?.response?.status;
    const rawMsg = error?.response?.data?.message;
    const msg = (Array.isArray(rawMsg) ? rawMsg.join(', ') : rawMsg) || error?.message || 'Error de conexión';
    return status ? `HTTP ${status}: ${msg}` : msg;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private reportSyncProgress(params: {
    tenantId?: string;
    stage:
      | 'auth'
      | 'fetch_customers'
      | 'fetch_equipments'
      | 'fetch_problems'
      | 'save_customers'
      | 'save_equipments'
      | 'save_problems'
      | 'completed'
      | 'error';
    level?: 'info' | 'success' | 'warn' | 'error';
    message: string;
    progress?: number;
  }) {
    const level = params.level || 'info';
    const logLine = `[HelpCopies ERP] ${params.message}`;
    if (level === 'error') {
      this.logger.error(logLine);
    } else if (level === 'warn') {
      this.logger.warn(logLine);
    } else {
      this.logger.log(logLine);
    }

    if (params.tenantId) {
      this.eventsGateway.emitToTenantAndSuperAdmins(params.tenantId, 'erp:sync_progress', {
        tenantId: params.tenantId,
        stage: params.stage,
        level,
        message: params.message,
        progress: params.progress,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Ejecuta una petición HTTP hacia HelpCopies ERP reintentando ante HTTP 429 (ThrottlerException).
   */
  private async requestWithRateLimitRetry<T>(
    label: string,
    fn: () => Promise<T>,
    maxRetries = 4,
    onRetryWarn?: (message: string) => void,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const status = error?.response?.status;
        if (status !== 429 || attempt === maxRetries) {
          throw error;
        }
        const retryAfterRaw =
          error?.response?.headers?.['retry-after'] ||
          error?.response?.headers?.['x-ratelimit-reset'];
        const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
        const defaultDelays = [3000, 6000, 10000, 15000];
        const waitMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 30000)
            : (defaultDelays[attempt] ?? 15000);
        const warnMsg = `Límite de peticiones (HTTP 429) en ${label}. Esperando ${Math.round(waitMs / 1000)}s para reintentar (${attempt + 1}/${maxRetries})...`;
        if (onRetryWarn) {
          onRetryWarn(warnMsg);
        } else {
          this.logger.warn(`[HelpCopies ERP] ${warnMsg}`);
        }
        await this.sleep(waitMs);
      }
    }
    throw new BadRequestException(`Se agotaron los reintentos para ${label}`);
  }

  async getProblems(tenantId: string) {
    return this.prisma.problemType.findMany({
      where: { tenantId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  private async buildHeaders(
    integration: {
      baseUrl: string | null;
      authType: ErpAuthType;
      apiKey: string | null;
      apiKeyHeader: string;
      loginEndpoint: string | null;
      username: string | null;
      password: string | null;
    },
    tenantId?: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!integration.baseUrl) {
      throw new BadRequestException('Debes configurar la URL base del backend HelpCopies ERP primero');
    }

    if (integration.authType === ErpAuthType.BEARER_TOKEN && integration.apiKey) {
      headers.Authorization = `Bearer ${integration.apiKey}`;
    } else if (integration.authType === ErpAuthType.API_KEY && integration.apiKey) {
      headers[integration.apiKeyHeader || 'x-api-key'] = integration.apiKey;
    } else if (integration.authType === ErpAuthType.LOGIN_CREDENTIALS) {
      if (!integration.username || !integration.password) {
        throw new BadRequestException('Faltan usuario o contraseña para autenticar contra HelpCopies ERP');
      }
      const loginUrl = joinErpUrl(integration.baseUrl, integration.loginEndpoint || '/auth/login');
      this.reportSyncProgress({
        tenantId,
        stage: 'auth',
        message: `Autenticando contra ${loginUrl}...`,
        progress: 5,
      });
      try {
        const authRes = await this.requestWithRateLimitRetry(
          `Login (${loginUrl})`,
          () =>
            firstValueFrom(
              this.httpService.post(loginUrl, {
                username: integration.username,
                password: integration.password,
              }),
            ),
          4,
          (warnMsg) =>
            this.reportSyncProgress({
              tenantId,
              stage: 'auth',
              level: 'warn',
              message: warnMsg,
              progress: 5,
            }),
        );
        const token =
          authRes.data?.access_token ||
          authRes.data?.accessToken ||
          authRes.data?.token ||
          authRes.data?.jwt ||
          authRes.data?.data?.access_token ||
          authRes.data?.data?.accessToken ||
          authRes.data?.data?.token;
        if (!token) {
          const erpMsg = authRes.data?.message ? ` (${authRes.data.message})` : '';
          this.reportSyncProgress({
            tenantId,
            stage: 'error',
            level: 'error',
            message: `✖ Login sin token válido en ${loginUrl}${erpMsg}`,
          });
          throw new BadRequestException(`El login de HelpCopies ERP no devolvió un token válido${erpMsg}`);
        }
        this.reportSyncProgress({
          tenantId,
          stage: 'auth',
          level: 'success',
          message: `✔ Autenticación exitosa contra HelpCopies ERP.`,
          progress: 10,
        });
        headers.Authorization = `Bearer ${token}`;
      } catch (error: any) {
        if (error instanceof BadRequestException) throw error;
        this.reportSyncProgress({
          tenantId,
          stage: 'error',
          level: 'error',
          message: `✖ Error de autenticación en ${loginUrl}: ${this.extractErpErrorMessage(error)}`,
        });
        throw error;
      }
    }

    return headers;
  }

  private async probeEndpoint(
    label: string,
    baseUrl: string,
    endpoint: string,
    headers: Record<string, string>,
  ) {
    const url = joinErpUrl(baseUrl, endpoint);
    try {
      const response = await this.requestWithRateLimitRetry(label, () =>
        firstValueFrom(this.httpService.get(url, { headers })),
      );
      const unwrapped = unwrapErpCollection(response.data);
      const detected = unwrapped.total ?? unwrapped.items.length;
      this.logger.log(`[HelpCopies ERP] ✔ ${label} conectado correctamente (${url}) -> ${detected} registros`);
      return { ok: true as const, detected, items: unwrapped.items, url };
    } catch (error: any) {
      const detail = this.extractErpErrorMessage(error);
      this.logger.error(`[HelpCopies ERP] ✖ Falló conexión a ${label} (${url}): ${detail}`);
      return { ok: false as const, detail, url };
    }
  }

  private async fetchCollection(
    label: string,
    baseUrl: string,
    endpoint: string,
    headers: Record<string, string>,
    paginateIfWrapped = false,
    progressMeta?: {
      tenantId: string;
      stage: 'fetch_customers' | 'fetch_equipments' | 'fetch_problems';
      startProgress: number;
      endProgress: number;
    },
  ): Promise<Record<string, any>[]> {
    const firstUrl = joinErpUrl(baseUrl, endpoint);
    const emit = (
      message: string,
      level: 'info' | 'success' | 'warn' | 'error' = 'info',
      progress?: number,
    ) => {
      if (progressMeta) {
        this.reportSyncProgress({
          tenantId: progressMeta.tenantId,
          stage: progressMeta.stage,
          level,
          message,
          progress,
        });
      } else if (level === 'error') {
        this.logger.error(`[HelpCopies ERP] ${message}`);
      } else if (level === 'warn') {
        this.logger.warn(`[HelpCopies ERP] ${message}`);
      } else {
        this.logger.log(`[HelpCopies ERP] ${message}`);
      }
    };

    try {
      emit(`Descargando ${label} desde ${firstUrl}...`, 'info', progressMeta?.startProgress);
      const firstRes = await this.requestWithRateLimitRetry(
        `${label} (pág. 1)`,
        () => firstValueFrom(this.httpService.get(firstUrl, { headers })),
        4,
        (warnMsg) => emit(warnMsg, 'warn', progressMeta?.startProgress),
      );
      const firstUnwrapped = unwrapErpCollection(firstRes.data);

      if (
        !paginateIfWrapped ||
        firstUnwrapped.total === null ||
        firstUnwrapped.items.length >= firstUnwrapped.total ||
        firstUnwrapped.items.length === 0
      ) {
        emit(
          `✔ ${label} descargados (${firstUnwrapped.items.length} registros).`,
          'success',
          progressMeta?.endProgress,
        );
        return firstUnwrapped.items;
      }

      // Si /clients viene paginado ({ data, total }), recorremos las páginas siguientes con pausa anti-throttling
      const collected = [...firstUnwrapped.items];
      const pageSize = firstUnwrapped.items.length;
      const totalPages = Math.min(Math.ceil(firstUnwrapped.total / pageSize), 100);
      const separator = firstUrl.includes('?') ? '&' : '?';

      emit(
        `${label}: página 1/${totalPages} (${collected.length}/${firstUnwrapped.total} registros)...`,
        'info',
        progressMeta
          ? Math.round(
              progressMeta.startProgress +
                ((progressMeta.endProgress - progressMeta.startProgress) * 1) / totalPages,
            )
          : undefined,
      );

      for (let page = 2; page <= totalPages; page++) {
        await this.sleep(350);
        const pageUrl = `${firstUrl}${separator}page=${page}&limit=${pageSize}`;
        const pageProgress = progressMeta
          ? Math.round(
              progressMeta.startProgress +
                ((progressMeta.endProgress - progressMeta.startProgress) * page) / totalPages,
            )
          : undefined;
        const pageRes = await this.requestWithRateLimitRetry(
          `${label} (pág. ${page}/${totalPages})`,
          () => firstValueFrom(this.httpService.get(pageUrl, { headers })),
          4,
          (warnMsg) => emit(warnMsg, 'warn', pageProgress),
        );
        const next = unwrapErpCollection(pageRes.data);
        if (next.items.length === 0) break;
        collected.push(...next.items);
        emit(
          `${label}: página ${page}/${totalPages} (${collected.length}/${firstUnwrapped.total} registros)...`,
          'info',
          pageProgress,
        );
        if (collected.length >= firstUnwrapped.total) break;
      }

      emit(
        `✔ ${label} descargados (${collected.length} registros).`,
        'success',
        progressMeta?.endProgress,
      );
      return collected;
    } catch (error: any) {
      const detail = this.extractErpErrorMessage(error);
      emit(`✖ No se pudieron obtener ${label} (${firstUrl}): ${detail}`, 'error');
      throw error;
    }
  }

  private async upsertCustomerRow(
    tenantId: string,
    rawRow: Record<string, any>,
    index: number,
    customerIdByCode: Map<string, string>,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const mapped = mapErpCustomer(rawRow, index);
    if (!mapped) return 'skipped';

    const codeKey = normalizeClientCodeKey(mapped.externalCode);

    let existing = await this.prisma.customer.findFirst({
      where: {
        tenantId,
        OR: [{ externalCode: mapped.externalCode }, { externalCode: codeKey }],
      },
    });
    if (!existing) {
      existing = await this.prisma.customer.findUnique({
        where: { tenantId_phone: { tenantId, phone: mapped.phone } },
      });
    }

    if (existing) {
      const updated = await this.prisma.customer.update({
        where: { id: existing.id },
        data: {
          externalCode: mapped.externalCode,
          name: mapped.name,
          companyName: mapped.companyName,
          email: mapped.email ?? existing.email,
          cuit: mapped.cuit ?? existing.cuit,
          address: mapped.address ?? existing.address,
          locality: mapped.locality ?? existing.locality,
          notes: mapped.notes ?? existing.notes,
        },
      });
      customerIdByCode.set(mapped.externalCode, updated.id);
      customerIdByCode.set(codeKey, updated.id);
      return 'updated';
    }

    const phoneCollision = await this.prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId, phone: mapped.phone } },
    });
    const safePhone = phoneCollision ? `${mapped.phone}-${mapped.externalCode}` : mapped.phone;

    const created = await this.prisma.customer.create({
      data: {
        tenantId,
        externalCode: mapped.externalCode,
        name: mapped.name,
        companyName: mapped.companyName,
        phone: safePhone,
        email: mapped.email,
        cuit: mapped.cuit,
        address: mapped.address,
        locality: mapped.locality,
        notes: mapped.notes,
      },
    });
    customerIdByCode.set(mapped.externalCode, created.id);
    customerIdByCode.set(codeKey, created.id);
    return 'created';
  }

  async testConnection(tenantId: string) {
    const integration = await this.prisma.erpIntegration.findUnique({ where: { tenantId } });
    if (!integration?.baseUrl) {
      this.logger.warn(
        `[HelpCopies ERP] ✖ Prueba de conexión abortada (tenant ${tenantId}): URL base no configurada`,
      );
      throw new BadRequestException('Configura y guarda la URL del backend HelpCopies ERP antes de probar');
    }

    this.logger.log(`[HelpCopies ERP] Probando conexión con ${integration.baseUrl} (tenant ${tenantId})...`);

    try {
      const headers = await this.buildHeaders(integration);
      const customersProbe = await this.probeEndpoint(
        'Clientes',
        integration.baseUrl,
        integration.customersEndpoint,
        headers,
      );
      await this.sleep(250);
      const equipmentsProbe = await this.probeEndpoint(
        'Equipos',
        integration.baseUrl,
        integration.equipmentsEndpoint,
        headers,
      );
      await this.sleep(250);
      const problemsProbe = await this.probeEndpoint(
        'Problemas',
        integration.baseUrl,
        integration.problemsEndpoint,
        headers,
      );

      const failed = [
        !customersProbe.ok ? `Clientes (${customersProbe.detail})` : null,
        !equipmentsProbe.ok ? `Equipos (${equipmentsProbe.detail})` : null,
        !problemsProbe.ok ? `Problemas (${problemsProbe.detail})` : null,
      ].filter(Boolean);

      if (failed.length > 0 || !customersProbe.ok || !equipmentsProbe.ok || !problemsProbe.ok) {
        throw new BadRequestException(`No se pudo conectar con HelpCopies ERP: ${failed.join(' | ')}`);
      }

      this.logger.log(
        `[HelpCopies ERP] ✔ Conexión exitosa para tenant ${tenantId} | Clientes: ${customersProbe.detected} | Equipos: ${equipmentsProbe.detected} | Problemas: ${problemsProbe.detected}`,
      );

      return {
        connected: true,
        customersDetected: customersProbe.detected,
        equipmentsDetected: equipmentsProbe.detected,
        problemsDetected: problemsProbe.detected,
        sampleKeys: {
          customer: customersProbe.items[0] ? Object.keys(customersProbe.items[0]).slice(0, 8) : [],
          equipment: equipmentsProbe.items[0] ? Object.keys(equipmentsProbe.items[0]).slice(0, 8) : [],
          problem: problemsProbe.items[0] ? Object.keys(problemsProbe.items[0]).slice(0, 8) : [],
        },
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      const detail = this.extractErpErrorMessage(error);
      this.logger.error(`[HelpCopies ERP] ✖ No se pudo conectar con HelpCopies ERP (${integration.baseUrl}): ${detail}`);
      throw new BadRequestException(`No se pudo conectar con HelpCopies ERP: ${detail}`);
    }
  }

  async syncTenantFromErp(tenantId: string, actorUserId?: string) {
    if (this.runningTenants.has(tenantId)) {
      throw new BadRequestException('Ya hay una sincronización ERP en curso para esta empresa');
    }

    const integration = await this.prisma.erpIntegration.findUnique({ where: { tenantId } });
    if (!integration?.baseUrl) {
      this.logger.warn(
        `[HelpCopies ERP] ✖ Sincronización abortada (tenant ${tenantId}): URL o endpoints no configurados`,
      );
      throw new BadRequestException('Configura la URL y endpoints de HelpCopies ERP antes de sincronizar');
    }

    this.runningTenants.add(tenantId);
    this.reportSyncProgress({
      tenantId,
      stage: 'auth',
      message: `Iniciando sincronización ERP desde ${integration.baseUrl}...`,
      progress: 2,
    });

    const summary = {
      customersCreated: 0,
      customersUpdated: 0,
      equipmentsCreated: 0,
      equipmentsUpdated: 0,
      equipmentsOrphan: 0,
      problemsCreated: 0,
      problemsUpdated: 0,
      errors: [] as string[],
    };

    try {
      const headers = await this.buildHeaders(integration, tenantId);
      const customersRaw = await this.fetchCollection(
        'Clientes',
        integration.baseUrl,
        integration.customersEndpoint,
        headers,
        true,
        { tenantId, stage: 'fetch_customers', startProgress: 12, endProgress: 35 },
      );
      await this.sleep(350);
      const equipmentsRaw = await this.fetchCollection(
        'Equipos',
        integration.baseUrl,
        integration.equipmentsEndpoint,
        headers,
        false,
        { tenantId, stage: 'fetch_equipments', startProgress: 36, endProgress: 48 },
      );
      await this.sleep(350);
      const problemsRaw = await this.fetchCollection(
        'Problemas',
        integration.baseUrl,
        integration.problemsEndpoint,
        headers,
        false,
        { tenantId, stage: 'fetch_problems', startProgress: 49, endProgress: 56 },
      );

      const customerIdByCode = new Map<string, string>();

      // 1. Sincronizar Clientes (/clients -> { data, total })
      this.reportSyncProgress({
        tenantId,
        stage: 'save_customers',
        message: `Guardando ${customersRaw.length} clientes en base de datos...`,
        progress: 58,
      });
      for (let i = 0; i < customersRaw.length; i++) {
        const res = await this.upsertCustomerRow(tenantId, customersRaw[i], i, customerIdByCode);
        if (res === 'created') summary.customersCreated++;
        else if (res === 'updated') summary.customersUpdated++;

        if ((i + 1) % 25 === 0 && i + 1 < customersRaw.length) {
          const pct = Math.round(58 + ((i + 1) / customersRaw.length) * 16);
          this.reportSyncProgress({
            tenantId,
            stage: 'save_customers',
            message: `Procesando clientes: ${i + 1}/${customersRaw.length}...`,
            progress: pct,
          });
        }
      }
      this.reportSyncProgress({
        tenantId,
        stage: 'save_customers',
        level: 'success',
        message: `✔ Clientes guardados: +${summary.customersCreated} nuevos, ${summary.customersUpdated} actualizados.`,
        progress: 75,
      });

      // 2. Sincronizar Máquinas (/machines -> array directo con codClient + model.brand + client)
      this.reportSyncProgress({
        tenantId,
        stage: 'save_equipments',
        message: `Guardando ${equipmentsRaw.length} equipos en base de datos...`,
        progress: 76,
      });
      for (let i = 0; i < equipmentsRaw.length; i++) {
        const mapped = mapErpEquipment(equipmentsRaw[i], i);
        if (!mapped) continue;

        const codeKey = normalizeClientCodeKey(mapped.clientCode);
        let customerId = customerIdByCode.get(mapped.clientCode) || customerIdByCode.get(codeKey);

        if (!customerId) {
          const fallbackCustomer = await this.prisma.customer.findFirst({
            where: {
              tenantId,
              OR: [{ externalCode: mapped.clientCode }, { externalCode: codeKey }],
            },
            select: { id: true },
          });
          customerId = fallbackCustomer?.id;
        }

        // Si la máquina trae el objeto `client` enriquecido desde Tango y no estaba guardado aún, lo sincronizamos
        if (!customerId && mapped.embeddedClient) {
          const res = await this.upsertCustomerRow(tenantId, mapped.embeddedClient, i, customerIdByCode);
          if (res === 'created') summary.customersCreated++;
          else if (res === 'updated') summary.customersUpdated++;
          customerId = customerIdByCode.get(mapped.clientCode) || customerIdByCode.get(codeKey);
        }

        if (!customerId) {
          summary.equipmentsOrphan++;
          continue;
        }

        const existingEq = await this.prisma.equipment.findFirst({
          where: {
            tenantId,
            OR: [
              { externalCode: mapped.externalCode },
              ...(mapped.serialNumber ? [{ serialNumber: mapped.serialNumber }] : []),
            ],
          },
        });

        if (existingEq) {
          await this.prisma.equipment.update({
            where: { id: existingEq.id },
            data: {
              customerId,
              externalCode: mapped.externalCode,
              clientCode: mapped.clientCode,
              name: mapped.name,
              brand: mapped.brand ?? existingEq.brand,
              model: mapped.model ?? existingEq.model,
              serialNumber: mapped.serialNumber ?? existingEq.serialNumber,
              status: mapped.status,
              notes: mapped.notes ?? existingEq.notes,
              specifications: mapped.specifications as Prisma.InputJsonValue,
            },
          });
          summary.equipmentsUpdated++;
        } else {
          await this.prisma.equipment.create({
            data: {
              tenantId,
              customerId,
              externalCode: mapped.externalCode,
              clientCode: mapped.clientCode,
              name: mapped.name,
              brand: mapped.brand,
              model: mapped.model,
              serialNumber: mapped.serialNumber,
              status: mapped.status,
              notes: mapped.notes,
              specifications: mapped.specifications as Prisma.InputJsonValue,
            },
          });
          summary.equipmentsCreated++;
        }

        if ((i + 1) % 25 === 0 && i + 1 < equipmentsRaw.length) {
          const pct = Math.round(76 + ((i + 1) / equipmentsRaw.length) * 14);
          this.reportSyncProgress({
            tenantId,
            stage: 'save_equipments',
            message: `Procesando equipos: ${i + 1}/${equipmentsRaw.length}...`,
            progress: pct,
          });
        }
      }
      this.reportSyncProgress({
        tenantId,
        stage: 'save_equipments',
        level: 'success',
        message: `✔ Equipos guardados: +${summary.equipmentsCreated} nuevos, ${summary.equipmentsUpdated} actualizados (${summary.equipmentsOrphan} sin cliente).`,
        progress: 91,
      });

      // 3. Sincronizar Catálogo de Problemas (/problems -> array directo con id, description, status)
      this.reportSyncProgress({
        tenantId,
        stage: 'save_problems',
        message: `Guardando ${problemsRaw.length} problemas en el catálogo...`,
        progress: 92,
      });
      for (const row of problemsRaw) {
        const mapped = mapErpProblem(row);
        if (!mapped) continue;

        const existingProblem = await this.prisma.problemType.findFirst({
          where: {
            tenantId,
            OR: [
              ...(mapped.externalCode ? [{ externalCode: mapped.externalCode }] : []),
              { name: mapped.name },
            ],
          },
        });

        if (existingProblem) {
          await this.prisma.problemType.update({
            where: { id: existingProblem.id },
            data: {
              externalCode: mapped.externalCode ?? existingProblem.externalCode,
              name: mapped.name,
              description: mapped.description ?? existingProblem.description,
              defaultReason: mapped.defaultReason,
              defaultServiceType: mapped.defaultServiceType,
              isActive: mapped.isActive,
            },
          });
          summary.problemsUpdated++;
        } else {
          await this.prisma.problemType.create({
            data: {
              tenantId,
              externalCode: mapped.externalCode,
              name: mapped.name,
              description: mapped.description,
              defaultReason: mapped.defaultReason,
              defaultServiceType: mapped.defaultServiceType,
              isActive: mapped.isActive,
            },
          });
          summary.problemsCreated++;
        }
      }

      await this.prisma.erpIntegration.update({
        where: { tenantId },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: summary.equipmentsOrphan > 0 ? 'PARTIAL' : 'SUCCESS',
          lastSyncSummary: summary as unknown as Prisma.InputJsonValue,
        },
      });

      await this.auditService.log({
        tenantId,
        userId: actorUserId,
        action: 'ERP_SYNC_COMPLETED',
        entity: 'ErpIntegration',
        entityId: integration.id,
        payload: summary,
      });

      await this.notificationsService.notify({
        tenantId,
        type: 'erp.sync_completed',
        title: 'Sincronización HelpCopies ERP completada',
        body: `Clientes: +${summary.customersCreated}/~${summary.customersUpdated} | Equipos: +${summary.equipmentsCreated}/~${summary.equipmentsUpdated} | Problemas: +${summary.problemsCreated}/~${summary.problemsUpdated}`,
        link: '/companies',
      });

      this.reportSyncProgress({
        tenantId,
        stage: 'completed',
        level: 'success',
        message: `✔ Sincronización completada | Clientes: +${summary.customersCreated}/~${summary.customersUpdated} | Equipos: +${summary.equipmentsCreated}/~${summary.equipmentsUpdated} (sin cliente: ${summary.equipmentsOrphan}) | Problemas: +${summary.problemsCreated}/~${summary.problemsUpdated}`,
        progress: 100,
      });

      return summary;
    } catch (error: any) {
      const detail = this.extractErpErrorMessage(error);
      summary.errors.push(detail);

      this.reportSyncProgress({
        tenantId,
        stage: 'error',
        level: 'error',
        message: `✖ Falló la sincronización ERP: ${detail}`,
      });

      await this.prisma.erpIntegration.update({
        where: { tenantId },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'FAILED',
          lastSyncSummary: summary as unknown as Prisma.InputJsonValue,
        },
      });

      throw new BadRequestException(`Fallo en la sincronización ERP: ${detail}`);
    } finally {
      this.runningTenants.delete(tenantId);
    }
  }
}
