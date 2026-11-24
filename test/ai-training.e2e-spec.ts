import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('AiTraining (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superadminToken: string;
  let tenantAdminToken: string;
  let tenantId: string;
  let createdRuleId: string;
  let createdKnowledgeId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);

    // Get tenant HelpCopies SRL
    const tenant = await prisma.tenant.findUnique({
      where: { slug: 'helpcopies' },
    });
    if (!tenant) throw new Error('Tenant helpcopies no encontrado');
    tenantId = tenant.id;

    // Login as Superadmin
    const superRes = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'superadmin@admin.com', password: 'password123' })
      .expect(200);
    superadminToken = superRes.body.accessToken;

    // Login as Tenant Admin
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@helpcopies.com', password: 'password123' })
      .expect(200);
    tenantAdminToken = adminRes.body.accessToken;
  }, 30000);

  afterAll(async () => {
    // Cleanup created test items
    if (createdRuleId) {
      await prisma.aiRule.deleteMany({ where: { id: createdRuleId } });
    }
    if (createdKnowledgeId) {
      await prisma.aiKnowledgeItem.deleteMany({ where: { id: createdKnowledgeId } });
    }
    await app.close();
  });

  describe('Superadmin Access (Authorized)', () => {
    it('GET /api/tenants/:id/ai-training/config should return AI config', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tenants/${tenantId}/ai-training/config`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('geminiModel');
      expect(res.body).toHaveProperty('aiTemperature');
      expect(res.body).toHaveProperty('aiEnabled');
    });

    it('PATCH /api/tenants/:id/ai-training/config should update AI config', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/tenants/${tenantId}/ai-training/config`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send({
          geminiModel: 'gemini-2.0-flash',
          aiTemperature: 0.3,
          aiSystemPrompt: 'Asistente técnico oficial HelpCopies SRL',
        })
        .expect(200);

      expect(res.body.aiTemperature).toBe(0.3);
      expect(res.body.geminiModel).toBe('gemini-2.0-flash');
    });

    it('POST /api/tenants/:id/ai-training/rules should create a new AI Rule', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tenants/${tenantId}/ai-training/rules`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send({
          title: 'Regla de Prueba E2E',
          instruction: 'No cotizar insumos sin número de serie',
          category: 'RESTRICTION',
          priority: 1,
        })
        .expect(201);

      expect(res.body).toHaveProperty('id');
      expect(res.body.title).toBe('Regla de Prueba E2E');
      expect(res.body.category).toBe('RESTRICTION');
      createdRuleId = res.body.id;
    });

    it('GET /api/tenants/:id/ai-training/rules should list AI Rules', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tenants/${tenantId}/ai-training/rules`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const found = res.body.find((r: any) => r.id === createdRuleId);
      expect(found).toBeDefined();
    });

    it('POST /api/tenants/:id/ai-training/knowledge should create Knowledge item', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tenants/${tenantId}/ai-training/knowledge`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send({
          question: '¿Cómo reiniciar el equipo ante error E-402?',
          answer: 'Presionar el botón de encendido por 10 segundos y revisar bandeja 2.',
          tags: ['reinicio', 'e-402'],
        })
        .expect(201);

      expect(res.body).toHaveProperty('id');
      expect(res.body.question).toContain('E-402');
      createdKnowledgeId = res.body.id;
    });

    it('GET /api/tenants/:id/ai-training/knowledge should list Knowledge items', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tenants/${tenantId}/ai-training/knowledge`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const found = res.body.find((k: any) => k.id === createdKnowledgeId);
      expect(found).toBeDefined();
    });

    it('POST /api/tenants/:id/ai-training/simulate should run simulator', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tenants/${tenantId}/ai-training/simulate`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send({ message: 'Tengo un error E-402 en mi máquina' })
        .expect(201);

      expect(res.body).toHaveProperty('response');
      expect(res.body).toHaveProperty('rulesCount');
      expect(res.body.rulesCount).toBeGreaterThanOrEqual(1);
    }, 20000);
  });

  describe('Tenant Admin Access (Strictly Forbidden / 403)', () => {
    it('GET /api/tenants/:id/ai-training/config should return 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get(`/api/tenants/${tenantId}/ai-training/config`)
        .set('Authorization', `Bearer ${tenantAdminToken}`)
        .expect(403);
    });

    it('POST /api/tenants/:id/ai-training/rules should return 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .post(`/api/tenants/${tenantId}/ai-training/rules`)
        .set('Authorization', `Bearer ${tenantAdminToken}`)
        .send({
          title: 'Regla no autorizada',
          instruction: 'Intento de creación por admin de cliente',
          category: 'BUSINESS',
          priority: 1,
        })
        .expect(403);
    });

    it('POST /api/tenants/:id/ai-training/simulate should return 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .post(`/api/tenants/${tenantId}/ai-training/simulate`)
        .set('Authorization', `Bearer ${tenantAdminToken}`)
        .send({ message: 'Intento de simulación' })
        .expect(403);
    });
  });
});
