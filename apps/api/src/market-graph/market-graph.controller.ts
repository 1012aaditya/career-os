import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard.js';
import { MarketGraphService } from './market-graph.service.js';

/*
 * The Market Graph read API.
 *
 * READ ONLY, and that is a decision rather than an omission. Ingestion and
 * signal computation are long, network-bound, and must not be triggerable
 * by an HTTP request from a phone; they run from a script against the same
 * services (see scripts/market-graph.mts). Keeping them off the router
 * also means there is no write path here to authorise, rate-limit or
 * accidentally leave open.
 *
 * Every route is authenticated even though the market is not user-specific
 * - none of this is public data we are entitled to redistribute freely,
 * and the licence position on the underlying source is explicitly
 * unresolved. Authentication is the cheapest way to keep "who can see
 * this" a decision we still get to make.
 *
 * No route takes a user id, and none exists for opportunities, matches,
 * recommendations or fit. A test asserts the complete route list, so
 * adding one is a deliberate act somebody has to make on purpose.
 *
 * The guard is class-level: unlike the GitHub controller, nothing here is
 * deliberately public, so an escape hatch would express something untrue.
 */
@Controller('market')
@UseGuards(AuthGuard)
export class MarketGraphController {
  constructor(private readonly marketGraph: MarketGraphService) {}

  @Get('sources')
  listSources() {
    return this.marketGraph.listSources();
  }

  @Get('roles')
  listRoles(@Query('limit') limit?: string) {
    return this.marketGraph.listRoles(parseLimit(limit));
  }

  @Get('skills')
  listSkills(@Query('limit') limit?: string) {
    return this.marketGraph.listSkills(parseLimit(limit));
  }

  @Get('snapshot')
  latestSnapshot() {
    return this.marketGraph.latestSnapshot();
  }

  @Get('roles/:slug/skills')
  roleSkills(@Param('slug') slug: string, @Query('limit') limit?: string) {
    return this.marketGraph.roleSkills(slug, parseLimit(limit));
  }

  @Get('signals')
  roleVolumes(@Query('limit') limit?: string) {
    return this.marketGraph.roleVolumes(parseLimit(limit));
  }

  @Get('signals/:id')
  explainSignal(@Param('id') id: string) {
    /*
     * The clock is read here, at the request edge, and threaded down as
     * an explicit instant. Read inside the service it would be read more
     * than once per response, and two postings in one body would then
     * carry verdicts taken against different instants.
     */
    return this.marketGraph.explainSignal(id, new Date());
  }

  @Get('unresolved-titles')
  unresolvedTitles(@Query('limit') limit?: string) {
    return this.marketGraph.unresolvedTitles(parseLimit(limit));
  }
}

/*
 * Validated by hand rather than through a DTO, matching the GitHub
 * controller. The global pipe runs forbidNonWhitelisted, and a validated
 * DTO would answer an unexpected query parameter with a 400 - which is the
 * right answer for a body and the wrong one for an optional page size.
 */
function parseLimit(raw?: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }

  return value;
}
