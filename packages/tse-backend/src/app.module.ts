import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TypeOrmConfigService } from './common/config/typeorm-config.service';
import { IntegrationsModule } from './integrations/integrations.module';
import { ExchangeRegistryModule } from './modules/exchange-registry/exchange-registry.module';
import { ExchangeRegistryService } from './modules/exchange-registry/exchange-registry.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const typeOrmConfigService = new TypeOrmConfigService(configService);
        return typeOrmConfigService.getTypeOrmConfig();
      },
    }),
    IntegrationsModule,
    ExchangeRegistryModule,
  ],
  controllers: [],
  providers: [
    {
      provide: 'EXCHANGE_REGISTRY_INITIALIZATION',
      useFactory: async (service: ExchangeRegistryService) => {
        await service.initializeExchanges();
      },
      inject: [ExchangeRegistryService],
    },
  ],
})
export class AppModule {}
