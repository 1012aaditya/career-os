import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard.js';
import {
  EvidenceService,
  FILTERABLE_SOURCE_TYPES,
  type EvidenceListView,
  type FilterableSourceType,
} from './evidence.service.js';

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

export class EvidenceQueryDto {
  /**
   * Narrow to one source.
   *
   * The only filter offered, and deliberately the only one. An Evidence
   * view wants "show me what GitHub said"; anything past that is a query
   * language, and a query language over somebody's career history is a
   * surface to design rather than one to grow by accident.
   */
  @IsOptional()
  @IsIn(FILTERABLE_SOURCE_TYPES)
  sourceType?: FilterableSourceType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/*
 * Evidence, read as evidence.
 *
 * The complement to /v1/career-graph, which returns evidence only through
 * the join tables - and therefore could never show GitHub evidence, which
 * creates no joins by design. This reads the rows directly.
 */
@Controller('evidence')
@UseGuards(AuthGuard)
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  /**
   * GET /v1/evidence
   *
   * Identity comes from the verified session and from nowhere else.
   * There is no userId parameter on this route, no userId field in the
   * query DTO, and no way to supply one - which is the same property the
   * security boundary spec enforces across every controller: isolation is
   * unreachable rather than merely checked.
   */
  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: EvidenceQueryDto,
  ): Promise<EvidenceListView> {
    const userId = request.user?.id;

    if (!userId) {
      /*
       * Belt and braces. AuthGuard has already rejected an unauthenticated
       * request, so this is unreachable in normal operation - but a guard
       * that stops being applied should produce a 401 rather than a query
       * scoped to `undefined`.
       */
      throw new UnauthorizedException('Authentication required');
    }

    return await this.evidence.listForUser(userId, {
      ...(query.sourceType !== undefined
        ? { sourceType: query.sourceType }
        : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  }
}
