import {
  AgentSnapshotReport,
  type AgentSnapshotState,
  NODE_AGENT_PREFIX,
  WingsBackupReport,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { NodeAgentIdentity } from "../node-agent/node-agent.repository";
import { NodeAgentTokenGuard } from "../node-agent/node-agent-token.guard";
import type { BackupReport } from "../remote/remote-backup.service";
import { SnapshotsService } from "./snapshots.service";

/** Un identifiant illisible ne le deviendra jamais : 400, définitif pour l'agent. */
const BACKUP_UUID = new ParseUUIDPipe({
  exceptionFactory: () => new BadRequestException("Identifiant mal formé : un UUID est attendu."),
});

interface AgentRequest {
  nodeAgent: NodeAgentIdentity;
}

/**
 * Routes des instantanés tirées par l'agent (ADR 0009, « Liaison avec le
 * panel »). Le node vient du jeton, jamais de l'URL ni du corps.
 */
@Controller(NODE_AGENT_PREFIX.replace(/^\//, ""))
@UseGuards(NodeAgentTokenGuard)
export class AgentSnapshotsController {
  constructor(@Inject(SnapshotsService) private readonly snapshots: SnapshotsService) {}

  @Get("snapshots")
  state(@Req() request: AgentRequest): Promise<AgentSnapshotState> {
    return this.snapshots.agentState(request.nodeAgent.nodeId);
  }

  @Post("snapshots/report")
  @HttpCode(204)
  async report(@Req() request: AgentRequest, @Body() body: unknown): Promise<void> {
    const parsed = AgentSnapshotReport.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Rapport d'instantanés invalide.");
    await this.snapshots.applyReport(request.nodeAgent.nodeId, parsed.data);
  }

  /**
   * Liens signés du dépôt S3 d'une archive tirée d'un instantané : la même
   * réponse que Wings reçoit sur `/api/remote/backups/:uuid`, et 404 quand
   * ce node n'a pas l'ordre d'archiver cette sauvegarde.
   */
  @Get("snapshots/backups/:backupId")
  async backupUploadUrls(
    @Req() request: AgentRequest,
    @Param("backupId", BACKUP_UUID) backupId: string,
    @Query("size") size?: string,
  ) {
    const parsed = Number.parseInt(size ?? "", 10);
    const urls = await this.snapshots.openArchiveUpload(
      request.nodeAgent.nodeId,
      backupId,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
    );
    if (!urls) throw new NotFoundException("Aucun stockage distant configuré.");
    return urls;
  }

  /** Compte rendu du dépôt, au contenu de celui de Wings. */
  @Post("snapshots/backups/:backupId")
  @HttpCode(204)
  async backupCompleted(
    @Req() request: AgentRequest,
    @Param("backupId", BACKUP_UUID) backupId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = WingsBackupReport.partial().safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("Compte rendu de sauvegarde invalide.");
    await this.snapshots.completeArchive(
      request.nodeAgent.nodeId,
      backupId,
      parsed.data as BackupReport,
    );
  }
}
