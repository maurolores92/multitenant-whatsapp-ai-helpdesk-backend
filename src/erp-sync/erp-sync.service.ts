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

  async getProblems(tenantId: string) {
    return this.prisma.problemType.findMany({
      where: { tenantId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  private async buildHeaders(integration: {
    baseUrl: string | null;
    authType: ErpAuthType;
    apiKey: string | null;
    apiKeyHeader: string;
    loginEndpoint: string | null;
    username: string | null;
    password: string | null;
  }): Promise<Record<string, string>> {
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
      try {
        const authRes = await firstValueFrom(
          this.httpService.post(loginUrl, {
            username: integration.username,
            password: integration.password,
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
          this.logger.error(`[HelpCopies ERP] ✖ Login sin token válido en ${loginUrl}`);
          throw new BadRequestException('El login de HelpCopies ERP no devolvió un token válido');
        }
        this.logger.log(`[HelpCopies ERP] ✔ Autenticación exitosa contra ${loginUrl}`);
        headers.Authorization = `Bearer ${token}`;
      } catch (error: any) {
        if (error instanceof BadRequestException) throw error;
        this.logger.error(
          `[HelpCopies ERP] ✖ Error de autenticación en ${loginUrl}: ${this.extractErpErrorMessage(error)}`,
        );
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
      const response = await firstValueFrom(this.httpService.get(url, { headers }));
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
  ): Promise<Record<string, any>[]> {
    const firstUrl = joinErpUrl(baseUrl, endpoint);
    try {
      const firstRes = await firstValueFrom(this.httpService.get(firstUrl, { headers }));
      const firstUnwrapped = unwrapErpCollection(firstRes.data);

      if (
        !paginateIfWrapped ||
        firstUnwrapped.total === null ||
        firstUnwrapped.items.length >= firstUnwrapped.total ||
        firstUnwrapped.items.length === 0
      ) {
        this.logger.log(
          `[HelpCopies ERP] ✔ ${label} obtenidos (${firstUrl}) -> ${firstUnwrapped.items.length} registros`,
        );
        return firstUnwrapped.items;
      }

      // Si /clients viene paginado ({ data, total }), recorremos las páginas siguientes
      const collected = [...firstUnwrapped.items];
      const pageSize = firstUnwrapped.items.length;
      const totalPages = Math.ceil(firstUnwrapped.total / pageSize);
      const separator = firstUrl.includes('?') ? '&' : '?';

      for (let page = 2; page <= Math.min(totalPages, 100); page++) {
        const pageUrl = `${firstUrl}${separator}page=${page}&limit=${pageSize}`;
        const pageRes = await firstValueFrom(this.httpService.get(pageUrl, { headers }));
        const next = unwrapErpCollection(pageRes.data);
        if (next.items.length === 0) break;
        collected.push(...next.items);
        if (collected.length >= firstUnwrapped.total) break;
      }

      this.logger.log(
        `[HelpCopies ERP] ✔ ${label} obtenidos (${firstUrl}) -> ${collected.length} registros`,
      );
      return collected;
    } catch (error: any) {
      const detail = this.extractErpErrorMessage(error);
      this.logger.error(`[HelpCopies ERP] ✖ No se pudieron obtener ${label} (${firstUrl}): ${detail}`);
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
      const [customersProbe, equipmentsProbe, problemsProbe] = await Promise.all([
        this.probeEndpoint('Clientes', integration.baseUrl, integration.customersEndpoint, headers),
        this.probeEndpoint('Equipos', integration.baseUrl, integration.equipmentsEndpoint, headers),
        this.probeEndpoint('Problemas', integration.baseUrl, integration.problemsEndpoint, headers),
      ]);

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
    this.logger.log(
      `[HelpCopies ERP] Iniciando sincronización (Clientes, Equipos, Problemas) desde ${integration.baseUrl} para tenant ${tenantId}...`,
    );

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
      const headers = await this.buildHeaders(integration);
      const [customersRaw, equipmentsRaw, problemsRaw] = await Promise.all([
        this.fetchCollection('Clientes', integration.baseUrl, integration.customersEndpoint, headers, true),
        this.fetchCollection('Equipos', integration.baseUrl, integration.equipmentsEndpoint, headers, false),
        this.fetchCollection('Problemas', integration.baseUrl, integration.problemsEndpoint, headers, false),
      ]);

      const customerIdByCode = new Map<string, string>();

      // 1. Sincronizar Clientes (/clients -> { data, total })
      for (let i = 0; i < customersRaw.length; i++) {
        const res = await this.upsertCustomerRow(tenantId, customersRaw[i], i, customerIdByCode);
        if (res === 'created') summary.customersCreated++;
        else if (res === 'updated') summary.customersUpdated++;
      }

      // 2. Sincronizar Máquinas (/machines -> array directo con codClient + model.brand + client)
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
      }

      // 3. Sincronizar Catálogo de Problemas (/problems -> array directo con id, description, status)
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

      this.logger.log(
        `[HelpCopies ERP] ✔ Sincronización completada para tenant ${tenantId} | Clientes: +${summary.customersCreated}/~${summary.customersUpdated} | Equipos: +${summary.equipmentsCreated}/~${summary.equipmentsUpdated} (huérfanos: ${summary.equipmentsOrphan}) | Problemas: +${summary.problemsCreated}/~${summary.problemsUpdated}`,
      );

      return summary;
    } catch (error: any) {
      const detail = this.extractErpErrorMessage(error);
      summary.errors.push(detail);

      this.logger.error(`[HelpCopies ERP] ✖ Falló la sincronización para tenant ${tenantId}: ${detail}`);

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
