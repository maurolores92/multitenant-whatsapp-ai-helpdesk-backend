import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  app.setGlobalPrefix('api');

  const port = process.env.PORT;
  if (!port) {
    throw new Error('La variable de entorno PORT es obligatoria y no está configurada en .env');
  }
  await app.listen(port);
  console.log(`Backend server running on port: ${port}`);
}
bootstrap();

