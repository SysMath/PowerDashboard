import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { CloudflareProvider } from "./providers/cloudflare.provider";
import { DNS_PROVIDERS, type DnsProviders, SubdomainsService } from "./subdomains.service";

/**
 * Les sous-domaines des serveurs (PLAN §10.3).
 *
 * Module à part, comme la facturation : l'écran réseau du client, le
 * transfert, la suppression d'un serveur et l'essai de l'administration s'en
 * servent tous.
 */
@Module({
  providers: [
    databaseProvider,
    {
      provide: DNS_PROVIDERS,
      useFactory: (): DnsProviders => ({ cloudflare: new CloudflareProvider() }),
    },
    SubdomainsService,
  ],
  exports: [SubdomainsService],
})
export class DnsModule {}
